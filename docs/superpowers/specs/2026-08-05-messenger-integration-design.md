# Fase 1.1: Integración de Facebook Messenger

## Contexto y por qué esto existe

`docs/PRODUCT_ROADMAP.md` define una Fase 1 ("Facebook Messenger Integration &
Auto-Booking") con tres subsecciones: 1.1 webhook de Messenger, 1.2 hand-off de
IA a humano, 1.3 sync de Google Calendar para showings. Al explorar el repo
antes de diseñar, se encontró que estas tres piezas tienen madurez muy distinta:

- **1.2 (hand-off) ya existe y está madura** en `chatbot.service.ts`: el estado
  `handoff` de la máquina de estados, el flag `handoff` en `BotReply`, y las
  guardas para no rebotar de `handoff` a otro estado sin una señal fuerte, ya
  están implementados y se usan hoy en los canales existentes.
- **1.3 (Google Calendar) es territorio nuevo** y se traslapa con algo que ya
  funciona: el MVP agenda showings vía **ShowMojo** (`scheduling.service.ts`),
  usado hoy por Telegram/WhatsApp/SMS. No hay ninguna integración de Google
  Calendar en el repo. Antes de diseñarla hace falta aclarar con el usuario si
  reemplaza o convive con ShowMojo — se deja explícitamente fuera de este spec.
- **1.1 (webhook de Messenger) es 100% territorio nuevo** y es autocontenido:
  no depende de 1.3, y 1.2 ya está resuelto y solo necesita conectarse.

Por eso este spec cubre **únicamente 1.1**. Decisión tomada con el usuario
durante el brainstorming (ver sesión del 2026-08-05).

## Arquitectura general

Messenger se conecta como **un `MessagingAdapter` nuevo** (`packages/adapters`),
igual que WhatsApp/SMS (Twilio) y Telegram. Una vez conectado, hereda gratis
todo lo que el pipeline compartido (`handleInboundMessage` en
`chatbot.service.ts`) ya sabe hacer: Q&A de propiedades, captura de leads,
calificación, agendado de showings vía ShowMojo, y hand-off a humano — cero
cambios en la lógica del bot.

A diferencia de Telegram (long-polling, sin webhook), Messenger **solo
funciona por webhook** — es un requisito de la API de Meta, no una elección
de diseño. El patrón a seguir es el de Twilio, no el de Telegram:

- `POST /webhooks/messenger`: valida firma, deduplica por `message.mid`,
  responde rápido y procesa el turno del bot sin bloquear la respuesta a
  Meta — mismo patrón "ack rápido / despacho en segundo plano" que ya existe
  para Twilio (`acknowledgeAndDispatch` en `webhooks.ts`).
- `GET /webhooks/messenger`: handshake de verificación que Meta exige una
  sola vez, al configurar la URL del webhook en su consola. No tiene
  equivalente en Twilio ni Telegram.
- `MessengerRealAdapter` + `MessengerMockAdapter`, implementando el contrato
  `MessagingAdapter` (`send`/`parseWebhook`) igual que los adapters existentes.

### Alcance explícito de esta fase

- **Modo desarrollo/tester de Meta, no App Review.** Sin la revisión de Meta,
  el bot solo puede responder a administradores/testers de la Page — igual
  que el WhatsApp Sandbox de Twilio. Pedir App Review es un proceso de Meta
  aparte (días/semanas), fuera de este spec.
- **Una sola Page compartida, un tenant por defecto** (`MESSENGER_DEFAULT_TENANT_ID`),
  igual que `TELEGRAM_DEFAULT_TENANT_ID`. El soporte multi-tenant (una Page
  por cliente, credenciales en `IntegrationConfig`) queda para cuando haya
  clientes reales, consistente con el plan ya documentado para Telegram en
  `docs/CHANNEL_ROLLOUT_PLAN.md`.
- **Solo mensajes de texto**, entrada y salida. Botones/quick-replies,
  adjuntos entrantes, plantillas ricas de Messenger: fuera de alcance (YAGNI
  — el bot hoy solo produce y consume texto en todos los canales).
- No se crea infraestructura de Meta previa: el usuario no tiene Page ni
  Meta Developer App hoy; se le guía paso a paso para crearlas, sin que
  ningún token pase por el asistente de forma expuesta (mismo cuidado que
  con las credenciales de Twilio).

## Diseño detallado

### Variables de entorno nuevas

Mismo patrón que Twilio/Telegram: todas opcionales, sin ellas el canal cae a
mock automáticamente (`isIntegrationConfigured`).

| Variable | Uso |
|---|---|
| `MESSENGER_PAGE_ACCESS_TOKEN` | Enviar mensajes vía Graph API |
| `MESSENGER_APP_SECRET` | Validar `X-Hub-Signature-256` |
| `MESSENGER_VERIFY_TOKEN` | Handshake de verificación del webhook |
| `MESSENGER_DEFAULT_TENANT_ID` | Tenant que recibe mensajes de la Page compartida |

`isIntegrationConfigured(env, 'messenger')` → `Boolean(env.MESSENGER_PAGE_ACCESS_TOKEN && env.MESSENGER_APP_SECRET)`.

### Verificación del webhook (`GET /webhooks/messenger`)

Meta manda `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...`. Si
`hub.verify_token` coincide con `MESSENGER_VERIFY_TOKEN`, se responde el
valor de `hub.challenge` tal cual, como texto plano (no JSON). Sin
`MESSENGER_VERIFY_TOKEN` configurado, la ruta responde 404 — no tiene sentido
"mockear" un handshake que corre una sola vez, manualmente, desde la consola
de Meta.

### Firma del webhook (`POST /webhooks/messenger`)

Meta firma sobre el **body crudo** (`X-Hub-Signature-256: sha256=<hmac-sha256
del body sin parsear, con MESSENGER_APP_SECRET>`), a diferencia de Twilio que
firma sobre los parámetros del form. Esto exige capturar el buffer del body
antes de que Express lo parsee — un middleware `express.json({ verify: (req,
res, buf) => { req.rawBody = buf; } })` aplicado solo a esta ruta. Firma
inválida → 403, igual que Twilio.

### Deduplicación y claim

Cada mensaje trae `entry[].messaging[].message.mid`, usado como
`providerMessageId` en `WebhookReceipt` (`provider: 'messenger'`).

**Refactor incluido en esta fase:** `claimTwilioMessage`/`completeTwilioMessage`/
`failTwilioMessage` (hoy en `twilio-webhook-security.service.ts`) no tienen
nada específico de Twilio — solo hacen claim/complete/fail sobre
`WebhookReceipt`, que ya tiene un campo `provider` genérico (string). Se
mueven a un archivo nuevo y compartido, `webhook-receipt.service.ts`, con
firma `claimWebhookMessage(provider, tenantId, messageId)` /
`completeWebhookMessage(...)` / `failWebhookMessage(...)`, para que Messenger
las reutilice sin duplicar código ni crear una tabla paralela.
`twilio-webhook-security.service.ts` se queda solo con lo que sí es
específico de Twilio (`validateTwilioWebhookSignature`,
`buildTwilioWebhookUrl`); `webhooks.ts` actualiza sus imports en consecuencia.
Lo específico de la firma de Messenger vive en un archivo nuevo,
`messenger-webhook-security.service.ts` (HMAC-SHA256 sobre el body crudo).

### Parseo del payload entrante

Formato de Meta: `{ entry: [{ messaging: [{ sender: { id }, message: { mid,
text, is_echo? } }] }] }`. Diferencias clave frente a Twilio/Telegram:

- **Identidad del prospecto:** Messenger identifica al usuario con un PSID
  (`sender.id`), no un número de teléfono. Se usa igual como `externalId` en
  `ChatConversation` — sin cambios de esquema, ese campo ya es un string
  libre.
- **Puede traer varios mensajes por request** (Meta a veces agrupa
  `entry`/`messaging`). `parseWebhook` procesa solo el primer mensaje de
  texto válido y no-eco; si llegan varios en un mismo POST, se documenta como
  limitación conocida (no se resuelve ahora — agregar soporte
  multi-mensaje-por-request complicaría el contrato `MessagingAdapter` para
  todos los canales, y es un caso poco frecuente en la práctica).
- **Eco de mensajes propios** (`message.is_echo === true`): Meta también
  manda por webhook los mensajes que la propia Page envió. Se filtran
  explícitamente — si no, el bot podría "responder" a su propia respuesta.
- **Eventos que no son texto** (postbacks, adjuntos, confirmaciones de
  lectura/entrega): se ignoran silenciosamente (200 OK, sin acción). No es
  un error — simplemente no hay nada que procesar en esta fase.

### Envío (`send`)

`POST https://graph.facebook.com/v21.0/me/messages` con
`MESSENGER_PAGE_ACCESS_TOKEN`, `recipient.id` = el PSID capturado del
inbound, `message.text` = la respuesta del bot. Si `MESSENGER_PAGE_ACCESS_TOKEN`
falta al intentar enviar en modo real, lanza error explícito — mismo patrón
que `TwilioMessagingWrapper` con `TWILIO_SMS_FROM`/`TWILIO_WHATSAPP_FROM`.

### Cambios de tipos y datos

- `ChatChannel` (Prisma `enum ChatChannel` + `packages/adapters/src/contracts.ts`):
  agregar `messenger`.
- `LeadSource` (Prisma): agregar `messenger`.
- `IntegrationKey` (`packages/config/src/env.ts`): agregar `'messenger'`.
- `packages/adapters/src/factory.ts`: cablear `messaging.messenger` (real si
  `isIntegrationConfigured(env, 'messenger')`, si no `MessengerMockAdapter`),
  y agregar `messenger` a `mockModes`.

## Manejo de errores y casos límite

| Caso | Comportamiento |
|---|---|
| Firma `X-Hub-Signature-256` inválida o ausente | 403, igual que Twilio |
| `hub.verify_token` no coincide en el handshake | 403 |
| Mensaje repetido (`message.mid` ya reclamado) | Idempotente, no reprocesa (mismo mecanismo que Twilio) |
| Reintento de Meta por timeout/no-200 | Cubierto por el claim/dedup existente |
| `message.is_echo === true` | Se ignora, 200 OK, sin acción |
| Evento sin texto (postback, adjunto, read receipt) | Se ignora, 200 OK, sin acción |
| Envío real sin `MESSENGER_PAGE_ACCESS_TOKEN` | Error explícito (no falla en silencio) |
| Varios mensajes en un mismo POST | Se procesa solo el primero válido (limitación documentada) |

## Plan de pruebas

**Automatizados:**
- Validación de firma (válida / alterada / ausente).
- Handshake de verificación (token correcto / incorrecto).
- `MessengerRealAdapter.parseWebhook` / `.send`, incluyendo filtrado de eco
  y de eventos no-texto.
- Ruta del webhook completa (claim rápido + procesamiento en segundo plano),
  mismo patrón que `webhooks.twilio.test.ts`: env de prueba mockeado
  (`MESSENGER_APP_SECRET`/`MESSENGER_PAGE_ACCESS_TOKEN`/`MESSENGER_DEFAULT_TENANT_ID`
  de prueba, firmando cada request simulado como lo haría Meta), sin
  depender de ni tocar credenciales reales.
- Reutilización de `webhook-receipt.service.ts` no rompe la cobertura
  existente de claim/complete/fail para Twilio (los tests actuales de
  `twilio-webhook-security.service.test.ts` siguen pasando tras el refactor).

**Manual:** guiar al usuario paso a paso para crear la Facebook Page + Meta
Developer App de prueba, conectar el webhook vía el mismo túnel de ngrok
usado con WhatsApp, agregar al usuario como tester, y mandar un mensaje real
de punta a punta para confirmar que la conversación aparece en el dashboard
y la respuesta llega a Messenger.

## Fuera de alcance (explícitamente, para no perder el hilo después)

- Fase 1.2 (hand-off): ya existe, no requiere trabajo nuevo más allá de que
  Messenger participe del mismo `handleInboundMessage`.
- Fase 1.3 (Google Calendar / auto-booking): pendiente de decidir si
  reemplaza o convive con ShowMojo. No se toca en este spec.
- App Review de Meta (acceso público más allá de testers).
- Multi-tenant real (Page por cliente, credenciales vía `IntegrationConfig`).
- Botones/quick-replies, adjuntos entrantes, plantillas ricas de Messenger.
- Soporte para múltiples mensajes por request de webhook.
