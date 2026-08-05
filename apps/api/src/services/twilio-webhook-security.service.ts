import { createHmac, timingSafeEqual } from 'node:crypto';

interface ValidateTwilioWebhookSignatureInput {
  authToken: string;
  url: string;
  body: Record<string, unknown>;
  signature: string;
}

export function buildTwilioWebhookUrl(apiUrl: string, originalUrl: string): string {
  return new URL(originalUrl, ensureTrailingSlash(apiUrl)).toString();
}

export function validateTwilioWebhookSignature(
  input: ValidateTwilioWebhookSignatureInput,
): boolean {
  if (!input.authToken || !input.signature) {
    return false;
  }

  const payload = Object.keys(input.body)
    .sort()
    .reduce((value, key) => value + key + toTwilioParameterValue(input.body[key]), input.url);
  const expected = createHmac('sha1', input.authToken).update(payload, 'utf8').digest();

  let supplied: Buffer;
  try {
    supplied = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }

  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function toTwilioParameterValue(value: unknown): string {
  if (Array.isArray(value)) {
    return [...value].map(String).sort().join('');
  }
  return typeof value === 'string' ? value : String(value ?? '');
}
