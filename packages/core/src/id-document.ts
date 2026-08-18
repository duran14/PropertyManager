/**
 * Allowlist de tipos MIME aceptados para el documento de identificación de
 * una solicitud de renta.
 *
 * Vive en `core` (y no en el servicio del API) porque la necesitan los DOS
 * lados: el API para validar al recibir y al servir, y el formulario público
 * (`apps/web/src/pages/ApplyPage.tsx`) para el `accept` del input y para
 * avisar al solicitante antes de subir. Cuando estaban duplicadas, el fix de
 * seguridad que estrechó la del servidor dejó el `accept` del formulario
 * ofreciendo tipos que el servidor ya rechazaba — un solicitante subía una
 * foto HEIC de iPhone y recibía un error que no podía accionar.
 *
 * Origen de la allowlist (hallazgo Critical, XSS almacenado): el mime type lo
 * manda el solicitante sin autenticar y se sirve como `Content-Type` en la
 * descarga. Sin allowlist, `text/html` o `image/svg+xml` ejecutan script en el
 * origen del SPA cuando el staff abre el documento. NO agregar tipos que un
 * navegador pueda interpretar como documento activo.
 */
export const ALLOWED_ID_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const satisfies readonly string[];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_ID_DOCUMENT_MIME_TYPES);

/**
 * Match exacto contra la allowlist. Acepta `null`/`undefined` sin lanzar
 * porque los call sites reciben valores tanto de la BD (columna nullable en
 * filas legacy) como del navegador (`File.type` puede venir vacío).
 */
export function isAllowedIdDocumentMimeType(value: string | null | undefined): value is string {
  return typeof value === 'string' && ALLOWED_SET.has(value);
}
