// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSettings, type Dashboard } from '@gitnostics/shared';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('releases drawer focus and scroll locks when the workspace becomes a sign-in screen', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
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
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () =>
        url.startsWith('/api/dashboard')
          ? data
          : { csrfToken: 'local-csrf', requiresLogin: true, authenticated: true },
    })),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: /Good diagnostics start/ });
  fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
  expect(document.body.style.overflow).toBe('hidden');
  expect(screen.getByRole('dialog', { name: 'Main navigation' })).toBeTruthy();
  await act(async () => {
    client.setQueriesData(
      { queryKey: ['session'] },
      { csrfToken: 'new-csrf', requiresLogin: true, authenticated: false },
    );
  });
  await screen.findByRole('heading', { name: 'Unlock your workspace' });
  expect(document.body.style.overflow).toBe('');
  screen.getByLabelText('Operator token').focus();
  const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  document.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  await act(async () => {
    client.setQueriesData(
      { queryKey: ['session'] },
      { csrfToken: 'signed-in-csrf', requiresLogin: true, authenticated: true },
    );
  });
  await screen.findByRole('heading', { name: /Good diagnostics start/ });
  expect(
    screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded'),
  ).toBe('false');
  expect(screen.queryByRole('dialog', { name: 'Main navigation' })).toBeNull();
  rendered.unmount();
  client.clear();
});
