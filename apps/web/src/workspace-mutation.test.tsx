// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  type ActionPreview,
  type Dashboard,
  type DataMode,
} from '@gitnostics/shared';
import { demoSnapshots } from '../../server/src/demo';
import { App } from './App';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

function dashboard(mode: DataMode): Dashboard {
  return {
    mode,
    repositories: demoSnapshots().map((snapshot) => ({
      mode,
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
}

describe('workspace mutation lifetime', () => {
  it('ignores a delayed demo preview after returning to the live workspace', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    vi.stubGlobal('scrollTo', () => {});
    localStorage.setItem('gitnostics.mode', 'demo');
    let finishPreview!: (response: Response) => void;
    const transport = vi.fn(async (input: string) => {
      if (input === '/api/session')
        return Response.json({ csrfToken: 'fixture', authenticated: true, requiresLogin: false });
      if (input.startsWith('/api/dashboard'))
        return Response.json(dashboard(input.includes('mode=demo') ? 'demo' : 'live'));
      if (input.startsWith('/api/actions/preview'))
        return new Promise<Response>((resolve) => {
          finishPreview = resolve;
        });
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
    await waitFor(() => expect(finishPreview).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: /Return to live/ }));
    await waitFor(() => expect(screen.queryByText('Demo workspace.')).toBeNull());
    const preview: ActionPreview = {
      id: 'demo-preview',
      mode: 'demo',
      title: 'Old demo preview',
      request: { repository: 'northstar/api', kind: 'rerun_failed', runId: 1000 },
      impact: ['Fixture only'],
      destructive: false,
      allowed: true,
      confirmation: 'confirm fixture',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await act(async () => {
      finishPreview(Response.json(preview));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('Impact preview ready')).toBeNull();
    client.clear();
  });
});
