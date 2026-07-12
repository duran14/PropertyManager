import { describe, expect, it } from 'vitest';
import { buildDocumentStorageKey, decodeBase64Payload } from './document-storage.service.js';

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
