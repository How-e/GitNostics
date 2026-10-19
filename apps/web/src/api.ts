import type { DataMode } from '@gitnostics/shared';

export interface Session {
  csrfToken: string;
  authenticated: boolean;
  requiresLogin: boolean;
}
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
const sessionErrorListeners = new Set<() => void>();
export function onSessionError(listener: () => void) {
  sessionErrorListeners.add(listener);
  return () => {
    sessionErrorListeners.delete(listener);
  };
}
let csrfToken = '';
export function setCsrfToken(token: string) {
  csrfToken = token;
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; mode?: DataMode; signal?: AbortSignal } = {},
): Promise<T> {
  const url = options.mode ? `${path}${path.includes('?') ? '&' : '?'}mode=${options.mode}` : path;
  const response = await fetch(url, {
    credentials: 'same-origin',
    signal: options.signal,
    method: options.method ?? 'GET',
    headers:
      options.body !== undefined
        ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken }
        : undefined,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new ApiError(
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status})`,
      response.status,
    );
    if (
      (error.status === 401 && path !== '/api/login') ||
      (error.status === 403 && error.message === 'Invalid CSRF token. Reload and try again.')
    ) {
      for (const listener of sessionErrorListeners) listener();
    }
    throw error;
  }
  return data as T;
}

export function readMode(): DataMode {
  try {
    return localStorage.getItem('gitnostics.mode') === 'demo' ? 'demo' : 'live';
  } catch {
    return 'live';
  }
}
export function rememberMode(mode: DataMode) {
  try {
    localStorage.setItem('gitnostics.mode', mode);
  } catch {
    /* Storage can be disabled by the browser. */
  }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The operation could not be completed.';
}
