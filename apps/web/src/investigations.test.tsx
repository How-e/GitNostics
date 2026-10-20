// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultSettings,
  type Dashboard,
  type Finding,
  type PullRequest,
  type RepositoryRecord,
} from '@gitnostics/shared';
import { AppContext, type AppContextValue } from './context';
import { PullRequestsPage } from './investigations';

const completePR: PullRequest = {
  number: 1,
  title: 'Complete evidence',
  author: 'example',
  url: 'https://github.com/example/project/pull/1',
  headSha: 'abc123',
  baseBranch: 'main',
  draft: false,
  mergeable: true,
  mergeableState: 'clean',
  checks: [],
  approvals: 0,
  changesRequested: false,
  updatedAt: '2026-10-18T00:00:00Z',
  protectionKnown: true,
  checksComplete: true,
  reviewsComplete: true,
};

function view(
  pr: PullRequest,
  findings: Finding[] = [],
  path = '/pull-requests',
  collectionComplete = true,
) {
  const repository: RepositoryRecord = {
    fullName: 'example/project',
    mode: 'live',
    favorite: false,
    selected: true,
    syncedAt: '2026-10-18T00:00:00Z',
    syncStatus: 'idle',
    error: null,
    snapshot: {
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
      permissions: { actions: 'read', administration: 'read' },
      pullRequests: [pr],
      runs: [],
      artifacts: [],
      config: { values: {}, inaccessible: [] },
      warnings: [],
      collectionState: {
        pullRequests: collectionComplete,
        runs: true,
        artifacts: true,
        config: true,
      },
    },
  };
  const data: Dashboard = {
    mode: 'live',
    repositories: [repository],
    findings,
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
    <MemoryRouter initialEntries={[path]}>
      <AppContext.Provider value={context}>
        <PullRequestsPage />
      </AppContext.Provider>
    </MemoryRouter>
  );
}

afterEach(cleanup);

