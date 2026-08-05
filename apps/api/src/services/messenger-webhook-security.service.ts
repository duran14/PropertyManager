import { createHmac, timingSafeEqual } from 'node:crypto';

interface ValidateMessengerWebhookSignatureInput {
  appSecret: string;
  rawBody: Buffer;
  signatureHeader: string | undefined;
}

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Meta firma el body crudo del webhook (no los campos re-serializados) con
 * HMAC-SHA256 usando el App Secret. A diferencia de Twilio, que firma sobre
 * los parámetros del form, aquí el buffer exacto que llegó por HTTP importa
 * — ver el middleware `verify` de `express.json()` en `app.ts` que lo captura.
 */
export function validateMessengerWebhookSignature(
  input: ValidateMessengerWebhookSignatureInput,
): boolean {
  if (!input.appSecret || !input.signatureHeader) {
    return false;
  }
  if (!input.signatureHeader.startsWith(SIGNATURE_PREFIX)) {
    return false;
  }

  const suppliedHex = input.signatureHeader.slice(SIGNATURE_PREFIX.length);
  const expected = createHmac('sha256', input.appSecret).update(input.rawBody).digest();

  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedHex, 'hex');
  } catch {
    return false;
  }

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
