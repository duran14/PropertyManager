import { describe, expect, it } from 'vitest';
import { refreshCookieOptions } from './cookies.js';

describe('refreshCookieOptions', () => {
  it('makes the refresh cookie available through the frontend API proxy', () => {
    expect(refreshCookieOptions('development')).toMatchObject({
      httpOnly: true,
      path: '/',
      sameSite: 'strict',
      secure: false,
    });
  });
});
