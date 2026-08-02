import type { AuthUser } from '../lib/types';

export async function restoreSession(input: {
  refresh: () => Promise<{ accessToken: string }>;
  getCurrentUser: () => Promise<AuthUser>;
  setAccessToken: (token: string | null) => void;
}): Promise<AuthUser | null> {
  try {
    const { accessToken } = await input.refresh();
    input.setAccessToken(accessToken);
    return await input.getCurrentUser();
  } catch {
    input.setAccessToken(null);
    return null;
  }
}
