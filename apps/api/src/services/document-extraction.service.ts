import { decodeBase64Payload } from './document-storage.service.js';

export type DocumentExtractionStatus = 'completed' | 'pending' | 'failed';

export function extractTextFromDocumentUpload(input: {
  mimeType: string;
  fileBase64?: string | null;
  providedTextContent?: string | null;
}): { textContent: string | null; extractionStatus: DocumentExtractionStatus } {
  const provided = input.providedTextContent?.trim();
  if (provided) {
    return { textContent: provided, extractionStatus: 'completed' };
  }

  if (!input.fileBase64) {
    return { textContent: null, extractionStatus: 'pending' };
  }

  if (isTextLikeMime(input.mimeType)) {
    const decoded = decodeBase64Payload(input.fileBase64).toString('utf8').trim();
    return {
      textContent: decoded || null,
      extractionStatus: decoded ? 'completed' : 'failed',
    };
  }

  return { textContent: null, extractionStatus: 'pending' };
}

function isTextLikeMime(mimeType: string): boolean {
  const normalized = mimeType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('csv') ||
    normalized.includes('markdown')
  );
}
