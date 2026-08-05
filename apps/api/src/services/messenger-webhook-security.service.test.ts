import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateMessengerWebhookSignature } from './messenger-webhook-security.service.js';

function sign(rawBody: Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}

describe('Messenger webhook signature', () => {
  it('accepts a valid signature over the raw body', () => {
    const appSecret = 'messenger-test-secret';
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }), 'utf8');
    const signatureHeader = sign(rawBody, appSecret);

    expect(validateMessengerWebhookSignature({ appSecret, rawBody, signatureHeader })).toBe(true);
  });

  it('rejects a signature computed over a different body', () => {
    const appSecret = 'messenger-test-secret';
    const rawBody = Buffer.from(JSON.stringify({ entry: [] }), 'utf8');
    const tamperedBody = Buffer.from(JSON.stringify({ entry: [{ tampered: true }] }), 'utf8');
    const signatureHeader = sign(rawBody, appSecret);

    expect(validateMessengerWebhookSignature({ appSecret, rawBody: tamperedBody, signatureHeader })).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    expect(validateMessengerWebhookSignature({ appSecret: 'secret', rawBody, signatureHeader: undefined })).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    expect(validateMessengerWebhookSignature({ appSecret: 'secret', rawBody, signatureHeader: 'deadbeef' })).toBe(false);
  });

  it('rejects when no app secret is configured', () => {
    const rawBody = Buffer.from('{}', 'utf8');
    const signatureHeader = sign(rawBody, 'irrelevant');
    expect(validateMessengerWebhookSignature({ appSecret: '', rawBody, signatureHeader })).toBe(false);
  });
});
