import { describe, expect, it, vi } from 'vitest';
import { ResendEmailAdapter } from './resend-email.real.js';

describe('ResendEmailAdapter', () => {
  it('sends a prospect notification through Resend', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email_123' }), { status: 200 }));
    const adapter = new ResendEmailAdapter({
      apiKey: 're_test',
      from: 'Pacific Ridge <showings@example.ca>',
      fetcher,
    });

    await expect(adapter.send({
      to: 'miguel@example.ca',
      channel: 'email',
      body: 'Your tour is confirmed.',
    })).resolves.toEqual({ messageId: 'email_123' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
