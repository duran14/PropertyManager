import { describe, expect, it } from 'vitest';
import { extractTextFromDocumentUpload } from './document-extraction.service.js';

describe('document extraction service', () => {
  it('extracts text from text-like uploads automatically', () => {
    const fileBase64 = Buffer.from('Cats are considered. Dogs require review.').toString('base64');

    expect(
      extractTextFromDocumentUpload({
        mimeType: 'text/plain',
        fileBase64,
        providedTextContent: null,
      }),
    ).toEqual({
      textContent: 'Cats are considered. Dogs require review.',
      extractionStatus: 'completed',
    });
  });

  it('keeps binary documents pending for OCR when no text was provided', () => {
    expect(
      extractTextFromDocumentUpload({
        mimeType: 'application/pdf',
        fileBase64: 'JVBERi0xLjQ=',
        providedTextContent: null,
      }),
    ).toEqual({
      textContent: null,
      extractionStatus: 'pending',
    });
  });
});
