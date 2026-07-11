import { describe, expect, it } from 'vitest';
import {
  getConversationExternalId,
  getReplyAddressFromConversation,
} from './chatbot.service.js';

describe('chatbot conversation identity', () => {
  it('keeps SMS and WhatsApp conversations separate for the same phone number', () => {
    const phone = '+16045551792';

    expect(getConversationExternalId({ channel: 'sms', from: phone })).toBe('sms:+16045551792');
    expect(getConversationExternalId({ channel: 'whatsapp', from: phone })).toBe('whatsapp:+16045551792');
  });

  it('strips channel prefixes before sending replies', () => {
    expect(getReplyAddressFromConversation('sms:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('whatsapp:+16045551792')).toBe('+16045551792');
    expect(getReplyAddressFromConversation('telegram:12345')).toBe('12345');
    expect(getReplyAddressFromConversation('web_session_1')).toBe('web_session_1');
  });
});
