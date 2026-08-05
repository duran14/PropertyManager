import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiSrc = join(process.cwd(), 'src');

describe('chat channel lead sources', () => {
  it('keeps SMS and WhatsApp as distinct lead sources', () => {
    const chatbotSource = readFileSync(join(apiSrc, 'services/chatbot.service.ts'), 'utf8');

    expect(chatbotSource).toContain("sms: 'sms',");
    expect(chatbotSource).toContain("whatsapp: 'whatsapp',");
  });
});
