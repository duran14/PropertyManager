import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface DocumentStoragePutInput {
  key: string;
  body: Buffer;
  contentType: string;
}

export interface DocumentStoragePutResult {
  storageKey: string;
  storageUrl: string;
}

export interface DocumentObjectStorage {
  putObject(input: DocumentStoragePutInput): Promise<DocumentStoragePutResult>;
}

export function buildDocumentStorageKey(input: {
  tenantId: string;
  documentId: string;
  filename: string;
}): string {
  return `tenants/${safeSegment(input.tenantId)}/documents/${safeSegment(input.documentId)}/${safeFilename(input.filename)}`;
}

export function decodeBase64Payload(value: string): Buffer {
  const payload = value.includes(',') ? value.split(',').at(-1) ?? '' : value;
  return Buffer.from(payload, 'base64');
}

/**
 * Resuelve una storage key contra el root configurado, devolviendo `null` si
 * la ruta resultante escapa de ese root.
 *
 * Fuente única del guard anti path-traversal: antes estaba copiado en tres
 * lugares (escritura acá, descarga de reportes en routes/leads.ts, descarga
 * del documento de identificación en rental-application.service.ts), lo que
 * obligaba a endurecer tres sitios a la vez y era fácil olvidar uno.
 *
 * La comparación exige el separador (`root + path.sep`) en vez de un
 * `startsWith(root)` pelón: sin él, un directorio hermano cuyo nombre empieza
 * igual que el root (`/data/docs-evil` contra `/data/docs`) pasaba el guard.
 * Hoy no es explotable porque todas las keys las genera
 * `buildDocumentStorageKey` con segmentos saneados y ninguna ruta acepta una
 * key cruda del request — pero es la trampa que espera a la primera que sí.
 */
export function resolveStorageKeyWithinRoot(rootDir: string, key: string): string | null {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, key);
  if (target !== root && !target.startsWith(root + path.sep)) {
    return null;
  }
  return target;
}

export function createLocalDocumentStorage(input: {
  rootDir: string;
  publicBaseUrl?: string;
}): DocumentObjectStorage {
  return {
    async putObject(object): Promise<DocumentStoragePutResult> {
      const target = resolveStorageKeyWithinRoot(input.rootDir, object.key);
      if (target === null) {
        throw new Error('Document storage key escaped the configured root directory');
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, object.body);

      return {
        storageKey: object.key,
        storageUrl: input.publicBaseUrl
          ? `${input.publicBaseUrl.replace(/\/+$/, '')}/${object.key}`
          : `local://${object.key}`,
      };
    },
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function safeFilename(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const lastDot = trimmed.lastIndexOf('.');
  const name = lastDot > 0 ? trimmed.slice(0, lastDot) : trimmed;
  const extension = lastDot > 0 ? trimmed.slice(lastDot + 1) : '';
  const safeName = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
  const safeExtension = extension.replace(/[^a-z0-9]+/g, '');
  return safeExtension ? `${safeName}.${safeExtension}` : safeName;
}
