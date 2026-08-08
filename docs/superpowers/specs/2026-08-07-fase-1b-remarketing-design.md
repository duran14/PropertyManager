# Fase 1B: Lead Re-engagement / Remarketing con Memoria de Conversación

## Contexto y por qué esto existe

`docs/PRODUCT_ROADMAP.md` define la Fase 1B (agregada tras la conversación con
Jorge Capote — ver la sección "Validado contra industria" del roadmap): leads
que le escribieron al chatbot pero nunca agendaron un showing se enfrían sin
que nadie les dé seguimiento, porque el volumen de mensajes hace que el
property manager no tenga tiempo de repasarlos manualmente. La idea es
reutilizar la memoria de conversación que el asistente omnicanal ya guarda
(sin infraestructura nueva) para mandarles automáticamente un mensaje corto y
personalizado antes de que se pierdan del todo.

Este spec cubre la fase completa (1B.1 selección de audiencia, 1B.2
generación/envío, 1B.3 control de frecuencia y opt-out) — a diferencia de
Fase 1.1, aquí las tres piezas son pequeñas y forman un solo flujo, no
subsistemas independientes.

## Decisiones tomadas con el usuario (brainstorming del 2026-08-07)

- **Envío 100% automático**, sin cola de revisión humana — igual que las
  respuestas normales del chatbot hoy.
- **Un solo intento por lead, para siempre** (no una serie de mensajes). Esto
  simplifica el diseño: una vez enviado, el lead queda excluido
  permanentemente sin necesidad de rastrear si respondió o no.
- **Opt-out**: se agrega un campo explícito `Lead.optedOutAt`, activado por
  un detector determinista (no por IA) de frases de "no me contacten" que
  corre sobre **cualquier** mensaje entrante, no solo respuestas al
  remarketing.
- **Cadencia**: el job corre semanalmente. Umbral de inactividad: ≥14 días
  sin mensajes en la conversación.
- **Audiencia**: leads con `status` en `new_`, `contacted`, o `qualified`,
  sin ningún showing agendado.
- **Pruebas**: solo automatizadas (no hay consola externa que configurar,
  a diferencia de Messenger — es lógica interna).

## Arquitectura general

Un job periódico de BullMQ (nuevo) que corre **una vez por semana, para
todos los tenants** en una sola ejecución (`prisma.tenant.findMany()` +
`withTenant` por tenant) — a diferencia del job de reconciliación diaria
(`reconciliationQueue`), que se registra manualmente por tenant vía una ruta
(`POST /sentinel/...`), este job no requiere que nadie lo "active" por
tenant: no depende de credenciales externas ni configuración previa, así
que tiene sentido que corra solo para todos los tenants existentes.

Flujo por tenant, por lead candidato:

1. Query de candidatos (ver criterios abajo).
2. Arma el contexto del lead desde `ConversationSlot` (área, presupuesto,
   recámaras, lo que se haya capturado).
3. Le pide a GLM que redacte un mensaje corto y personalizado (con fallback
   determinista de plantilla si GLM no está configurado, mismo patrón que
   el resto del bot).
4. Envía por el canal de la conversación más reciente del lead, vía el
   `MessagingAdapter` que ya existe para ese canal — cero adapters nuevos.
5. Registra el envío como `ChatMessage` (`role: 'assistant'`) y marca
   `Lead.lastRemarketedAt`.

Independiente del job: un detector determinista de opt-out que corre dentro
del flujo normal de mensajes entrantes (`handleInboundMessage`), sobre
**cualquier** mensaje (no solo respuestas al remarketing), marcando
`Lead.optedOutAt` cuando detecta una frase explícita de rechazo. Es un
guardrail de cumplimiento (equivalente al keyword STOP que exigen las
normas de SMS en Norteamérica), no un flujo con IA.

## Diseño detallado

### Cambios de datos (Prisma)

```prisma
model Lead {
  // ...campos existentes sin cambios...
  lastRemarketedAt DateTime? // cuándo se envió el mensaje de reactivación (null = elegible)
  optedOutAt       DateTime? // cuándo el lead pidió no ser contactado
}
```

Migración: `ALTER TABLE "leads" ADD COLUMN "lastRemarketedAt" TIMESTAMP(3), ADD COLUMN "optedOutAt" TIMESTAMP(3);` (ambas nullable, sin default — no rompe filas existentes).

### Criterios de selección de candidatos

```
Lead.status IN ('new_', 'contacted', 'qualified')
AND Lead.showings = { none: {} }        -- nunca agendó
AND Lead.lastRemarketedAt IS NULL       -- nunca remarketeado
AND Lead.optedOutAt IS NULL             -- no pidió no ser contactado
AND última ChatMessage.createdAt de su conversación más reciente < now() - 14 días
```

El umbral de 14 días se calcula en código (no hay campo denormalizado de
"último mensaje" en `ChatConversation`): por cada lead candidato (tras el
filtro de Prisma), se consulta el `ChatMessage` más reciente de su
conversación (`orderBy: { createdAt: 'desc' }, take: 1`) y se descarta si
es más reciente que el umbral. Dado que el volumen esperado en el MVP es
bajo (decenas de leads, no miles), esto se hace con una consulta por lead
candidato en vez de una agregación SQL compleja — revisar si esto necesita
optimizarse cuando el volumen real lo justifique (fuera de alcance ahora).

### Job de BullMQ

Nuevo archivo `apps/api/src/jobs/queues.ts` (extendido, no nuevo archivo):
`remarketingQueue`, siguiendo el mismo patrón que `reconciliationQueue`
(mismas opciones de reintento/backoff). Se programa **una sola vez, sin
`tenantId`** (a diferencia de `scheduleDailyReconciliation`), al arrancar
el servidor (`server.ts`), con `repeat: { pattern: '0 9 * * 1', tz:
'America/Vancouver' }` (lunes 9am) y un `jobId` fijo (para que BullMQ no
duplique el registro en cada restart del servidor).

