import type { DataMode } from '@gitnostics/shared';

export interface Session {
  csrfToken: string;
  authenticated: boolean;
  requiresLogin: boolean;
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
  if (!response.ok)
    throw new Error(
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${response.status})`,
    );
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
