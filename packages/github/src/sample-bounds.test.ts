import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './index.js';

const json = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    headers: { 'content-type': 'application/json', ...headers },
  });

async function refresh(prCount: number, runCount: number, ignorePageSize = false) {
  const requests: URL[] = [];
  const pull = (number: number) => ({
    number,
    head: { sha: `head-${number}` },
    base: { ref: 'main', sha: 'base' },
    mergeable: true,
    merge_commit_sha: `head-${number}`,
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    requests.push(url);
    const path = url.pathname;
    if (path.endsWith('/pulls') || path.endsWith('/actions/runs')) {
      const count = path.endsWith('/pulls') ? prCount : runCount;
      const pageSize = ignorePageSize ? 100 : Number(url.searchParams.get('per_page'));
      const items = Array.from({ length: Math.min(count, pageSize) }, (_, index) =>
        path.endsWith('/pulls')
          ? pull(index + 1)
          : { id: index + 1, status: 'completed', conclusion: 'success' },
      );
      return json(path.endsWith('/pulls') ? items : { workflow_runs: items }, {
        ...(count > pageSize ? { link: '<https://attacker.invalid/next>; rel="next"' } : {}),
      });
    }
    if (path === '/repos/octo/project') return json({ name: 'project', default_branch: 'main' });
    const detail = /\/pulls\/(\d+)$/.exec(path);
    if (detail) return json(pull(Number(detail[1])));
    if (path.endsWith('/actions/artifacts')) return json({ artifacts: [] });
    if (path.endsWith('/jobs')) return json({ jobs: [] });
    if (path.endsWith('/check-runs')) return json({ check_runs: [] });
    if (path.includes('/compare/')) return json({ behind_by: 0 });
    if (
      path.endsWith('/statuses') ||
      path.endsWith('/reviews') ||
      path.includes('/rules/') ||
      path.endsWith('/issues') ||
      path.endsWith('/branches') ||
      path.endsWith('/commits')
    )
      return json([]);
    return json({ protected: false });
  });
  const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
  return { snapshot, requests };
}

describe('bounded snapshot collections', () => {
  it('requests only the PR and run samples it retains, with explicit coverage warnings', async () => {
    const { snapshot, requests } = await refresh(1000, 1000);
    const pullPages = requests.filter((url) => url.pathname.endsWith('/pulls'));
    const runPages = requests.filter((url) => url.pathname.endsWith('/actions/runs'));
    expect(pullPages).toHaveLength(1);
    expect(runPages).toHaveLength(1);
    expect(pullPages[0]!.searchParams.get('per_page')).toBe('25');
    expect(runPages[0]!.searchParams.get('per_page')).toBe('30');
    expect(pullPages[0]!.searchParams.get('page')).toBe('1');
    expect(runPages[0]!.searchParams.get('page')).toBe('1');
    expect(requests.every((url) => url.hostname === 'api.github.com')).toBe(true);
    expect(snapshot.pullRequests).toHaveLength(25);
    expect(snapshot.runs).toHaveLength(30);
    expect(snapshot.collectionState).toMatchObject({ pullRequests: false, runs: false });
    expect(snapshot.warnings).toEqual(
      expect.arrayContaining([
        'Pull requests truncated at 25 items; totals and diagnostics cover the returned sample',
        'Workflow runs truncated at 30 items; totals and diagnostics cover the returned sample',
        'Pull request details limited to the 25 most recently updated open requests',
        'Workflow history limited to 30 recent runs; rates describe this sample',
        'Job details collected for the 10 most recent runs; at most 3 failed-job log excerpts per refresh',
      ]),
    );
  });

  it.each([
    [0, 0],
    [25, 10],
  ])('retains complete collection evidence at %i PRs and %i runs', async (prs, runs) => {
    const { snapshot } = await refresh(prs, runs);
    expect(snapshot.pullRequests).toHaveLength(prs);
    expect(snapshot.runs).toHaveLength(runs);
    expect(snapshot.collectionState).toMatchObject({ pullRequests: true, runs: true });
    expect(snapshot.warnings.some((warning) => /truncated|limited/.test(warning))).toBe(false);
  });

  it('does not label an exact complete run sample as truncated when only job details are bounded', async () => {
    const { snapshot } = await refresh(25, 30);
    expect(snapshot.collectionState).toMatchObject({ pullRequests: true, runs: false });
    expect(snapshot.warnings.some((warning) => warning.startsWith('Workflow runs truncated'))).toBe(
      false,
    );
    expect(
      snapshot.warnings.some((warning) => warning.startsWith('Workflow history limited')),
    ).toBe(false);
    expect(snapshot.warnings).toContain(
      'Job details collected for the 10 most recent runs; at most 3 failed-job log excerpts per refresh',
    );
  });

  it('caps responses that exceed the requested page size even without a next link', async () => {
    const { snapshot, requests } = await refresh(100, 100, true);
    expect(snapshot.pullRequests).toHaveLength(25);
    expect(snapshot.runs).toHaveLength(30);
    expect(snapshot.collectionState).toMatchObject({ pullRequests: false, runs: false });
    expect(requests.filter((url) => url.pathname.endsWith('/pulls'))).toHaveLength(1);
    expect(requests.filter((url) => url.pathname.endsWith('/actions/runs'))).toHaveLength(1);
  });
});
