import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './index.js';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

function fixture(
  bases: string[],
  policy: (repository: string, branch: string) => { approvals: number; unavailable?: boolean },
) {
  const requests: string[] = [];
  const pull = (index: number) => ({
    number: index + 1,
    head: { sha: `head-${index + 1}` },
    base: { ref: bases[index], sha: 'base' },
    mergeable: true,
    merge_commit_sha: `head-${index + 1}`,
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const path = decodeURIComponent(
      new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        .pathname,
    );
    requests.push(path);
    const repository = /^\/repos\/([^/]+\/[^/]+)/.exec(path)![1]!;
    const route = path.slice(`/repos/${repository}`.length);
    if (!route) return json({ name: repository.split('/')[1], default_branch: 'main' });
    if (route === '/pulls') return json(bases.map((_, index) => pull(index)));
    const detail = /^\/pulls\/(\d+)$/.exec(route);
    if (detail) return json(pull(Number(detail[1]) - 1));
    if (route.startsWith('/branches/')) {
      const protection = route.endsWith('/protection');
      const branch = route.slice(
        '/branches/'.length,
        protection ? -'/protection'.length : undefined,
      );
      const rules = policy(repository, branch);
      // Keep the first lookup pending so concurrent PRs must share its promise.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (!protection) return json({ protected: true });
      return rules.unavailable
        ? json({}, 403)
        : json({
            required_pull_request_reviews: {
              required_approving_review_count: rules.approvals,
            },
          });
    }
    if (route.startsWith('/rules/branches/')) return json([]);
    if (route === '/actions/runs') return json({ workflow_runs: [] });
    if (route === '/actions/artifacts') return json({ artifacts: [] });
    if (route.endsWith('/check-runs')) return json({ check_runs: [] });
    if (route.startsWith('/compare/')) return json({ behind_by: 0 });
    if (
      route.endsWith('/statuses') ||
      route.endsWith('/reviews') ||
      route === '/issues' ||
      route === '/branches' ||
      route === '/commits'
    )
      return json([]);
    return json({});
  });
  return {
    fetch,
    requests,
    count(repository: string, branch: string) {
      return [
        `/repos/${repository}/branches/${branch}`,
        `/repos/${repository}/branches/${branch}/protection`,
        `/repos/${repository}/rules/branches/${branch}`,
      ].map((path) => requests.filter((request) => request === path).length);
    },
  };
}

describe('per-snapshot branch protection sharing', () => {
  it('loads one protection set for 25 concurrent PRs targeting the same nondefault branch', async () => {
    const mock = fixture(Array<string>(25).fill('release'), () => ({ approvals: 2 }));
    const snapshot = await new GitHubClient({ fetch: mock.fetch }).snapshot('octo/project');
    expect(snapshot.pullRequests).toHaveLength(25);
    expect(mock.count('octo/project', 'release')).toEqual([1, 1, 1]);
    expect(mock.count('octo/project', 'main')).toEqual([1, 1, 1]);
    expect(snapshot.pullRequests.every((pr) => pr.requiredApprovals === 2)).toBe(true);
  });

  it('shares the default result while keeping distinct base-branch policies separate', async () => {
    const mock = fixture(
      ['main', 'main', 'release', 'release', 'hotfix'],
      (_repository, branch) => ({
        approvals: { main: 1, release: 2, hotfix: 3 }[branch]!,
      }),
    );
    const snapshot = await new GitHubClient({ fetch: mock.fetch }).snapshot('octo/project');
    expect(snapshot.pullRequests.map((pr) => pr.requiredApprovals)).toEqual([1, 1, 2, 2, 3]);
    for (const branch of ['main', 'release', 'hotfix'])
      expect(mock.count('octo/project', branch)).toEqual([1, 1, 1]);
  });

  it('reloads policy for every later snapshot on the same client', async () => {
    let approvals = 2;
    const mock = fixture(['release', 'release'], () => ({ approvals }));
    const client = new GitHubClient({ fetch: mock.fetch });
    const first = await client.snapshot('octo/project');
    approvals = 4;
    const second = await client.snapshot('octo/project');
    expect(first.pullRequests.map((pr) => pr.requiredApprovals)).toEqual([2, 2]);
    expect(second.pullRequests.map((pr) => pr.requiredApprovals)).toEqual([4, 4]);
    expect(mock.count('octo/project', 'release')).toEqual([2, 2, 2]);
  });

  it('does not share same-named branches across concurrent repository snapshots', async () => {
    const mock = fixture(['release', 'release'], (repository) => ({
      approvals: repository === 'octo/project' ? 2 : 3,
    }));
    const client = new GitHubClient({ fetch: mock.fetch });
    const [first, second] = await Promise.all([
      client.snapshot('octo/project'),
      client.snapshot('other/project'),
    ]);
    expect(first.pullRequests.map((pr) => pr.requiredApprovals)).toEqual([2, 2]);
    expect(second.pullRequests.map((pr) => pr.requiredApprovals)).toEqual([3, 3]);
    expect(mock.count('octo/project', 'release')).toEqual([1, 1, 1]);
    expect(mock.count('other/project', 'release')).toEqual([1, 1, 1]);
  });

  it('does not share policy across clients with different access contexts', async () => {
    const readable = fixture(['release', 'release'], () => ({ approvals: 2 }));
    const restricted = fixture(['release', 'release'], () => ({
      approvals: 2,
      unavailable: true,
    }));
    const [known, unknown] = await Promise.all([
      new GitHubClient({ fetch: readable.fetch }).snapshot('octo/project'),
      new GitHubClient({ fetch: restricted.fetch }).snapshot('octo/project'),
    ]);
    expect(known.pullRequests.every((pr) => pr.protectionKnown)).toBe(true);
    expect(unknown.pullRequests.every((pr) => !pr.protectionKnown)).toBe(true);
    expect(restricted.count('octo/project', 'release')).toEqual([1, 1, 1]);
  });

  it('shares incomplete evidence only within its snapshot and retries after permission recovery', async () => {
    let unavailable = true;
    const mock = fixture(['release', 'release'], () => ({ approvals: 2, unavailable }));
    const client = new GitHubClient({ fetch: mock.fetch });
    const first = await client.snapshot('octo/project');
    unavailable = false;
    const second = await client.snapshot('octo/project');
    expect(first.pullRequests.every((pr) => !pr.protectionKnown)).toBe(true);
    expect(first.collectionState?.pullRequests).toBe(false);
    expect(
      second.pullRequests.every((pr) => pr.protectionKnown && pr.requiredApprovals === 2),
    ).toBe(true);
    expect(second.collectionState?.pullRequests).toBe(true);
    expect(mock.count('octo/project', 'release')).toEqual([2, 2, 2]);
  });
});
