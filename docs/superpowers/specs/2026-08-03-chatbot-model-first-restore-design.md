# Restaurar y extender "modelo primero" para el chatbot (renta + compra/venta)

## Contexto y por qué esto existe

El 1 de agosto se diseñó e implementó "modelo primero" para la conversación de renta —
ver [`2026-08-01-model-first-conversation-design.md`](2026-08-01-model-first-conversation-design.md),
que sigue vigente como referencia arquitectónica y **no se repite aquí**. Ese trabajo
(`rental-conversation.types/interpreter/actions/context.ts`, ~1500 líneas con su
propia suite de tests) se fusionó (`8ee0c8a`) y se revirtió el mismo día (`5371731`).

Se confirmó con el usuario que el revert no fue por un bug encontrado: fue una
decisión cautelosa al retomar el proyecto en una nueva sesión de Claude Code, sin
notas técnicas de por qué. Una revisión completa del código revertido (hecha para
este spec) no encontró defectos de diseño — al contrario, ya resuelve exactamente
los riesgos de alucinación que preocupan (nunca inventa un ID de unidad u horario,
nunca muta el perfil con confianza baja, el modelo nunca ejecuta acciones directamente).

**Motivo de retomarlo ahora:** diagnóstico en vivo (ver conversación previa) confirmó
que el bot se siente "cuadrado" porque el motor determinista es el camino principal
y el modelo real (GLM-5.2) es el último recurso, casi nunca invocado. Además se encontró
y ya se corrigió un bug puntual (`parseCanadianLocation` aceptaba cualquier texto como
nombre de ciudad, incluyendo frases confusas del usuario) — ese parche queda como
mitigación temporal; este rediseño lo vuelve innecesario al evitar que el modelo
alucine el campo `preferred_area` en primer lugar (`hasValidSelection`-style validation
para todo el perfil, no solo para selección de unidades).

## Qué cambia respecto al diseño original

El diseño de arquitectura, contrato `ConversationTurn`, manejo de confianza y
flujo de datos para **renta** son los del documento original, sin cambios de fondo.
Lo que sí cambia:

1. **La capa de dependencias de acciones está desactualizada.** En los ~2 días
   posteriores al revert, `shortlist.service.ts` y `scheduling.service.ts`
   cambiaron de firma:
   - `getAvailableSlots` pasó de `(input: {tenantId, conversationId, unitId}) => Promise<PendingTourSlot[]>`
     a `(tenantId, unitId, adapter: ShowMojoAdapter) => Promise<AvailableSlotsResult>`
     (ahora requiere el adapter y devuelve un objeto envuelto, no un arreglo plano).
   - `scheduleTour` pasó de `(input: {tenantId, conversationId, unitId, slotIndex, slot}) => Promise<{scheduledAt}>`
     a requerir `leadId`, `prospectName`, `prospectPhone?`, `prospectEmail?` y el
     `adapter`, devolviendo también `showingId`, `showmojoUrl`, `confirmUrl`.
   - `createShortlist` no cambió de forma relevante.

   `rental-conversation.actions.ts` se reescribe para llamar estas firmas reales
   (obteniendo `adapter`, `leadId` y datos de contacto del contexto de la
   conversación antes de invocar `scheduling.service.ts`), sin cambiar la lógica
   de qué intent dispara qué acción ni las validaciones de seguridad.

2. **Se extiende el mismo patrón a compra/venta** (`ownership-conversation.service.ts`),
   fuera del alcance del diseño original. Es diseño nuevo, sin precedente probado:
   - Contrato análogo pero **sin `selection` ni orquestador de acciones**: este
     flujo no reserva nada ni recomienda inventario, solo califica al prospecto
     (tipo de propiedad, presupuesto, financiamiento, timeline, urgencia,
     ocupantes, mascotas, prioridades) y genera *handoff* a un broker humano
     cuando la calificación está completa.
   - Mismo mecanismo de `confidence: 'high'|'low'` y parche de perfil
     transaccional (`set`/`clear`), reutilizando el mismo patrón de
     `applyRentalProfilePatch` generalizado a un segundo conjunto de campos
     (`BUYER_KEYS`/`SELLER_KEYS` ya existentes en el código actual).
   - Sin ejecutor de acciones: al no haber reservas ni recomendaciones de
     inventario, no hay superficie de alucinación operativa que validar más
     allá del perfil mismo.
   - El código determinista actual de `ownership-conversation.service.ts`
     (`buildOwnershipConversationTurn` y sus builders) pasa a ser el fallback
     de fallo de proveedor, igual que en renta.

