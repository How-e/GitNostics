// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings, type ActionPreview, type Dashboard } from '@gitnostics/shared';
import { demoSnapshots } from '../../server/src/demo';
import { App } from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe('action confirmation feedback', () => {
  it('announces failed execution inside the open modal', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal('scrollTo', () => {});
    localStorage.setItem('gitnostics.mode', 'demo');
    const data: Dashboard = {
      mode: 'demo',
      repositories: demoSnapshots().map((snapshot) => ({
        mode: 'demo',
        fullName: snapshot.fullName,
        favorite: false,
        selected: true,
        syncedAt: null,
        syncStatus: 'idle',
        error: null,
        snapshot,
      })),
      findings: [],
      activity: [],
      incidents: [],
      notifications: [],
      storageHistory: [],
      workflowAnalytics: [],
      settings: defaultSettings,
      connection: { mode: 'public', connected: true, writesEnabled: false, identity: 'Fixture' },
    };
    const preview: ActionPreview = {
      id: 'fixture-preview',
      mode: 'demo',
      title: 'Fixture preview',
      request: { repository: 'northstar/api', kind: 'rerun_failed', runId: 1000 },
      impact: ['Fixture only'],
      destructive: false,
      allowed: true,
      confirmation: 'confirm fixture',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const transport = vi.fn(async (input: string) => {
      if (input === '/api/session')
        return Response.json({ csrfToken: 'fixture', authenticated: true, requiresLogin: false });
      if (input.startsWith('/api/dashboard')) return Response.json(data);
      if (input.startsWith('/api/actions/preview')) return Response.json(preview);
      if (input.startsWith('/api/actions/execute'))
        return Response.json({ error: 'Fixture rejection' }, { status: 409 });
      throw new Error(`Unexpected fixture request: ${input}`);
    });
    vi.stubGlobal('fetch', transport);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/safe-actions']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('Workflow run'), { target: { value: '1000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview operation' }));
    const modal = within(await screen.findByRole('dialog'));
    fireEvent.change(modal.getByLabelText('Action confirmation'), {
      target: { value: preview.confirmation },
    });
    fireEvent.click(modal.getByRole('button', { name: 'Simulate action' }));
    expect((await modal.findByRole('alert')).textContent).toContain(
      'The operation could not be completed.',
    );
    expect(modal.getByRole('button', { name: 'Simulate action' }).hasAttribute('disabled')).toBe(
      false,
    );
    client.clear();
  });
});
