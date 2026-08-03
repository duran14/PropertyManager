import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiFetch, setAccessToken } from '../lib/apiClient';
import type { AuthUser, LoginResponse } from '../lib/types';
import { restoreSession } from './session';

interface AuthContextValue {
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  isRestoring: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isRestoring, setIsRestoring] = useState(true);

  useEffect(() => {
    void restoreSession({
      refresh: () => apiFetch<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),
      getCurrentUser: () => apiFetch<AuthUser>('/auth/me'),
      setAccessToken,
    }).then((restoredUser) => {
      setUser(restoredUser);
      setIsRestoring(false);
    });
  }, []);

  async function login(email: string, password: string): Promise<void> {
    const res = await apiFetch<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setAccessToken(res.accessToken);
    setUser(res.user);
  }

  async function logout(): Promise<void> {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    setAccessToken(null);
    setUser(null);
  }

  return <AuthContext.Provider value={{ user, login, logout, isRestoring }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return ctx;
}
