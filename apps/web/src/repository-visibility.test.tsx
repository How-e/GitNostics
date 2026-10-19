// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSettings,
  type Dashboard,
  type RepositoryRecord,
  type RepositorySnapshot,
} from '@gitnostics/shared';
import { AppContext, type AppContextValue } from './context';
import { RepositoryPage } from './pages';

const snapshot: RepositorySnapshot = {
  fullName: 'example/project',
  name: 'project',
  owner: 'example',
  description: '',
  url: 'https://github.com/example/project',
  private: false,
  defaultBranch: 'main',
  language: null,
  stars: 0,
  openIssues: 0,
  updatedAt: '2026-10-18T00:00:00Z',
  permissions: { actions: 'read', administration: 'unknown' },
  pullRequests: [],
  runs: [],
  artifacts: [],
  config: { values: {}, inaccessible: [] },
  warnings: [],
};

function view(visibility: boolean | null, error: string | null = null) {
  const repository: RepositoryRecord = {
    fullName: 'example/project',
    mode: 'live',
    favorite: false,
    selected: true,
    syncedAt: visibility === null ? null : snapshot.updatedAt,
    syncStatus: error ? 'error' : 'idle',
    error,
    snapshot: visibility === null ? null : { ...snapshot, private: visibility },
  };
  const data: Dashboard = {
    mode: 'live',
    repositories: [repository],
    findings: [],
    activity: [],
    incidents: [],
    notifications: [],
    settings: defaultSettings,
    connection: { mode: 'public', connected: true, identity: 'Public', writesEnabled: false },
    storageHistory: [],
    workflowAnalytics: [],
  };
  const context: AppContextValue = {
    data,
    mode: 'live',
    busy: false,
    mutate: async () => undefined,
    preview: async () => {},
    inspect: () => {},
    refresh: () => {},
  };
  return (
    <MemoryRouter initialEntries={['/repositories/example/project']}>
      <AppContext.Provider value={context}>
        <Routes>
          <Route path="/repositories/:owner/:repo" element={<RepositoryPage />} />
        </Routes>
      </AppContext.Provider>
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe('repository visibility evidence', () => {
  it.each([null, 'Repository not found or inaccessible'])(
    'shows unknown visibility before any snapshot, including failed synchronization (%s)',
    (error) => {
      render(view(null, error));
      expect(screen.getByText('Visibility unknown')).toBeTruthy();
      expect(screen.queryByText('Public')).toBeNull();
      expect(screen.queryByText('Private')).toBeNull();
    },
  );

  it.each([
    [true, 'Private', 'Public'],
    [false, 'Public', 'Private'],
  ] as const)('shows confirmed visibility from a snapshot (%s)', (privateRepo, label, other) => {
    render(view(privateRepo));
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByText(other)).toBeNull();
    expect(screen.queryByText('Visibility unknown')).toBeNull();
  });
});
