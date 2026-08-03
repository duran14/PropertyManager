# Modelo primero para el asistente de rentas

## Objetivo

Convertir el bot de Telegram de un formulario secuencial a un asistente que entiende lenguaje natural, conserva el contexto y corrige información previamente recogida. El usuario podrá expresar varios requisitos en un mensaje, cambiar de opinión o corregirse sin tener que volver al paso que el sistema esperaba.

El sistema seguirá siendo estricto con inventario, horarios y cambios externos. El modelo interpreta la conversación; los servicios deterministas son la autoridad para datos operativos y acciones irreversibles.

## Decisiones

- El modelo interpreta todos los turnos de una conversación de renta, salvo `/start` y respuestas de selección de horario inequívocas.
- Ante incertidumbre, el modelo hace una única pregunta breve de aclaración. No inventa una ciudad, un nombre, una mascota ni otro dato de perfil.
- El modelo no ejecuta operaciones. Sólo devuelve una propuesta estructurada; el backend valida y ejecuta búsquedas, shortlists y reservas.
- Los datos ya recogidos no son inmutables. Cada turno puede establecer, corregir o borrar valores explícitamente.
- La reserva de una visita conserva la confirmación explícita del usuario: el modelo puede pedir horarios, pero el backend sólo agenda una selección de horario válida para una unidad seleccionada.

## Arquitectura

Se sustituirá el uso prioritario de `buildFastQualificationTurn` por un orquestador de turnos. El actual `chatbot.service.ts` se dividirá en límites claros.

### 1. Contexto de conversación

`ConversationContextBuilder` compone un contexto compacto para el modelo:

- últimos mensajes relevantes;
- perfil persistido del prospecto;
- preferencias y datos de búsqueda actuales;
- unidad y shortlist activas;
- estado operativo de una reserva pendiente;
- inventario disponible, limitado a los campos que el usuario puede ver;
- conocimiento del tenant.

El estado de UI existente deja de decidir qué texto se puede interpretar. Se mantiene sólo como resumen operativo y compatibilidad de vistas existentes.

### 2. Intérprete semántico

`ConversationInterpreter` llama al modelo con una respuesta JSON tipada. Su resultado, `ConversationTurn`, tendrá:

```ts
type ConversationTurn = {
  reply: string;
  intent: 'discover' | 'compare' | 'select_unit' | 'request_tour' | 'choose_slot' | 'handoff' | 'other';
  confidence: 'high' | 'low';
  clarification?: { question: string; field?: string };
  profile: { set: Partial<RentalProfile>; clear: RentalProfileField[] };
  selection?: { unitIds?: string[]; slotIndex?: number };
};
```

`RentalProfile` contiene nombre, propósito, área, provincia, dormitorios, mascotas, presupuesto, ocupantes y fecha de mudanza. Los valores deben estar normalizados y sólo se aceptan campos definidos por el esquema.

El prompt incluirá instrucciones explícitas: reconocer correcciones como “sorry Carlos” y “no, my name is Carlos”; conservar datos no contradichos; usar el inventario proporcionado; y preguntar brevemente cuando dos interpretaciones sean razonables.

### 3. Validador y aplicador de contexto

`ConversationContextApplier` valida el resultado sin intentar reinterpretar lenguaje natural:

- limpia y normaliza campos aceptados;
- aplica `clear` antes de `set`;
- rechaza valores fuera de dominio, por ejemplo mascotas inválidas;
- evita que el modelo introduzca IDs de unidades u horarios inexistentes;
- persiste los cambios en `conversation_slots`, `Lead` y `ChatConversation` dentro de una transacción.

Si la respuesta del modelo no pasa validación o no puede parsearse, el bot responde con una aclaración breve y conserva el contexto anterior. No vuelve al formulario rígido.

### 4. Orquestador de acciones

`ConversationActionOrchestrator` decide acciones a partir del turno validado y del estado real:

1. Para `discover` o cambios de perfil, consulta y clasifica el inventario real.
2. Para `select_unit`, verifica que la unidad pertenece a la shortlist o al inventario mostrado y actualiza la selección.
3. Para `request_tour`, exige una unidad seleccionada y obtiene horarios desde ShowMojo.
4. Para `choose_slot`, exige una lista de horarios pendiente, un índice válido y una confirmación semántica de intención de reserva; después llama a `scheduleTour`.
5. Para `handoff`, crea el evento correspondiente sin cambiar una reserva.

La prevención de duplicados, las transacciones y las notificaciones de `scheduling.service.ts` permanecen como están. El modelo nunca envía una reserva a ShowMojo directamente.

## Flujo de datos

1. Entra un mensaje de Telegram y se serializa por conversación.
2. Se construye `ConversationContext` desde la base de datos y el mensaje.
3. El modelo devuelve `ConversationTurn` estructurado.
4. El aplicador valida y persiste la actualización de perfil.
5. El orquestador ejecuta, si procede, una acción con datos reales.
6. Se guarda y entrega la respuesta final, junto con una auditoría de intención, cambios aceptados y acción realizada.

La respuesta entregada procede del modelo cuando no hay acción operativa que modificar. Para recomendaciones, horarios y confirmaciones, el backend compone el contenido factual desde los resultados reales y el modelo sólo puede proporcionar una introducción breve.

## Manejo de errores y confianza

- Confianza baja, campo ambiguo o contradicción: se entrega `clarification.question` y no se muta ese campo.
- Error de proveedor o JSON inválido: se conserva el perfil y se responde con una pregunta corta orientada al objetivo actual.
- Datos no disponibles: se comunica la limitación sin inventar opciones ni horarios.
- Cambio de requisito después de una shortlist: se actualiza el perfil y se invalida la shortlist activa antes de buscar de nuevo.
- Acción sensible incompleta: se explica qué falta, por ejemplo una unidad o un horario, sin abandonar el contexto.

## Compatibilidad y migración

`ConversationState` y `conversation_slots` actuales se conservan durante la migración. Un adaptador los convierte a `RentalProfile` y los nuevos cambios continúan escribiendo las claves existentes mientras las vistas web dependan de ellas.

La vieja vía determinista sólo quedará como contingencia técnica para `/start`, selección numérica de un horario que ya está pendiente y fallos del proveedor de IA. Se eliminarán las reglas que convierten texto libre en el “siguiente campo” esperado.

## Pruebas y criterios de aceptación

Pruebas unitarias del intérprete y el aplicador cubrirán:

- varios requisitos en un solo mensaje;
- corrección de nombre, área, presupuesto y mascotas;
- una frase ambigua que produce una sola aclaración y no modifica datos;
- preservación de datos no mencionados;
- rechazo de unidad y horario no presentes en el contexto;
- fallo de JSON y de proveedor sin pérdida de contexto.

Pruebas de integración cubrirán el recorrido Telegram: lenguaje libre, recomendación, selección de unidad, solicitud de visita, selección de horario y visualización posterior por el broker. Los datos de una cita deben coincidir en `Lead`, `ChatConversation` y `Showing`.

La aceptación manual exige que “Carlops”, “sorry Carlos” y “no, my name is Carlos” terminen con el nombre `Carlos` y una pregunta de área; y que un mensaje como “busco dos habitaciones en Burnaby, perro, hasta 3500, septiembre” produzca recomendaciones o una aclaración breve únicamente para el dato que falte.
