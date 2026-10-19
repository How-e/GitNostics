// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type Dashboard } from '@gitnostics/shared';
import { App } from './App';

const data: Dashboard = {
  mode: 'live',
  repositories: [],
  findings: [],
  activity: [],
  incidents: [],
  notifications: [],
  settings: defaultSettings,
  connection: { mode: 'public', connected: true, identity: 'Public', writesEnabled: false },
  storageHistory: [],
  workflowAnalytics: [],
};
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function view() {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>
  );
}
function mockServer(initiallyAuthenticated: boolean, failureStatus = 401) {
  let authenticated = initiallyAuthenticated;
  let expired = false;
  let csrf = 'initial-csrf';
  let sessionReads = 0;
  const calls: { path: string; method: string; csrf: string | undefined }[] = [];
  const fetch = vi.fn().mockImplementation(async (path: string, options: RequestInit = {}) => {
    const method = options.method ?? 'GET';
    const token = (options.headers as Record<string, string> | undefined)?.['x-csrf-token'];
    calls.push({ path, method, csrf: token });
    let result: unknown;
    let status = 200;
    if (path === '/api/session') {
      sessionReads += 1;
      if (expired) {
        authenticated = false;
        expired = false;
      }
      csrf = `csrf-${sessionReads}`;
      result = { authenticated, requiresLogin: true, csrfToken: csrf };
    } else if (path === '/api/login') {
      if (token !== csrf) {
        status = 403;
        result = { error: 'Invalid CSRF token. Reload and try again.' };
      } else {
        authenticated = true;
        result = { csrfToken: 'signed-in-csrf' };
      }
    } else if (path === '/api/logout') {
      if (token !== csrf) {
        status = 403;
        result = { error: 'Invalid CSRF token. Reload and try again.' };
      } else {
        authenticated = false;
        result = { ok: true };
      }
    } else if (path.startsWith('/api/dashboard')) {
      if (expired) {
        status = 401;
        result = { error: 'Operator sign-in required.' };
      } else result = data;
    } else if (path.startsWith('/api/settings')) {
      if (expired) {
        status = failureStatus;
        result = {
          error:
            failureStatus === 401
              ? 'Operator sign-in required.'
              : 'Invalid CSRF token. Reload and try again.',
        };
      } else result = { ok: true };
    } else throw new Error(`Unexpected local test request: ${path}`);
    return { ok: status < 400, status, json: async () => result };
  });
  vi.stubGlobal('fetch', fetch);
  return {
    calls,
    expire: () => {
      expired = true;
    },
  };
}
describe('session recovery', () => {
  it.each([401, 403])(
    'clears cached workspace data after a %s write failure without replaying the write',
    async (status) => {
      const server = mockServer(true, status);
      render(view());
      await screen.findByRole('heading', { name: /Good diagnostics start/ });
      expect(client.getQueriesData({ queryKey: ['dashboard'] }).length).toBe(1);
      server.expire();
      fireEvent.click(screen.getByRole('button', { name: 'Use light theme' }));
      await screen.findByRole('heading', { name: 'Unlock your workspace' });
      expect(
        client
          .getQueriesData({ queryKey: ['dashboard'] })
          .every(([, value]) => value === undefined),
      ).toBe(true);
      expect(server.calls.filter((call) => call.path.startsWith('/api/settings'))).toHaveLength(1);
      expect(screen.queryByRole('heading', { name: /Good diagnostics start/ })).toBeNull();
    },
  );

  it('recovers a dashboard authorization failure into the sign-in screen', async () => {
    const server = mockServer(true);
    render(view());
    await screen.findByRole('heading', { name: /Good diagnostics start/ });
    server.expire();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh local view' }));
    await screen.findByRole('heading', { name: 'Unlock your workspace' });
    expect(
      client.getQueriesData({ queryKey: ['dashboard'] }).every(([, value]) => value === undefined),
    ).toBe(true);
  });

  it('obtains a fresh anonymous CSRF session before submitting a login after idle expiry', async () => {
    const server = mockServer(false);
    render(view());
    await screen.findByRole('heading', { name: 'Unlock your workspace' });
    server.expire();
    fireEvent.change(screen.getByLabelText('Operator token'), {
      target: { value: 'local-test-operator' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('heading', { name: /Good diagnostics start/ });
    expect(server.calls.find((call) => call.path === '/api/login')).toMatchObject({
      csrf: 'csrf-2',
    });
    expect(server.calls.filter((call) => call.path === '/api/login')).toHaveLength(1);
  });

  it('refreshes logout CSRF and removes workspace caches before displaying sign-in', async () => {
    const server = mockServer(true);
    render(view());
    await screen.findByRole('heading', { name: /Good diagnostics start/ });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await screen.findByRole('heading', { name: 'Unlock your workspace' });
    expect(server.calls.find((call) => call.path === '/api/logout')).toMatchObject({
      csrf: 'csrf-2',
    });
    await waitFor(() =>
      expect(
        client
          .getQueriesData({ queryKey: ['dashboard'] })
          .every(([, value]) => value === undefined),
      ).toBe(true),
    );
  });
});
