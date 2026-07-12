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

export function createLocalDocumentStorage(input: {
  rootDir: string;
  publicBaseUrl?: string;
}): DocumentObjectStorage {
  return {
    async putObject(object): Promise<DocumentStoragePutResult> {
      const target = path.resolve(input.rootDir, object.key);
      const root = path.resolve(input.rootDir);
      if (!target.startsWith(root)) {
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
