# Ruta de descarga del documento de identificación — Diseño

## 1. El gap

El formulario público de solicitud de renta (`/apply/[token]`) exige que el
prospecto suba una foto/PDF de su identificación. El backend la guarda en
disco (`idDocumentStorageKey`, `apps/api/src/services/rental-application.service.ts:257-278`)
y la UI de Showings muestra *"ID document attached"* — pero, a diferencia de
los reportes de screening (que sí ganaron una ruta de descarga en una fase
anterior), **nunca se construyó ninguna ruta que sirva ese archivo**. El
código lo dice explícitamente (`ShowingsPage.tsx`, comentario junto a la
línea 328): *"no existe ninguna ruta en la app que sirva archivos de
DOCUMENT_STORAGE_DIR — servir/descargar el documento queda fuera de
alcance... trabajo futuro."*

Un segundo gap relacionado, descubierto al revisar el código: el frontend
público SÍ manda `idDocumentMimeType` en el payload del submit
(`ApplyPage.tsx:84`), pero el schema de `RentalApplication` nunca lo
persiste — solo existe la columna `idDocumentStorageKey`. Sin el mime type
guardado, la ruta de descarga no podría servir el archivo con el
`Content-Type` correcto (el documento puede ser JPG, PNG o PDF —
`accept="image/*,application/pdf"` en el input, `ApplyPage.tsx:143`).

## 2. Diseño

Mismo patrón exacto que la ruta de descarga de reportes de screening
(`GET /leads/applications/:applicationId/report/:kind`,
`apps/api/src/routes/leads.ts`), que ya existe y ya está probada — no se
inventa nada nuevo, se replica.

### 2.1 Schema: persistir el mime type

`RentalApplication` gana una columna:

```prisma
idDocumentStorageKey String?
idDocumentMimeType   String?
```

`submitRentalApplication` (`rental-application.service.ts`) ya recibe
`input.idDocumentMimeType` (validado como requerido junto al resto del
documento, línea 257) — solo falta agregarlo al `data` del `updateMany`
existente, junto a `idDocumentStorageKey`.

### 2.2 Ruta de descarga

`GET /leads/applications/:applicationId/id-document` — mismo archivo
(`leads.ts`), mismo nivel de auth que la ruta de reportes existente
(`requireAuth`, sin restricción de rol adicional — precedente ya
establecido en esa misma ruta), mismo guard de aislamiento por tenant
(`findFirst` con `tenantId`) y mismo guard anti path-traversal
(`target.startsWith(root)`) copiado literal del patrón ya usado.
Diferencia con la ruta de reportes: el `Content-Type` sale de
`idDocumentMimeType` (columna nueva) en vez de estar hardcodeado a
`application/pdf` — con un fallback a `application/octet-stream` para
filas viejas anteriores a esta migración, que tienen `idDocumentStorageKey`
pero no `idDocumentMimeType`.

### 2.3 UI

`ShowingsPage.tsx`, `CompletedApplicationPanel`: junto al texto *"ID
document attached"* (línea ~328), agregar un botón *"Download ID
document"* que reutiliza el mismo mecanismo de descarga autenticada que ya
existe en `ScreeningBlock.handleDownload` (fetch con
`Authorization: Bearer`, blob URL, abrir en pestaña nueva — necesario
porque el token vive en memoria, no en cookie, mismo razonamiento ya
documentado en el comentario de esa función).

## 3. Fuera de alcance

- No se agrega restricción de rol a la ruta nueva — sigue el mismo nivel
  de acceso (`requireAuth`) que la ruta de reportes de screening ya
  establecida, sin motivo para tratar el documento de identificación de
  forma distinta dentro de este cambio.
- Filas existentes (`idDocumentStorageKey` sin `idDocumentMimeType`,
  subidas antes de esta migración) siguen siendo descargables, solo que
  con `Content-Type: application/octet-stream` en vez del tipo real — el
  navegador las descarga igual, sin previsualización inline. No se hace
  backfill retroactivo del mime type (no hay forma confiable de inferirlo
  sin abrir cada archivo).
