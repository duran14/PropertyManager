import { describe, expect, it, vi } from 'vitest';
import { restoreSession } from './session';

describe('restoreSession', () => {
  it('restores the authenticated user from the refresh cookie', async () => {
    const setAccessToken = vi.fn();
    const user = {
      id: 'broker-1',
      email: 'broker@pacificridge.ca',
      firstName: 'Marcus',
      lastName: 'Beaulieu',
      role: 'broker' as const,
      tenantId: 'tenant-1',
      tenantName: 'Pacific Ridge',
    };

    await expect(restoreSession({
      refresh: async () => ({ accessToken: 'refreshed-token' }),
      getCurrentUser: async () => user,
      setAccessToken,
    })).resolves.toEqual(user);
    expect(setAccessToken).toHaveBeenCalledWith('refreshed-token');
  });

  it('clears the in-memory token when the refresh cookie is unavailable', async () => {
    const setAccessToken = vi.fn();

    await expect(restoreSession({
      refresh: async () => { throw new Error('Refresh token required'); },
      getCurrentUser: async () => { throw new Error('not reached'); },
      setAccessToken,
    })).resolves.toBeNull();
    expect(setAccessToken).toHaveBeenCalledWith(null);
  });
});