3. **Trade-off de latencia aceptado explícitamente.** Con el modelo como camino
   principal, la mayoría de los turnos (antes instantáneos vía regex) van a
   tardar ~6-12s (con el timeout/reintentos ya acotados hoy en `glm.real.ts`:
   2 intentos × 6s). Confirmado con el usuario como aceptable para la demo.

## Componentes (resumen — arquitectura completa en el doc original)

- `rental-conversation.types.ts` — sin cambios de diseño (contrato Zod estricto).
- `rental-conversation.interpreter.ts` — sin cambios de diseño (confianza,
  validación de selección contra unidades/slots reales, `providerFailed`).
- `rental-conversation.actions.ts` — **reescrito** contra las firmas actuales
  de `shortlist.service.ts`/`scheduling.service.ts` (ver punto 1 arriba).
- `rental-conversation.context.ts` — sin cambios de diseño.
- `ownership-conversation.types.ts`, `.interpreter.ts`, `.context.ts` — **nuevos**,
  mismo patrón que renta, sin equivalente de `actions.ts`.
- `chatbot.service.ts` — el punto de entrada (`handleInboundMessageUnlocked`)
  se re-cablea para llamar al intérprete de renta u ownership como camino
  principal según el `transaction_intent` detectado, cayendo a los builders
  deterministas actuales solo cuando `providerFailed`.

## Flujo de datos y manejo de errores

Igual que el documento original para renta (contexto → intérprete → validador/aplicador
→ orquestador de acciones → persistencia), extendido a ownership sin el paso de
orquestador de acciones. Las tres capas de seguridad ya acordadas:

1. Falla de proveedor (red, timeout, JSON inválido) → fallback determinista actual.
2. Confianza baja → aclaración del modelo, perfil intacto, ninguna acción ejecutada.
3. Selección inventada (unidad/slot que no existe) → tratada como falla de proveedor,
   ninguna acción ejecutada.

## Plan de pruebas

1. **Suite unitaria de renta**: resucitar y adaptar
   `rental-conversation.{types,interpreter,actions,context}.test.ts` del commit
   `4551eae` a las firmas actuales.
2. **Suite unitaria de ownership**: nueva, mismo patrón (confianza baja, corrección
   de campos, handoff al completar calificación).
3. **Ajuste de `chatbot.service.test.ts`**: los tests que asumían el camino
   determinista como principal se adaptan para usar un adapter de modelo simulado
   (reutilizando el patrón de `GlmMockAdapter` ya existente) y seguir siendo
   deterministas.
4. **Prueba manual en vivo** (ejecutada por Claude, no automatizada): conversación
   completa contra `/chat/messages` con el modelo real — saludo → nombre → mensaje
   rico con varios datos → corrección de nombre → selección de unidad → agendar
   tour — para renta y para compra/venta. Acotada a un recorrido representativo
   por el costo/cuota real de la API de Z.ai.
5. **Regresión completa**: `pnpm test` + `pnpm typecheck` de todo el monorepo.

## Criterios de aceptación

- Un mensaje como "My budget is $2600, I want to move in August near Burnaby, 2
  occupants and one cat" se interpreta en un solo turno sin preguntas redundantes.
- "sorry Carlos" / "no, my name is Carlos" corrigen el nombre sin perder el resto
  del perfil ya capturado.
- Un mensaje ambiguo o sin sentido produce como máximo una pregunta de aclaración
  y no muta el perfil ni ejecuta ninguna acción.
- Ninguna prueba (unitaria o manual) logra que el bot reserve un tour o recomiende
  una unidad que no exista realmente en el inventario/horarios visibles.
- El mismo patrón funciona para compra/venta: un mensaje con varios datos de
  comprador/vendedor se captura en un turno, con *handoff* al completar.
- `pnpm test` y `pnpm typecheck` pasan en todo el monorepo.
