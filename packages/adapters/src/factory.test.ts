import { describe, expect, it } from 'vitest';
import { createAdapters } from './factory.js';
import { TwilioMockAdapter } from './mocks/twilio.mock.js';
import { TwilioRealAdapter } from './real/twilio.real.js';
import type { Env } from '@property-manager/config';

const baseEnv: Env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  DATABASE_URL: 'postgresql://pm_dev:pm_dev_password@localhost:5433/property_manager?schema=public',
  REDIS_URL: 'redis://localhost:6380',
  API_PORT: 4000,
  API_URL: 'http://localhost:4000',
  WEB_URL: 'http://localhost:5173',
  JWT_ACCESS_SECRET: 'change-me-access-secret',
  JWT_REFRESH_SECRET: 'change-me-refresh-secret',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '7d',
  INTEGRATION_ENCRYPTION_KEY: 'change-me-32-byte-encryption-key',
  ZAI_API_KEY: '',
  ZAI_BASE_URL: 'https://api.z.ai/api/paas/v4',
  GLM_REASONING_MODEL: 'glm-5.2',
  GLM_OCR_MODEL: 'glm-ocr',
  BUILDIUM_CLIENT_ID: '',
  BUILDIUM_CLIENT_SECRET: '',
  QBO_CLIENT_ID: '',
  QBO_CLIENT_SECRET: '',
  QBO_ENVIRONMENT: 'sandbox',
  TWILIO_ACCOUNT_SID: '',
  TWILIO_AUTH_TOKEN: '',
  TWILIO_SMS_FROM: '',
  TWILIO_WHATSAPP_FROM: '',
  TWILIO_DEFAULT_TENANT_ID: 'tenant_demo_pm',
  PLAID_CLIENT_ID: '',
  PLAID_SECRET: '',
  PLAID_ENV: 'sandbox',
  STRIPE_SECRET_KEY: '',
  AUTOENHANCE_API_KEY: '',
  AUTOENHANCE_BASE_URL: 'https://api.autoenhance.ai/v1',
  SHOWMOJO_API_TOKEN: '',
  DOCUSIGN_INTEGRATION_KEY: '',
  DOCUSIGN_USER_ID: '',
  DOCUSIGN_BASE_PATH: 'https://demo.docusign.net/restapi',
  TELEGRAM_BOT_TOKEN: '',
  TELEGRAM_DEFAULT_TENANT_ID: 'tenant_demo_pm',
  DEFAULT_CONFIDENCE_THRESHOLD: 0.85,
};

describe('createAdapters', () => {
  it('uses Twilio mock messaging when Twilio credentials are not configured', () => {
    const adapters = createAdapters(baseEnv);

    expect(adapters.twilio).toBeInstanceOf(TwilioMockAdapter);
    expect(adapters.mockModes.twilio).toBe(true);
  });

  it('uses Twilio real messaging when Twilio credentials are configured', () => {
    const adapters = createAdapters({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
      TWILIO_SMS_FROM: '+16045550000',
      TWILIO_WHATSAPP_FROM: '+16045550001',
    });

    expect(adapters.twilio).toBeInstanceOf(TwilioRealAdapter);
    expect(adapters.mockModes.twilio).toBe(false);
  });

  it('fails fast when sending through real SMS without a configured sender', async () => {
    const adapters = createAdapters({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
    });

    await expect(adapters.messaging.sms.send({
      to: '+16045551234',
      body: 'Hello',
      channel: 'sms',
    })).rejects.toThrow('TWILIO_SMS_FROM is required for real Twilio sms sending');
  });

  it('fails fast when sending through real WhatsApp without a configured sender', async () => {
    const adapters = createAdapters({
      ...baseEnv,
      TWILIO_ACCOUNT_SID: 'AC123',
      TWILIO_AUTH_TOKEN: 'secret',
    });

    await expect(adapters.messaging.whatsapp.send({
      to: '+16045551234',
      body: 'Hello',
      channel: 'whatsapp',
    })).rejects.toThrow('TWILIO_WHATSAPP_FROM is required for real Twilio whatsapp sending');
  });
});