describe('pull request evidence visibility', () => {
  const otherPRFinding: Finding = {
    id: 'other-pr',
    mode: 'live',
    status: 'new',
    ruleId: 'pr.missing-approvals',
    ruleVersion: 1,
    fingerprint: 'other-pr',
    repository: 'example/project',
    type: 'pull_request',
    severity: 'medium',
    confidence: 'confirmed',
    title: 'PR #2 needs more review approvals',
    explanation: 'A separate PR needs approval.',
    recommendation: 'Review PR #2.',
    resourceUrl: 'https://github.com/example/project/pull/2',
    evidence: [{ label: 'Required approvals', value: '1' }],
    firstDetectedAt: completePR.updatedAt,
    lastObservedAt: completePR.updatedAt,
  };

  it.each(['Required approvals', 'Required app ID', 'Commits behind'])(
    'does not associate a different PR through a matching numeric %s value',
    (label) => {
      render(
        view(
          completePR,
          [{ ...otherPRFinding, evidence: [{ label, value: '1' }] }],
          '/pull-requests?state=blocked',
        ),
      );
      expect(screen.getByText('No pull requests in this view')).toBeTruthy();
    },
  );

  it('associates check-linked findings through their explicit pull request evidence URL', () => {
    render(
      view(
        completePR,
        [
          {
            ...otherPRFinding,
            resourceUrl: 'https://github.com/example/project/actions/runs/123',
            evidence: [
              { label: 'Pull request', value: '#1 Complete evidence', url: completePR.url },
            ],
          },
        ],
        '/pull-requests?state=blocked',
      ),
    );
    expect(screen.getByText('1 diagnostic finding')).toBeTruthy();
  });

  it.each(['head', 'merge', undefined] as const)(
    'does not attribute empty check evidence to the head when source is %s',
    (checksSource) => {
      render(
        view({
          ...completePR,
          checksSource,
          ...(checksSource ? { checksSha: `${checksSource}-revision` } : {}),
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: completePR.title }));
      expect(
        screen.getByText('No check results were collected for this pull request.'),
      ).toBeTruthy();
      expect(screen.queryByText(/for this head revision/)).toBeNull();
    },
  );

  it.each([
    [
      'checks',
      { checksComplete: false },
      'Check evidence is incomplete. Missing results may not have been collected.',
    ],
    [
      'reviews',
      { reviewsComplete: false },
      'Review evidence is incomplete. Approval counts may omit reviews.',
    ],
    [
      'mergeability',
      { mergeable: null },
      'Mergeability is unavailable. Merge eligibility still needs verification.',
    ],
    [
      'protection',
      { protectionKnown: false },
      'Branch protection evidence is unavailable. Check results alone do not establish merge eligibility.',
    ],
  ] as const)(
    'includes incomplete %s in the filter and explains it in detail',
    (_label, changes, notice) => {
      render(view({ ...completePR, ...changes }, [], '/pull-requests?state=unknown'));
      expect(screen.getByText('Incomplete merge evidence')).toBeTruthy();
      expect(screen.queryByText('No supported blockers found')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: completePR.title }));
      expect(screen.getByText(notice)).toBeTruthy();
    },
  );

  it('does not include complete evidence in the incomplete filter', () => {
    render(view(completePR, [], '/pull-requests?state=unknown'));
    expect(screen.getByText('No pull requests in this view')).toBeTruthy();
  });

  it('exposes incomplete collection with a legacy domain notice fallback', () => {
    const { checksComplete: _checks, reviewsComplete: _reviews, ...legacyPR } = completePR;
    render(view(legacyPR, [], '/pull-requests?state=unknown', false));
    expect(screen.getByText('Incomplete merge evidence')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: completePR.title }));
    expect(screen.getByText(/Check evidence is incomplete/)).toBeTruthy();
    expect(screen.getByText(/Review evidence is incomplete/)).toBeTruthy();
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'uses authoritative domain coverage when aggregate collection is incomplete (%s checks, %s reviews)',
    (checksComplete, reviewsComplete) => {
      render(
        view(
          { ...completePR, checksComplete, reviewsComplete },
          [],
          '/pull-requests?state=unknown',
          false,
        ),
      );
      expect(screen.getByText('Incomplete merge evidence')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: completePR.title }));
      expect(Boolean(screen.queryByText(/Check evidence is incomplete/))).toBe(!checksComplete);
      expect(Boolean(screen.queryByText(/Review evidence is incomplete/))).toBe(!reviewsComplete);
    },
  );

  it('keeps informational findings visible without calling them blockers or hiding incomplete evidence', () => {
    const finding: Finding = {
      id: 'unknown-checks',
      mode: 'live',
      status: 'new',
      ruleId: 'pr.required-check-missing',
      ruleVersion: 1,
      fingerprint: 'example',
      repository: 'example/project',
      type: 'pull_request',
      severity: 'info',
      confidence: 'insufficient_evidence',
      title: 'Check evidence unavailable',
      explanation: 'Results are incomplete',
      recommendation: 'Verify on GitHub',
      evidence: [],
      resourceUrl: completePR.url,
      firstDetectedAt: completePR.updatedAt,
      lastObservedAt: completePR.updatedAt,
    };
    render(
      view({ ...completePR, checksComplete: false }, [finding], '/pull-requests?state=blocked'),
    );
    expect(screen.getByText('1 diagnostic finding')).toBeTruthy();
    expect(screen.queryByText('1 blocker finding')).toBeNull();
    expect(screen.getByText('Incomplete merge evidence')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: completePR.title }));
    expect(screen.getByText(finding.title)).toBeTruthy();
  });

  it('retains complete legacy snapshots without optional completion flags', () => {
    const { checksComplete: _checks, reviewsComplete: _reviews, ...legacyPR } = completePR;
    render(view(legacyPR));
    expect(screen.getByText('No supported blockers found')).toBeTruthy();
    expect(screen.queryByText('Incomplete merge evidence')).toBeNull();
  });
});
