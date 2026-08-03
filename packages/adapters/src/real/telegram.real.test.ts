import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramRealAdapter } from './telegram.real.js';

describe('TelegramRealAdapter', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends plain text so shortlist URLs with underscores cannot fail Markdown parsing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: { message_id: 42 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await new TelegramRealAdapter('token').send({
      to: '123', channel: 'telegram', body: 'http://example.test/shortlist/a_b',
    });

    const request = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(request).not.toHaveProperty('parse_mode');
    expect(request.text).toContain('a_b');
  });

  it('uploads a local listing photo as multipart data for Telegram', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(new Blob(['demo image'], { type: 'image/png' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: { message_id: 43 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await new TelegramRealAdapter('token').sendPhoto(
      '123',
      '/demo-listings/burnaby-heights-loft-410-exterior.png',
      'Burnaby Heights Lofts',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:5173/demo-listings/burnaby-heights-loft-410-exterior.png');
    const upload = fetchMock.mock.calls[1][1];
    expect(upload?.body).toBeInstanceOf(FormData);
    const form = upload?.body as FormData;
    expect(form.get('chat_id')).toBe('123');
    expect(form.get('caption')).toBe('Burnaby Heights Lofts');
    expect(form.get('photo')).toBeInstanceOf(Blob);
  });
});
