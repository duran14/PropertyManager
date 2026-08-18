import { describe, expect, it } from 'vitest';
import {
  ALLOWED_ID_DOCUMENT_MIME_TYPES,
  describeAllowedIdDocumentFormats,
  isAllowedIdDocumentMimeType,
} from './id-document.js';

describe('ALLOWED_ID_DOCUMENT_MIME_TYPES', () => {
  it('contiene exactamente los cuatro tipos permitidos', () => {
    expect([...ALLOWED_ID_DOCUMENT_MIME_TYPES].sort()).toEqual([
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });
});

describe('isAllowedIdDocumentMimeType', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])(
    'acepta %s',
    (mime) => {
      expect(isAllowedIdDocumentMimeType(mime)).toBe(true);
    },
  );

  // Los dos vectores reales del hallazgo Critical que este allowlist cierra.
  it.each(['text/html', 'image/svg+xml'])('rechaza %s', (mime) => {
    expect(isAllowedIdDocumentMimeType(mime)).toBe(false);
  });

  // HEIC es el formato por defecto de iPhone: queda fuera por decisión
  // explícita del spec (Chrome/Firefox en Windows no lo muestran).
  it('rechaza image/heic', () => {
    expect(isAllowedIdDocumentMimeType('image/heic')).toBe(false);
  });

  it('rechaza null y undefined sin lanzar', () => {
    expect(isAllowedIdDocumentMimeType(null)).toBe(false);
    expect(isAllowedIdDocumentMimeType(undefined)).toBe(false);
  });

  // Match exacto: un parámetro extra no debe colarse.
  it('rechaza un tipo con parámetros extra', () => {
    expect(isAllowedIdDocumentMimeType('image/png; charset=x')).toBe(false);
  });
});

describe('describeAllowedIdDocumentFormats', () => {
  it('produce la etiqueta legible en el mismo orden que la allowlist', () => {
    expect(describeAllowedIdDocumentFormats()).toBe('JPEG, PNG, WebP or PDF');
  });

  // Regresión Minor 3 (revisión final): la etiqueta se deriva de la
  // allowlist, así que agregar un tipo a `ALLOWED_ID_DOCUMENT_MIME_TYPES` sin
  // tocar esta función no puede dejar la copy desalineada con el `accept` del
  // formulario — este test la ata al largo actual de la lista, no a un
  // string quemado.
  it('siempre incluye tantos nombres como tipos tenga la allowlist', () => {
    const label = describeAllowedIdDocumentFormats();
    const parts = label.split(', ').flatMap((part) => part.split(' or '));
    expect(parts).toHaveLength(ALLOWED_ID_DOCUMENT_MIME_TYPES.length);
  });
});
