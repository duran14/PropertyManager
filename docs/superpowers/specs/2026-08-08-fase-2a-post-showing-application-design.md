# Fase 2A: Aplicación de renta post-showing

## Contexto y por qué esto existe

`docs/PRODUCT_ROADMAP.md` define la Fase 2 ("Post-Showing Automation &
Tenant Screening") con dos subsecciones: 2.1 disparo del formulario
post-visita, y 2.2 el motor de screening (con tres capas: API directa de
proveedores, automatización de navegador para portales cerrados, y OCR de
PDF subido a mano).

Al explorar el repo antes de diseñar, se encontró que la Fase 2 son en
realidad **cinco piezas independientes**, no una:

- (a) detectar cuándo termina un showing y mandar el link de aplicación,
- (b) el modelo de datos de "aplicación" + el formulario público,
- (c) screening vía API directa con un proveedor externo,
- (d) screening vía automatización de navegador (Playwright),
- (e) screening vía OCR de un PDF subido a mano.

**Este spec cubre únicamente (a)+(b)**, bajo el nombre "Fase 2A". Razones:
es autocontenido, reutiliza patrones que ya existen y están probados en
este repo (tokens públicos del shortlist, storage de documentos, adapters
de mensajería), y entrega valor por sí solo — el PM deja de mandar el link
a mano. Las capas de screening (c/d/e) quedan para una fase posterior:
requieren decidir con qué proveedor real integrar, y (d) sería la primera
automatización de navegador en producción de este codebase (hoy Playwright
solo existe como herramienta de tests E2E).

## Decisiones tomadas con el usuario (brainstorming del 2026-08-08)

- **Confirmación manual, no automática por tiempo.** El broker/PM marca
  explícitamente que el showing ocurrió; eso dispara todo. (Hoy nada marca
  un showing como `completed` — el valor existe en el enum
  `ShowingStatus` pero ningún código lo asigna.)
- **Consecuencia de lo anterior: no hace falta ningún job de BullMQ en
  esta fase.** El roadmap planteaba "2 horas después del showing", lo que
  habría requerido un job periódico; con confirmación manual, el envío es
  síncrono dentro de la misma llamada.
- **Tres consentimientos separados y los tres obligatorios**: autorización
  general de la aplicación, consulta de buró de crédito, y verificación de
  antecedentes penales (police check). No se puede enviar el formulario
  sin los tres.
- **Sin firma electrónica real.** La "autorización firmada" del roadmap se
  implementa como checkbox + nombre escrito, no DocuSign (esa integración
  está planeada pero no existe todavía).
- **Notificación al broker por email + chat.** Siempre email (adapter de
  Resend, ya existente); además WhatsApp/Telegram según la preferencia
  configurada de ese usuario.
- **Pruebas:** solo automatizadas, mismo patrón del resto del repo.

## Arquitectura general

1. El broker/PM confirma manualmente que el showing ocurrió
   (`POST /showings/:id/complete`, ruta autenticada nueva). Esto marca el
   showing como `completed` — la primera vez que ese estado se usa en el
   producto.
2. La misma llamada, de forma síncrona, crea un `RentalApplication` con un
   token público y una expiración, y manda el link seguro
   (`${WEB_URL}/apply/${token}`) por el canal de la conversación del lead,
   reutilizando el `MessagingAdapter` correspondiente.
3. El prospecto abre `/apply/:token` (página pública nueva en el frontend,
   mismo patrón que `ShortlistPage.tsx`): llena ingresos/empleador/
   referencias, sube su identificación como archivo, marca los tres
   consentimientos, y escribe su nombre como firma.
4. Al enviar, se notifica al destinatario resuelto (ver abajo) por email y,
   si aplica, por chat.
5. La aplicación queda visible en el dashboard para revisión manual. Sin
   motor de screening todavía.

## Diseño detallado

### Modelo de datos

Nuevo modelo `RentalApplication`, relación 1:1 con `Showing` (un showing
completado genera como máximo una aplicación):

```prisma
model RentalApplication {
  id        String   @id @default(cuid())
  tenantId  String
  showingId String   @unique
  leadId    String
  unitId    String?

  tokenHash String   @unique
  expiresAt DateTime

  status    String   @default("invited") // invited | submitted

  // Datos capturados al enviar
  annualIncome         Int?
  employerName         String?
  references           String?
  idDocumentStorageKey String?

  applicantFullName    String?
  consentApplicationAt DateTime?
  consentCreditCheckAt DateTime?
  consentPoliceCheckAt DateTime?

  submittedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  showing Showing @relation(fields: [showingId], references: [id], onDelete: Cascade)
  lead    Lead    @relation(fields: [leadId], references: [id], onDelete: Cascade)
  unit    Unit?   @relation(fields: [unitId], references: [id])

  @@index([tenantId, status])
  @@map("rental_applications")
}
```

Los tres consentimientos se guardan como **timestamps individuales**, no
como un solo boolean: para un dato de cumplimiento importa cuándo se
otorgó cada autorización por separado, no solo que "aceptó".

`User` gana dos campos opcionales para la notificación por chat (hoy
`User` solo tiene `email`):

```prisma
notificationChannel ChatChannel?
notificationAddress String?
```

El token nunca se guarda en claro: solo su hash SHA-256, exactamente como
`hashShortlistToken` en `shortlist.service.ts`.

### Rutas

| Ruta | Auth | Qué hace |
|---|---|---|
| `POST /showings/:id/complete` | Sí | Marca `completed`, crea la aplicación con token, manda el link |
| `GET /public/applications/:token` | No | Valida token+expiración, devuelve el resumen (unidad, showing) para pintar el formulario |
| `POST /public/applications/:token` | No | Valida token y los 3 consentimientos, guarda, marca `submitted`, notifica |
| `GET /showings/:id/application` | Sí | El PM ve la aplicación recibida en el dashboard |

Las rutas públicas viven en el `publicRouter` existente, siguiendo el
patrón de las rutas públicas del shortlist.

**El archivo de identificación se sube como base64 dentro del JSON body**,
no como multipart — es el patrón que ya usa la subida de documentos
existente (`fileBase64`, tope de ~1.5 MB de base64 ≈ ~1.1 MB de archivo
real), y se persiste con `buildDocumentStorageKey` +
`createLocalDocumentStorage` del `document-storage.service.ts` existente.
Introducir multipart solo para esta ruta agregaría una dependencia y un
patrón nuevos sin ganar nada.

**Expiración del token: 14 días**, el mismo valor que ya usa el shortlist
(`shortlist.service.ts`), por consistencia.

### Envío del link al prospecto

Se resuelve la conversación del lead y se envía por su canal, reutilizando
`getReplyAddressFromConversation` + `sendWithRetry` + el `MessagingAdapter`
del canal — el mismo camino que ya usan el shortlist y el remarketing. El
link se arma con `WEB_URL`, igual que `buildShortlistMarkdownLink`.

**El canal `web` no puede recibir mensajes salientes** (su adapter es un
mock permanente: el web chat responde por HTTP, no tiene push). Esta
lección salió del review final de Fase 1B, donde leads de ese canal se
marcaban como contactados sin que nada se entregara. Aquí: si la
conversación del lead es `web` — o si el lead no tiene conversación (un
showing cargado a mano) — el showing igual se marca `completed` y la
aplicación igual se crea, pero la respuesta reporta que el link no se pudo
entregar, para que el PM lo copie del dashboard y lo mande a mano.

### Notificación al broker

Al recibir la aplicación:

- **Siempre** email vía el adapter de Resend.
- **Además** por chat si el usuario destinatario tiene
  `notificationChannel`/`notificationAddress` configurados.

Ambos envíos son *best-effort e independientes*: si falla el email, igual
se intenta el chat y viceversa; ninguno de los dos puede tumbar la
respuesta HTTP al prospecto. Su aplicación ya quedó guardada, y perder una
notificación no debe traducirse en un error del lado del prospecto — que
reintentaría y duplicaría. Los fallos se loguean.

**Resolución del destinatario**, en orden: `Showing.brokerUserId` →
`Lead.assignedUserId` → los usuarios con rol `property_manager` del
tenant. Sin destinatario resoluble, se loguea y se sigue. Esta resolución
se implementa como función pura, testeable por separado.

## Manejo de errores y casos límite

| Caso | Comportamiento |
|---|---|
| Confirmar un showing ya `completed` | 409; no se crea una segunda aplicación ni se remanda el link |
| Confirmar un showing `cancelled`/`no_show` | 409 — no tiene sentido pedir aplicación de una visita que no ocurrió |
| Token inválido, inexistente o expirado | 404, sin distinguir cuál (no filtrar existencia de tokens) |
| Formulario enviado dos veces (doble clic / reintento) | El segundo intento sobre una aplicación ya `submitted` responde 409; no sobrescribe datos ni renotifica |
| Falta cualquiera de los 3 consentimientos | 400 con el detalle de cuál falta |
| Archivo de ID faltante o que excede el tope de base64 | 400 (mismo tope que la subida de documentos existente) |
| Token válido pero ya expirado, sin haber enviado nunca | 404. El prospecto no puede recuperarlo solo; queda como limitación conocida (ver "Fuera de alcance") |
| Falla el envío del link al prospecto | El showing queda `completed` y la aplicación creada; se reporta en la respuesta para envío manual |
| Falla el email y/o el chat al broker | Se loguea; la aplicación del prospecto se guarda igual (200) |
| Lead sin conversación | Igual se crea la aplicación; se reporta que no hubo canal para enviarla |

## Plan de pruebas

Automatizados, con Prisma real contra la DB de test + adapters mock/spy
inyectados (mismo patrón que `chatbot.routing.test.ts` y
`remarketing.service.test.ts`):

- `POST /showings/:id/complete`: crea la aplicación, marca `completed`,
  manda el link por el canal correcto; rechaza showings ya completados o
  cancelados; no revienta cuando el canal es `web` ni cuando el lead no
  tiene conversación.
- Token público: uno válido devuelve el resumen; inválido o expirado da
  404.
- Envío del formulario: guarda todos los campos y los tres timestamps de
  consentimiento; rechaza si falta alguno; rechaza el doble envío.
- Resolución del destinatario de notificación (broker → assignee → PMs del
  tenant) como función pura.
- Un fallo de email o de chat no impide que la aplicación quede guardada.

Frontend: la página pública `/apply/:token` sigue el patrón de
`ShortlistPage.tsx` (sin auth, token del URL, `apiFetch`). Sin cobertura
E2E nueva — igual que el resto de las páginas del dashboard.

## Fuera de alcance (explícitamente)

- Todo el motor de screening (Fase 2.2 del roadmap): integración por API
  con proveedores, automatización de navegador con Playwright, y OCR de
  reportes en PDF. Requiere primero decidir el proveedor real.
- Firma electrónica real (DocuSign).
- Disparo automático por tiempo ("2 horas después") — reemplazado por
  confirmación manual del broker.
- Notificaciones push al navegador o app móvil.
- Edición de una aplicación ya enviada.
- Reenviar el link o extender la expiración desde el dashboard. Si un
  token expira sin que el prospecto haya enviado nada, en esta fase no hay
  forma de reactivarlo por interfaz. Es una limitación conocida y
  aceptada: con 14 días de ventana se espera que sea raro, y resolverla
  bien implica decidir si se reemplaza el token, si se notifica de nuevo,
  y qué pasa con el `@unique` sobre `showingId`.
