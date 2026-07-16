import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '@property-manager/config';
import { describe, expect, it } from 'vitest';

const apiSrc = join(process.cwd(), 'src');

describe('Twilio shared channel routing', () => {
  it('exposes explicit SMS and WhatsApp webhook entry points through the messaging adapters', () => {
    const webhooksSource = readFileSync(join(apiSrc, 'routes/webhooks.ts'), 'utf8');
    const appSource = readFileSync(join(apiSrc, 'app.ts'), 'utf8');
    const envSource = readFileSync(
      new URL('../../../../packages/config/src/env.ts', import.meta.url),
      'utf8',
    );

    expect(envSource).toContain('TWILIO_DEFAULT_TENANT_ID');
    expect(envSource).toContain('TWILIO_SMS_FROM');
    expect(webhooksSource).toContain("'/twilio/sms'");
    expect(webhooksSource).toContain("'/twilio/whatsapp'");
    expect(webhooksSource).toContain('parseWebhook');
    expect(webhooksSource).toContain('TWILIO_DEFAULT_TENANT_ID');
    expect(webhooksSource).toContain('From and Body are required');
    expect(webhooksSource).toContain('sendTwilioWebhookAccepted');
    expect(webhooksSource).toContain('validateTwilioWebhookSignature');
    expect(webhooksSource).toContain('claimTwilioMessage');
    expect(webhooksSource).toContain('completeTwilioMessage');
    expect(webhooksSource).toContain('failTwilioMessage');
    expect(webhooksSource).toContain('x-twilio-signature');
    expect(webhooksSource).toContain('<Response></Response>');
    expect(webhooksSource).toContain('text/xml');
    expect(appSource).toContain('express.urlencoded');
  });

  it('uses the demo tenant when the shared Twilio tenant setting is blank', () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://pm_dev:pm_dev_password@localhost:5433/property_manager?schema=public',
      REDIS_URL: 'redis://localhost:6380',
      API_URL: 'http://localhost:4000',
      WEB_URL: 'http://localhost:5173',
      JWT_ACCESS_SECRET: 'change-me-access-secret',
      JWT_REFRESH_SECRET: 'change-me-refresh-secret',
      INTEGRATION_ENCRYPTION_KEY: 'change-me-32-byte-encryption-key',
      TWILIO_DEFAULT_TENANT_ID: '',
    });

    expect(env.TWILIO_DEFAULT_TENANT_ID).toBe('tenant_demo_pm');
  });
});
