import { describe, expect, it } from 'vitest';
import { buildWebhookTargets } from './webhook-config.service.js';

describe('webhook config service', () => {
  it('builds stable public webhook targets from the configured API URL', () => {
    expect(buildWebhookTargets('https://pm-api.example.com/')).toEqual({
      health: 'https://pm-api.example.com/health',
      twilioSms: 'https://pm-api.example.com/webhooks/twilio/sms',
      twilioWhatsapp: 'https://pm-api.example.com/webhooks/twilio/whatsapp',
      telegram: 'https://pm-api.example.com/chat/webhooks/telegram',
      showmojo: 'https://pm-api.example.com/webhooks/showmojo',
    });
  });
});
