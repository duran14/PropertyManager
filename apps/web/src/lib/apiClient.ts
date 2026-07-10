/**
 * Base HTTP client for the API.
 *
 * In development, calls go to /api/* and Vite proxies them to localhost:4000.
 * The access token stays in memory instead of localStorage to reduce XSS risk.
 */

const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  tenantId?: string,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  if (tenantId) {
    headers['x-tenant-id'] = tenantId;
  }

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: 'include' });

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? 'Network error', data?.details);
  }
  return data as T;
}
