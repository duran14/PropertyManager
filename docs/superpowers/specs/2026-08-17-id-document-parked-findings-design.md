# Cerrar hallazgos parqueados de la descarga del documento de identificación — Diseño

## 1. Contexto

La revisión final del branch de descarga del documento de identificación
(commits `4292ff8..c9d5f20`) cerró su hallazgo Critical (XSS almacenado vía
`idDocumentMimeType`) pero dejó tres hallazgos parqueados de forma explícita,
por proceso: el flujo SDD concede una sola ronda de corrección a la revisión
final, y esa ronda se gastó en el Critical. Este spec los cierra.

Los tres son reales y accionables; ninguno necesita decisiones del usuario ni
credenciales externas.

## 2. Hallazgo A — regresión de UX: el `accept` del formulario ya no coincide con la allowlist del servidor

**Severidad real: alta para el negocio, aunque la revisión lo clasificó
Minor.** El fix del Critical introdujo una allowlist estricta en el servidor
(`image/jpeg`, `image/png`, `image/webp`, `application/pdf`) pero
`apps/web/src/pages/ApplyPage.tsx:143` sigue con
`accept="image/*,application/pdf"`.

Consecuencia concreta: un solicitante elige una foto `.heic` (formato por
defecto de las cámaras de iPhone), `.gif`, `.bmp` o `.tiff`; el navegador se
lo permite porque `image/*` los cubre; `fileToBase64` lee y convierte el
archivo completo; recién entonces el servidor lo rechaza con
`Unsupported ID document file type`, un mensaje que el solicitante no puede
accionar porque el propio formulario le ofreció ese archivo. El solicitante
es un desconocido aplicando a un departamento — cada fricción de este tipo
cuesta candidatos reales.

### Decisión de diseño: no ampliar la allowlist del servidor

Se consideró agregar `image/heic`/`image/heif` a la allowlist (son formatos
seguros — no ejecutan script, a diferencia de SVG). Se descarta:

- iOS Safari transcodifica HEIC a JPEG automáticamente cuando el `accept`
  del input declara tipos concretos y el usuario elige desde la biblioteca de
  fotos — que es el camino dominante. Estrechar el `accept` resuelve el caso
  común sin ampliar la superficie de tipos aceptados.
- Chrome y Firefox en Windows no pueden *mostrar* HEIC. Aceptarlo produciría
  un fallo silencioso río abajo: el staff descarga la identificación y no
  puede abrirla. Rechazar temprano con un mensaje claro es más honesto que
  aceptar algo que después nadie puede leer.

### Fix

1. **Fuente única de verdad compartida.** La allowlist se mueve a
   `packages/core` (paquete del que `apps/web` ya depende, con imports por
   subpath — ver `ConversationsPage.tsx`), exportada como
   `ALLOWED_ID_DOCUMENT_MIME_TYPES` (array `readonly string[]`) más un helper
   `isAllowedIdDocumentMimeType(value: string): boolean`. El servicio del API
   y la página pública la importan de ahí. Así el `accept` y la validación
   del servidor no pueden volver a divergir: hay un solo lugar que editar.
2. **`accept` explícito** en `ApplyPage.tsx`, derivado de esa constante
   (`ALLOWED_ID_DOCUMENT_MIME_TYPES.join(',')`), no una cadena literal
   duplicada.
3. **Validación en cliente antes de convertir**, dentro del
   `handleIdFileChange` que ya existe (donde ya vive la validación de tamaño):
   si `file.type` no está en la allowlist, mostrar un mensaje accionable que
   nombre los formatos aceptados y limpiar el input — el mismo patrón exacto
   que ya usa la rama de "archivo demasiado grande". Importante: la validación
   del servidor **no se toca ni se relaja**; la del cliente es solo UX, porque
   `accept` es una sugerencia (arrastrar-y-soltar y algunos selectores de
   Android lo ignoran) y un cliente nunca es un control de seguridad.

## 3. Hallazgo B (Important) — sin traza de auditoría al descargar PII

El repo tiene un audit trail encadenado y tamper-evident
(`apps/api/src/services/audit.service.ts`, `writeAudit`), usado ya en
`leads.service.ts`, `photos.service.ts`, `owner-statement.service.ts`,
`integration-vault.service.ts` y otros. Ninguna de las dos rutas de descarga
de `leads.ts` lo usa.

