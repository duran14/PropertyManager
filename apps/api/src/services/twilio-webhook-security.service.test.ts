import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildTwilioWebhookUrl,
  claimTwilioMessage,
  completeTwilioMessage,
  failTwilioMessage,
  validateTwilioWebhookSignature,
} from './twilio-webhook-security.service.js';
import { prisma } from '../config/db.js';

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

  it('distinguishes processing, completed, and failed provider messages', async () => {
    const tenantId = 'tenant_test_twilio_security';
    const messageSid = 'SM-security-test';
    await prisma.tenant.upsert({
      where: { id: tenantId },
      update: {},
      create: { id: tenantId, name: 'Twilio Security Test', province: 'BC' },
    });
    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });

    const firstClaim = await claimTwilioMessage(tenantId, messageSid);
    expect(firstClaim.state).toBe('acquired');
    if (firstClaim.state !== 'acquired') throw new Error('Expected first claim to be acquired');
    expect(firstClaim.claimToken).toBeTruthy();
    await expect(claimTwilioMessage(tenantId, messageSid)).resolves.toEqual({ state: 'processing' });

    await completeTwilioMessage(tenantId, messageSid, firstClaim.claimToken);
    await expect(claimTwilioMessage(tenantId, messageSid)).resolves.toEqual({ state: 'completed' });

    const failedSid = `${messageSid}-failed`;
    const failedClaim = await claimTwilioMessage(tenantId, failedSid);
    expect(failedClaim.state).toBe('acquired');
    if (failedClaim.state !== 'acquired') throw new Error('Expected failed claim to be acquired first');
    await failTwilioMessage(tenantId, failedSid, failedClaim.claimToken);
    await expect(claimTwilioMessage(tenantId, failedSid)).resolves.toEqual({ state: 'failed' });

    await prisma.webhookReceipt.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  });
});
