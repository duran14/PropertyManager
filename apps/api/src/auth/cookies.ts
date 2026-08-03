export function refreshCookieOptions(nodeEnv: 'development' | 'test' | 'production') {
  return {
    httpOnly: true,
    secure: nodeEnv === 'production',
    sameSite: 'strict' as const,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}
