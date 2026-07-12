export type DocumentCategory =
  | 'logo'
  | 'pricing'
  | 'policy'
  | 'compliance'
  | 'property'
  | 'unit'
  | 'other';

export type DocumentEntityType = 'tenant' | 'property' | 'unit' | 'lead';

export interface DocumentUploadInput {
  filename: string;
  mimeType: string;
  category: DocumentCategory;
  entityType?: DocumentEntityType;
  entityId?: string | null;
  description?: string | null;
  textContent?: string | null;
  storageUrl?: string | null;
  fileBase64?: string | null;
}

export function normalizeDocumentUpload(input: DocumentUploadInput) {
  return {
    filename: input.filename.trim(),
    mimeType: input.mimeType.trim().toLowerCase(),
    category: input.category,
    entityType: input.entityType ?? 'tenant',
    entityId: input.entityId?.trim() || null,
    description: input.description?.trim() || null,
    textContent: input.textContent?.trim() || null,
    storageUrl: input.storageUrl?.trim() || null,
    fileBase64: input.fileBase64?.trim() || null,
  };
}
