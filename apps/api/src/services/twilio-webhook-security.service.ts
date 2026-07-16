import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { prisma } from '../config/db.js';
import { withTenant } from '../config/tenant-context.js';

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

export type TwilioMessageClaim =
  | { state: 'acquired'; claimToken: string }
  | { state: 'processing' }
  | { state: 'completed' }
  | { state: 'failed' };

export async function claimTwilioMessage(
  tenantId: string,
  messageSid: string,
): Promise<TwilioMessageClaim> {
  return withTenant(prisma, tenantId, async (tx) => {
    const claimToken = randomUUID();
    const result = await tx.webhookReceipt.createMany({
      data: [{ tenantId, provider: 'twilio', providerMessageId: messageSid, claimToken }],
      skipDuplicates: true,
    });
    if (result.count === 1) {
      return { state: 'acquired', claimToken };
    }

    const receipt = await tx.webhookReceipt.findUniqueOrThrow({
      where: {
        tenantId_provider_providerMessageId: {
          tenantId,
          provider: 'twilio',
          providerMessageId: messageSid,
        },
      },
    });
    if (receipt.status === 'completed') return { state: 'completed' };
    if (receipt.status === 'failed') return { state: 'failed' };
    return { state: 'processing' };
  });
}

export async function failTwilioMessage(
  tenantId: string,
  messageSid: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider: 'twilio', providerMessageId: messageSid, status: 'processing', claimToken },
    data: { status: 'failed' },
  }));
}

export async function completeTwilioMessage(
  tenantId: string,
  messageSid: string,
  claimToken: string,
): Promise<void> {
  await withTenant(prisma, tenantId, (tx) => tx.webhookReceipt.updateMany({
    where: { tenantId, provider: 'twilio', providerMessageId: messageSid, status: 'processing', claimToken },
    data: { status: 'completed' },
  }));
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
