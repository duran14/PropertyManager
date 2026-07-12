import { describe, expect, it } from 'vitest';
import { normalizeDocumentUpload } from './document-intake.service.js';

describe('document intake service', () => {
  it('normalizes uploaded document metadata for storage', () => {
    const doc = normalizeDocumentUpload({
      filename: '  Pet Policy.PDF  ',
      mimeType: 'application/pdf',
      category: 'policy',
      entityType: 'tenant',
      description: '  Default pet rules  ',
      textContent: ' Cats allowed. Dogs require approval. ',
    });

    expect(doc).toEqual({
      filename: 'Pet Policy.PDF',
      mimeType: 'application/pdf',
      category: 'policy',
      entityType: 'tenant',
      entityId: null,
      description: 'Default pet rules',
      textContent: 'Cats allowed. Dogs require approval.',
      storageUrl: null,
      fileBase64: null,
    });
  });
});
