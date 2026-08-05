import { describe, expect, it } from 'vitest';
import { extractMessengerTextMessage } from './messenger-payload.js';

function textPayload(senderId: string, mid: string, text: string) {
  return {
    entry: [{ messaging: [{ sender: { id: senderId }, message: { mid, text } }] }],
  };
}

describe('extractMessengerTextMessage', () => {
  it('extracts sender, mid, and text from a normal text message', () => {
    expect(extractMessengerTextMessage(textPayload('psid-1', 'mid-1', 'Hola, ¿tienen disponibilidad?'))).toEqual({
      senderId: 'psid-1',
      mid: 'mid-1',
      text: 'Hola, ¿tienen disponibilidad?',
    });
  });

  it('ignores an echo of the Page\'s own message', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'hi', is_echo: true } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('ignores a message without text (e.g. an attachment)', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', attachments: [{ type: 'image' }] } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('ignores a postback event (no message field at all)', () => {
    const payload = {
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, postback: { payload: 'GET_STARTED' } }] }],
    };
    expect(extractMessengerTextMessage(payload)).toBeNull();
  });

  it('picks the first valid text message when multiple entries are present', () => {
    const payload = {
      entry: [
        { messaging: [{ sender: { id: 'psid-1' }, message: { mid: 'mid-1', text: 'first' } }] },
        { messaging: [{ sender: { id: 'psid-2' }, message: { mid: 'mid-2', text: 'second' } }] },
      ],
    };
    expect(extractMessengerTextMessage(payload)).toEqual({ senderId: 'psid-1', mid: 'mid-1', text: 'first' });
  });

  it('returns null for a malformed or empty payload', () => {
    expect(extractMessengerTextMessage({})).toBeNull();
    expect(extractMessengerTextMessage(null)).toBeNull();
    expect(extractMessengerTextMessage('not an object')).toBeNull();
    expect(extractMessengerTextMessage({ entry: [] })).toBeNull();
  });
});