Descargar la identificación gubernamental de un solicitante, o su reporte de
crédito/antecedentes, es acceso a PII sensible. Hoy no hay forma de responder
"quién vio la identificación de X y cuándo" — una pregunta que un regulador
de privacidad de BC puede hacer, y que la propia arquitectura del repo
declara querer poder responder (ver el encabezado de `audit.service.ts`:
*"requisito para auditoría BC"*).

### Fix

Registrar una entrada de auditoría en ambas descargas, **solo cuando la
descarga tiene éxito** (no en los 404, que no son acceso a PII):

- ID: `action: 'rental_application.id_document.downloaded'`,
  `entityType: 'RentalApplication'`, `entityId: applicationId`.
- Reporte de screening: `action: 'rental_application.screening_report.downloaded'`,
  mismo `entityType`/`entityId`, con `kind` (`credit`/`criminal`) en el payload.

`actorId`/`actorType` salen de `actorFromUser(user.id, user.role)`, el helper
que ya existe para esto.

**Restricción crítica del payload:** el payload de auditoría **nunca** debe
contener el contenido del documento, el base64, ni la storage key completa —
solo identificadores. El audit trail es consultable y persistente; meterle
PII lo convierte en una segunda copia de la PII que se pretendía proteger.

**Manejo de fallos:** un fallo de `writeAudit` no debe romper una descarga
que ya funcionó. Se sigue el precedente exacto de `owner-statement.service.ts:267`
(`try/catch` alrededor del `writeAudit` con `console.error`), que ya resolvió
esta misma tensión en este repo.

## 4. Hallazgo C (Important) — guard anti path-traversal triplicado y con la comparación débil

El mismo guard vive en tres lugares:
`document-storage.service.ts:38-40` (escritura),
`leads.ts:707-712` (descarga de reportes),
`rental-application.service.ts:397-401` (descarga de ID, agregado por el
branch anterior).

Dos problemas:

1. **Triplicación:** cualquier endurecimiento futuro hay que aplicarlo en tres
   sitios y es fácil olvidar uno. El branch anterior propagó el patrón a un
   tercer lugar en vez de unificarlo.
2. **Comparación débil:** `target.startsWith(root)` sin exigir separador es el
   falso negativo clásico — `/data/docs-evil` pasa el guard de `/data/docs`.
   **Hoy no es explotable** (todas las keys las genera
   `buildDocumentStorageKey` con segmentos saneados, y ninguna ruta acepta una
   key cruda del request), y por eso la revisión no lo marcó Critical. Pero es
   una trampa esperando a la primera ruta que sí acepte una key del usuario.

### Fix

Extraer un helper único en `document-storage.service.ts` (donde ya vive el
guard original y la responsabilidad de storage):

```ts
export function resolveStorageKeyWithinRoot(rootDir: string, key: string): string | null
```

Devuelve la ruta absoluta resuelta, o `null` si la key escapa del root. La
comparación se endurece a `target === root || target.startsWith(root + path.sep)`,
que cierra el caso `docs-evil`. Los tres call sites pasan a usarlo. Cada uno
conserva su propio manejo de error actual (los códigos de estado y mensajes
no cambian) — este es un refactor de comportamiento idéntico salvo por el
endurecimiento de la comparación.

## 5. Fuera de alcance

- **No se amplía la allowlist de mime types** (ver la decisión en §2). Si en
  el futuro aparecen solicitantes reales bloqueados por HEIC, se reevalúa con
  datos, no por especulación.
- **No se agrega UI para consultar el audit trail** de descargas. Las entradas
  quedan consultables por `listAudit` (que ya existe); el dashboard de
  auditoría es trabajo de Fase 5 según el propio comentario de
  `audit.service.ts:96`.
- **No se hace backfill** de entradas de auditoría para descargas pasadas — no
  existe registro de que hayan ocurrido, y fabricarlo sería peor que no
  tenerlo.
- **No se toca el patrón de tests por grep de `leads.test.ts`.** Es la
  convención establecida del repo (no hay `supertest`); cambiarla es una
  decisión de infraestructura de tests aparte, no de este spec.
