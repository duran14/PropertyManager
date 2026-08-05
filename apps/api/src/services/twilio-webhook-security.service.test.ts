import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildTwilioWebhookUrl,
  validateTwilioWebhookSignature,
} from './twilio-webhook-security.service.js';

function sign(url: string, params: Record<string, string>, authToken: string): string {
  const payload = Object.keys(params)
    .sort()
    .reduce((value, key) => value + key + params[key], url);
  return createHmac('sha1', authToken).update(payload, 'utf8').digest('base64');
}

describe('Twilio webhook security', () => {
  it('accepts a valid signature and rejects a tampered payload', () => {
    const authToken = 'twilio-test-token';
    const url = 'https://pm-api.example.com/webhooks/twilio/sms';
    const body = {
      Body: 'Hello',
      From: '+16045550123',
      MessageSid: 'SM123',
      To: '+16045550576',
    };
    const signature = sign(url, body, authToken);

    expect(validateTwilioWebhookSignature({ authToken, url, body, signature })).toBe(true);
    expect(
      validateTwilioWebhookSignature({
        authToken,
        url,
        body: { ...body, Body: 'Tampered' },
        signature,
      }),
    ).toBe(false);
  });

  it('builds the externally configured callback URL including its query string', () => {
    expect(
      buildTwilioWebhookUrl('https://pm-api.example.com/', '/webhooks/twilio/sms?tenant=demo'),
    ).toBe('https://pm-api.example.com/webhooks/twilio/sms?tenant=demo');
  });
});