Worker nuevo en `apps/api/src/jobs/worker.ts` (agregado al `startWorkers()`
existente): procesa el job iterando `prisma.tenant.findMany()`, y por cada
tenant llama a la función de dominio (ver abajo) dentro de `withTenant`.

### Servicio de dominio (archivo nuevo: `apps/api/src/services/remarketing.service.ts`)

Se crea un archivo nuevo (no se agrega a `chatbot.service.ts`, que ya es
grande) con:

- `findReengagementCandidates(tx, tenantId): Promise<Lead[]>` — aplica los
  criterios de arriba.
- `draftReengagementMessage(deps: { glm: GlmAdapter }, lead, slots):
  Promise<string>` — arma el prompt con los `ConversationSlot` capturados,
  llama a `glm.reason()`, cae al fallback determinista si GLM no está
  configurado (mismo patrón `isIntegrationConfigured`-driven que el resto
  de adapters — en este caso, el fallback es simplemente no invocar GLM
  cuando el adapter inyectado es el mock, ya que `GlmMockAdapter` devuelve
  contenido determinista igual que en el resto del bot).
- `sendReengagementMessage(deps: { messaging: MessagingAdapter }, lead,
  conversation, content): Promise<void>` — crea el `ChatMessage`, envía vía
  `sendWithRetry` (reutilizado de `chatbot.service.ts`, se exporta si no lo
  está ya), actualiza `deliveryStatus`, y si el envío fue exitoso marca
  `Lead.lastRemarketedAt = now()`. Si falla, **no** marca
  `lastRemarketedAt` — el lead sigue elegible y se reintenta la semana
  siguiente sin lógica de reintento especial.
- `runWeeklyReengagement(tenantId, deps): Promise<{ sent: number; skipped:
  number }>` — orquesta los tres anteriores para un tenant, procesando
  leads **secuencialmente** (no en paralelo) para no ráfaguear al
  proveedor de mensajería.

### Detector de opt-out (mismo archivo `remarketing.service.ts`)

`detectOptOutPhrase(message: string): boolean` — función pura, determinista,
sin IA. Lista de frases de **alta precisión** en español e inglés — solo
frases inequívocas de "deja de contactarme", no de "no me interesa esto en
particular" (que es una negación normal dentro de una conversación y NO
debe disparar opt-out): "no me contacten", "no me escriban más", "dejen de
escribirme", "quítenme de la lista", "ya no me manden mensajes",
"unsubscribe", "stop contacting me", "stop messaging me". Deliberadamente
NO incluye frases ambiguas como "no me interesa" o "no gracias" — un falso
positivo (excluir a alguien que sigue interesado) es peor que un falso
negativo (alguien que de verdad no quiere más mensajes tiene que escribirlo
más explícitamente una vez).

Se llama desde `handleInboundMessage` (`chatbot.service.ts`), justo después
de recibir el mensaje entrante, antes de cualquier otro procesamiento —
si detecta la frase, marca `Lead.optedOutAt` y el flujo normal del bot
continúa sin cambios (el opt-out no interrumpe la conversación en curso,
solo excluye al lead de futuros remarketing).

## Manejo de errores y casos límite

| Caso | Comportamiento |
|---|---|
| Envío falla (adapter error) | No se marca `lastRemarketedAt`; se reintenta la semana siguiente automáticamente. |
| Envío exitoso | Se marca `lastRemarketedAt = now()`; excluido para siempre de este flujo. |
| GLM no configurado / falla | Cae al fallback determinista; no bloquea el job ni salta al lead. |
| Tenant sin candidatos esa semana | No hace nada para ese tenant; no es un error. |
| Frase de opt-out detectada | `Lead.optedOutAt` se marca de inmediato, sin importar si ya fue remarketeado o no. |
| Lead con múltiples conversaciones | Se usa la conversación con el `ChatMessage` más reciente. |

## Plan de pruebas

Solo automatizados, real Prisma + adapters mock/spy inyectados (mismo
patrón que el resto del repo):

- `findReengagementCandidates`: incluye/excluye correctamente por `status`,
  `showings`, `lastRemarketedAt`, `optedOutAt`, y umbral de 14 días
  (casos: exactamente en el límite, un día antes, un día después).
- `runWeeklyReengagement`: marca `lastRemarketedAt` solo en envío exitoso;
  no lo marca si el adapter lanza error.
- `detectOptOutPhrase`: casos positivos en español e inglés, y casos
  negativos (mensajes normales de conversación que no deben disparar
  falso positivo).
- `draftReengagementMessage`: usa el fallback determinista cuando el GLM
  inyectado es el mock.
- Integración end-to-end del job para un tenant con 2-3 leads mixtos
  (uno elegible, uno con showing agendado, uno ya remarketeado, uno con
  opt-out) confirmando que solo el elegible recibe mensaje.

## Fuera de alcance (explícitamente)

- Cola de revisión humana antes de enviar.
- Series de múltiples mensajes de remarketing (solo un intento, para
  siempre).
- Registro/gestión de opt-out desde el dashboard (UI) — por ahora solo se
  detecta automáticamente desde el mensaje entrante.
- Optimización de la consulta de "último mensaje" para volumen alto (miles
  de leads) — la implementación actual hace una consulta por lead
  candidato, aceptable para el volumen esperado del MVP.
- Personalización más allá de área/presupuesto/recámaras (ej. fotos de la
  unidad, links directos) — mensaje de texto simple, igual que el resto
  del bot en esta fase.
