import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildDocumentStorageKey,
  decodeBase64Payload,
  resolveStorageKeyWithinRoot,
} from './document-storage.service.js';

describe('document storage service', () => {
  it('builds tenant-scoped object keys with safe filenames', () => {
    expect(
      buildDocumentStorageKey({
        tenantId: 'tenant_demo_pm',
        documentId: 'doc_123',
        filename: ' Pricing Sheet 2026 (Final).PDF ',
      }),
    ).toBe('tenants/tenant_demo_pm/documents/doc_123/pricing-sheet-2026-final.pdf');
  });

  it('decodes raw and data-url base64 payloads', () => {
    const raw = Buffer.from('Cats are considered.').toString('base64');
    const dataUrl = `data:text/plain;base64,${raw}`;

    expect(decodeBase64Payload(raw).toString('utf8')).toBe('Cats are considered.');
    expect(decodeBase64Payload(dataUrl).toString('utf8')).toBe('Cats are considered.');
  });
});

describe('resolveStorageKeyWithinRoot', () => {
  it('resuelve una key normal dentro del root', () => {
    const resolved = resolveStorageKeyWithinRoot('/data/docs', 'tenants/t1/documents/d1/file.pdf');
    expect(resolved).toBe(path.resolve('/data/docs', 'tenants/t1/documents/d1/file.pdf'));
  });

  it('rechaza una key que escapa con ..', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '../../etc/passwd')).toBeNull();
  });

  it('rechaza una key absoluta que apunta fuera del root', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '/etc/passwd')).toBeNull();
  });

  // El caso que la comparación vieja (startsWith sin separador) dejaba pasar:
  // un directorio hermano cuyo nombre empieza igual que el root.
  it('rechaza un directorio hermano con el mismo prefijo (docs-evil vs docs)', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '../docs-evil/file.pdf')).toBeNull();
  });

  it('acepta el root mismo', () => {
    expect(resolveStorageKeyWithinRoot('/data/docs', '.')).toBe(path.resolve('/data/docs'));
  });
});
