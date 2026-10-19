import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './index.js';

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const check = (conclusion: string | null) => ({
  name: 'build',
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
});
const pr = {
  number: 7,
  head: { sha: 'head' },
  base: { ref: 'main', sha: 'base' },
  merge_commit_sha: 'merge',
  mergeable: true,
};

async function snapshot(
  evidence: (ref: string, endpoint: string) => Response,
  metadata: Record<string, unknown> = {},
) {
  const requests: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    expect(init?.method ?? 'GET').toBe('GET');
    const path = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    ).pathname;
    requests.push(path);
    const commit = /\/commits\/([^/]+)\/(check-runs|statuses)$/.exec(path);
    if (commit) return evidence(commit[1]!, commit[2]!);
    if (path === '/repos/octo/project') return json({ name: 'project', default_branch: 'main' });
    if (path.endsWith('/pulls')) return json([pr]);
    if (path.endsWith('/pulls/7')) return json({ ...pr, ...metadata });
    if (path.endsWith('/actions/runs')) return json({ workflow_runs: [] });
    if (path.endsWith('/actions/artifacts')) return json({ artifacts: [] });
    if (path.includes('/compare/')) return json({ behind_by: 0 });
    if (
      path.endsWith('/reviews') ||
      path.includes('/rules/') ||
      path.endsWith('/issues') ||
      path.endsWith('/branches') ||
      path.endsWith('/commits')
    )
      return json([]);
    return json({ protected: false });
  });
  const result = await new GitHubClient({ fetch }).snapshot('octo/project');
  return { snapshot: result, pr: result.pullRequests[0]!, requests };
}

describe('pull request check source', () => {
  it.each(['check-runs', 'statuses'])(
    'uses failing merge %s instead of successful head checks',
    async (source) => {
      const result = await snapshot((ref, endpoint) => {
        const failure = ref === 'merge' ? 'failure' : 'success';
        return endpoint === 'check-runs'
          ? json({ check_runs: source === endpoint ? [check(failure)] : [] })
          : json(source === endpoint ? [{ context: 'build', state: failure }] : []);
      });
      expect(result.pr).toMatchObject({
        headSha: 'head',
        checksComplete: true,
        checks: [{ name: 'build', status: 'failure' }],
      });
      expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(false);
    },
  );

  it('retains both kinds of merge evidence without mixing in head checks', async () => {
    const result = await snapshot((_ref, endpoint) =>
      endpoint === 'check-runs'
        ? json({ check_runs: [check('success')] })
        : json([{ context: 'lint', state: 'failure' }]),
    );
    expect(result.pr.checks).toMatchObject([
      { name: 'build', status: 'success' },
      { name: 'lint', status: 'failure' },
    ]);
    expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(false);
  });

  it('falls back to head checks only after both merge collections are complete and empty', async () => {
    const result = await snapshot((ref, endpoint) =>
      endpoint === 'check-runs'
        ? json({ check_runs: ref === 'head' ? [check('success')] : [] })
        : json(ref === 'head' ? [{ context: 'lint', state: 'success' }] : []),
    );
    expect(result.pr).toMatchObject({
      checksComplete: true,
      checks: [
        { name: 'build', status: 'success' },
        { name: 'lint', status: 'success' },
      ],
    });
    expect(result.requests.filter((path) => /\/(check-runs|statuses)$/.test(path))).toHaveLength(4);
  });

  it('keeps a pending merge check instead of substituting head results', async () => {
    const result = await snapshot((_ref, endpoint) =>
      endpoint === 'check-runs' ? json({ check_runs: [check(null)] }) : json([]),
    );
    expect(result.pr).toMatchObject({
      checksComplete: true,
      checks: [{ status: 'pending' }],
    });
    expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(false);
  });

  it.each([
    { mergeable: null, merge_commit_sha: 'stale-merge' },
    { mergeable: null, merge_commit_sha: null },
    { mergeable: true, merge_commit_sha: null },
  ])(
    'keeps check evidence incomplete while merge metadata is unavailable: %j',
    async (metadata) => {
      const result = await snapshot(() => json({ check_runs: [check('success')] }), metadata);
      expect(result.pr).toMatchObject({ checks: [], checksComplete: false });
      expect(result.snapshot.collectionState?.pullRequests).toBe(false);
      expect(result.requests.some((path) => /\/(check-runs|statuses)$/.test(path))).toBe(false);
      expect(result.snapshot.warnings).toContain(
        'Pull request #7 check source is not ready; refresh after GitHub recomputes mergeability',
      );
      expect(result.pr.mergeable).toBe(metadata.mergeable);
    },
  );

  it('does not reuse a stale merge SHA after GitHub establishes a conflict', async () => {
    const result = await snapshot(
      (_ref, endpoint) =>
        endpoint === 'check-runs' ? json({ check_runs: [check('success')] }) : json([]),
      { mergeable: false, merge_commit_sha: 'stale-merge' },
    );
    expect(result.pr).toMatchObject({ checksComplete: true, checks: [{ status: 'success' }] });
    expect(result.requests.some((path) => path.includes('/commits/stale-merge/'))).toBe(false);
    expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(true);
  });

  it.each(['check-runs', 'statuses'])(
    'does not fall back to head when merge %s are inaccessible',
    async (missing) => {
      const result = await snapshot((_ref, endpoint) =>
        endpoint === missing
          ? json({}, 403)
          : endpoint === 'check-runs'
            ? json({ check_runs: [] })
            : json([]),
      );
      expect(result.pr).toMatchObject({ checks: [], checksComplete: false });
      expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(false);
    },
  );

  it.each(['check-runs', 'statuses'])(
    'does not treat bounded merge %s pagination as an empty complete source',
    async (incomplete) => {
      const result = await snapshot((_ref, endpoint) =>
        json(endpoint === 'check-runs' ? { check_runs: [] } : [], 200, {
          ...(endpoint === incomplete ? { link: '<https://api.github.com/next>; rel="next"' } : {}),
        }),
      );
      expect(result.pr.checksComplete).toBe(false);
      expect(result.requests.some((path) => path.includes('/commits/head/'))).toBe(false);
      expect(result.requests.filter((path) => path.endsWith(`/${incomplete}`))).toHaveLength(5);
    },
  );

  it('preserves incomplete head evidence after an established empty merge source', async () => {
    const result = await snapshot((ref, endpoint) =>
      ref === 'head' && endpoint === 'statuses'
        ? json({}, 403)
        : json(
            endpoint === 'check-runs'
              ? { check_runs: ref === 'head' ? [check('failure')] : [] }
              : [],
          ),
    );
    expect(result.pr).toMatchObject({ checksComplete: false, checks: [{ status: 'failure' }] });
  });
});
