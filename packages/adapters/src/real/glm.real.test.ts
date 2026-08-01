import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlmRealAdapter } from './glm.real.js';

describe('GlmRealAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('retries a transient overloaded response before returning the completion', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { code: '1305', message: 'The service may be temporarily overloaded' } }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ choices: [{ message: { content: '{"reply":"Hi!","next_state":"greeting"}' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = new GlmRealAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://api.z.ai/api/paas/v4',
      reasoningModel: 'glm-4.7-flash',
      ocrModel: 'glm-ocr',
    });

    await expect(adapter.reason({
      systemPrompt: 'Greet the user.',
      userPrompt: '/start',
      responseSchema: {
        type: 'object',
        properties: {
          reply: { type: 'string' },
          next_state: { type: 'string' },
        },
        required: ['reply', 'next_state'],
      },
    })).resolves.toEqual({
      content: '{"reply":"Hi!","next_state":"greeting"}',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(requestBody.thinking).toEqual({ type: 'disabled' });
    expect(requestBody.max_tokens).toBe(350);
    expect(requestBody.response_format).toEqual({ type: 'json_object' });
  });
});
