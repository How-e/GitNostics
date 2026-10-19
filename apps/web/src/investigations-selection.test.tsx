// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  defaultSettings,
  type Dashboard,
  type PullRequest,
  type WorkflowRun,
} from '@gitnostics/shared';
import { AppContext, type AppContextValue } from './context';
import { ActionsPage, PullRequestsPage } from './investigations';

vi.mock('./charts', () => ({ DurationChart: () => <div>Duration chart</div> }));

const pr: PullRequest = {
  number: 1,
  title: 'Update dependencies',
  author: 'example',
  url: 'https://github.com/example/project/pull/1',
  headSha: 'old-revision',
  baseBranch: 'main',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  checks: [{ name: 'CI', status: 'pending' }],
  approvals: 0,
  changesRequested: false,
  updatedAt: '2026-10-18T00:00:00Z',
  protectionKnown: true,
};
const run: WorkflowRun = {
  id: 10,
  workflowId: 1,
  name: 'CI',
  title: 'Build project',
  branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/example/project/actions/runs/10',
  createdAt: '2026-10-18T00:00:00Z',
  updatedAt: '2026-10-18T00:00:00Z',
  durationSeconds: 60,
  attempt: 1,
  jobs: [
    {
      id: 20,
      name: 'Old job',
      conclusion: 'failure',
      url: 'https://github.com/example/project/actions/runs/10/jobs/20',
    },
  ],
};
function dashboard(): Dashboard {
  return {
    mode: 'live',
    repositories: [
      {
        fullName: 'example/project',
        mode: 'live',
        favorite: false,
        selected: true,
        syncedAt: '2026-10-18T00:00:00Z',
        syncStatus: 'idle',
        error: null,
        snapshot: {
          fullName: 'example/project',
          owner: 'example',
          name: 'project',
          description: '',
          url: 'https://github.com/example/project',
          private: false,
          defaultBranch: 'main',
          language: null,
          stars: 0,
          openIssues: 0,
          updatedAt: '2026-10-18T00:00:00Z',
          permissions: { actions: 'read', administration: 'read' },
          pullRequests: [pr],
          runs: [run],
          artifacts: [],
          config: { values: {}, inaccessible: [] },
          warnings: [],
        },
      },
    ],
    findings: [],
    activity: [],
    incidents: [],
    notifications: [],
    settings: defaultSettings,
    connection: { mode: 'public', connected: true, identity: 'Public', writesEnabled: false },
    storageHistory: [],
    workflowAnalytics: [],
  };
}
function view(data: Dashboard, page: 'pr' | 'run') {
  const context: AppContextValue = {
    data,
    mode: data.mode,
    busy: false,
    mutate: async () => undefined,
    preview: async () => {},
    inspect: () => {},
    refresh: () => {},
  };
  return (
    <MemoryRouter>
      <AppContext.Provider value={context}>
        {page === 'pr' ? <PullRequestsPage /> : <ActionsPage />}
      </AppContext.Provider>
    </MemoryRouter>
  );
}
afterEach(cleanup);

describe('investigation evidence selection', () => {
  it('updates an open pull request to the latest head and check evidence', () => {
    const initial = dashboard();
    const rendered = render(view(initial, 'pr'));
    fireEvent.click(screen.getByRole('button', { name: pr.title }));
    expect(within(screen.getByRole('dialog')).getByText('old-revision')).toBeTruthy();
    const updated = dashboard();
    updated.repositories[0]!.snapshot!.pullRequests = [
      { ...pr, headSha: 'new-revision', checks: [{ name: 'New check', status: 'failure' }] },
    ];
    rendered.rerender(view(updated, 'pr'));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('new-revision')).toBeTruthy();
    expect(dialog.getByText('New check')).toBeTruthy();
    expect(dialog.queryByText('old-revision')).toBeNull();
  });

  it('updates open run jobs and disables reruns while a new attempt is active', () => {
    const rendered = render(view(dashboard(), 'run'));
    fireEvent.click(screen.getByRole('button', { name: run.title }));
    const updated = dashboard();
    updated.repositories[0]!.snapshot!.runs = [
      {
        ...run,
        attempt: 2,
        status: 'in_progress',
        conclusion: null,
        jobs: [{ ...run.jobs[0]!, id: 21, name: 'New job' }],
      },
    ];
    rendered.rerender(view(updated, 'run'));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Attempt 2')).toBeTruthy();
    expect(dialog.getByText('New job')).toBeTruthy();
    expect(dialog.queryByText('Old job')).toBeNull();
    expect(
      (dialog.getByRole('button', { name: 'Preview rerun' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it.each(['pr', 'run'] as const)(
    'closes %s evidence across mode changes, even when identifiers collide',
    (page) => {
      const initial = dashboard();
      const rendered = render(view(initial, page));
      fireEvent.click(screen.getByRole('button', { name: page === 'pr' ? pr.title : run.title }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      rendered.rerender(view({ ...dashboard(), mode: 'demo' }, page));
      expect(screen.queryByRole('dialog')).toBeNull();
      rendered.rerender(view(initial, page));
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it.each(['pr', 'run'] as const)(
    'keeps %s evidence closed if a removed resource later returns',
    (page) => {
      const rendered = render(view(dashboard(), page));
      fireEvent.click(screen.getByRole('button', { name: page === 'pr' ? pr.title : run.title }));
      rendered.rerender(view({ ...dashboard(), repositories: [] }, page));
      expect(screen.queryByRole('dialog')).toBeNull();
      rendered.rerender(view(dashboard(), page));
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );
});
