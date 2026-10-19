import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import {
  GitHubClient,
  isAllowedLogUrl,
  logExcerpt,
  MAX_LOG_BYTES,
  MAX_LOG_EXCERPT,
  readBoundedText,
  redactLog,
} from './index.js';

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const transport = (handler: Handler) =>
  vi.fn<typeof fetch>(async (input, init) =>
    handler(
      new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      init ?? {},
    ),
  );
const now = '2026-10-18T12:00:00Z';
const pr = {
  number: 7,
  title: 'Improve synchronization',
  user: { login: 'maintainer' },
  html_url: 'https://github.com/octo/project/pull/7',
  head: { sha: 'head' },
  base: { ref: 'main', sha: 'base' },
  draft: false,
  mergeable: null,
  mergeable_state: 'unknown',
  updated_at: now,
};
const run = {
  id: 12,
  workflow_id: 4,
  name: 'Build',
  display_title: 'Improve synchronization',
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'failure',
  html_url: 'https://github.com/octo/project/actions/runs/12',
  created_at: now,
  run_started_at: now,
  updated_at: '2026-10-18T12:01:00Z',
  run_attempt: 2,
};

function api(overrides?: Handler): Handler {
  return async (url, init) => {
    const override = overrides ? await overrides(url, init) : undefined;
    if (override && override.status !== 599) return override;
    const path = decodeURIComponent(url.pathname);
    if (path === '/repos/octo/project')
      return json({
        name: 'project',
        description: 'Repository',
        html_url: 'https://github.com/octo/project',
        private: false,
        default_branch: 'main',
        language: 'TypeScript',
        stargazers_count: 4,
        open_issues_count: 3,
        updated_at: now,
      });
    if (path.endsWith('/issues'))
      return json([
        {
          number: 19,
          title: 'Improve reliability',
          state: 'open',
          user: { login: 'maintainer' },
          html_url: 'https://github.com/octo/project/issues/19',
          updated_at: now,
        },
        {
          number: 7,
          title: 'Pull request entry',
          pull_request: { url: 'https://api.github.com/repos/octo/project/pulls/7' },
        },
      ]);
    if (path.endsWith('/branches'))
      return json([{ name: 'main', protected: true, commit: { sha: 'base' } }]);
    if (path.endsWith('/commits'))
      return json([
        {
          sha: 'head',
          html_url: 'https://github.com/octo/project/commit/head',
          author: null,
          commit: {
            message: 'Improve retry handling',
            author: { name: 'Maintainer', date: now },
            committer: { date: now },
          },
        },
      ]);
    if (path.endsWith('/branches/main/protection'))
      return json({
        required_status_checks: { checks: [{ context: 'build', app_id: 44 }] },
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          require_code_owner_reviews: true,
        },
      });
    if (path.endsWith('/branches/main'))
      return path.includes('/rules/')
        ? json([{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }])
        : json({ protected: true });
    if (path.endsWith('/pulls')) return json([pr]);
    if (path.endsWith('/pulls/7')) return json(pr);
    if (path.endsWith('/check-runs'))
      return json({
        check_runs: [
          {
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            app: { id: 44 },
            html_url: 'https://github.com/octo/project/actions/runs/12',
          },
        ],
      });
    if (path.endsWith('/statuses'))
      return json([
        { context: 'lint', state: 'success' },
        { context: 'lint', state: 'failure' },
      ]);
    if (path.endsWith('/reviews'))
      return json([
        { user: { login: 'a' }, state: 'APPROVED', submitted_at: now },
        { user: { login: 'a' }, state: 'COMMENTED', submitted_at: now },
        { user: { login: 'b' }, state: 'CHANGES_REQUESTED', submitted_at: now },
        { user: { login: 'b' }, state: 'DISMISSED', submitted_at: '2026-10-18T12:30:00Z' },
      ]);
    if (path.includes('/compare/')) return json({ behind_by: 3 });
    if (path.endsWith('/actions/runs')) return json({ workflow_runs: [run] });
    if (path.endsWith('/runs/12/jobs'))
      return json({
        jobs: [
          {
            id: 9,
            name: 'Compile',
            conclusion: 'failure',
            html_url: 'https://github.com/octo/project/actions/runs/12/job/9',
          },
        ],
      });
    if (path.endsWith('/jobs/9/logs'))
      return new Response(null, {
        status: 302,
        headers: {
          location: 'https://productionresultssa7.blob.core.windows.net/logs/job.txt?sig=fixture',
        },
      });
    if (url.hostname === 'productionresultssa7.blob.core.windows.net')
      return new Response(
        'error TS123: cannot find module\npassword=fixture-value\nAuthorization: Bearer fixture-authorization',
      );
    if (path.endsWith('/actions/artifacts'))
      return json({
        artifacts: [
          {
            id: 1,
            name: 'build',
            size_in_bytes: 8192,
            created_at: now,
            expires_at: '2026-11-18T12:00:00Z',
            expired: false,
            workflow_run: { id: 12 },
          },
        ],
      });
    if (path.endsWith('/permissions/workflow'))
      return json({
        default_workflow_permissions: 'read',
        can_approve_pull_request_reviews: false,
      });
    if (path.endsWith('/cache/usage')) return json({ active_caches_size_in_bytes: 2048 });
    throw new Error(`Unexpected fixture request ${path}`);
  };
}
const passthrough = () => new Response(null, { status: 599 });
const patConfig = () => {
  vi.stubEnv('NODE_ENV', 'development');
  return { token: ['github', 'pat', 'fixture'].join('_'), allowDevelopmentPat: true };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('GitHub authentication boundaries', () => {
  it('requires selected installation membership for advertised and executed writes, with fresh verification', async () => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    let selected = true;
    let memberships = 0;
    const fetch = transport(
      api((url, init) => {
        if (url.pathname === '/app/installations/1/access_tokens')
          return json(
            {
              token: ['ghs', 'fixture', 'membership'].join('_'),
              expires_at: new Date(Date.now() + 3600_000).toISOString(),
              permissions: { actions: 'write', administration: 'write' },
              repository_selection: 'selected',
            },
            201,
          );
        if (url.pathname === '/installation/repositories') {
          memberships++;
          if (memberships > 1) expect(new Headers(init.headers).has('if-none-match')).toBe(true);
          return json(
            {
              repositories: [
                { full_name: selected ? 'OCTO/PROJECT' : 'octo/other', private: false },
              ],
            },
            200,
            { etag: selected ? '"selected"' : '"unselected"' },
          );
        }
        return passthrough();
      }),
    );
    const client = new GitHubClient({
      appId: 1,
      installationId: 1,
      privateKey,
      allowWrites: true,
      fetch,
    });
    const selectedSnapshot = await client.snapshot('octo/project');
    expect(selectedSnapshot.permissions).toMatchObject({
      actions: 'write',
      administration: 'write',
    });
    selected = false;
    const outsideSnapshot = await client.snapshot('octo/project');
    expect(outsideSnapshot.permissions).toMatchObject({ actions: 'read', administration: 'read' });
    expect(
      outsideSnapshot.warnings.some((warning) => warning.includes('outside the selected')),
    ).toBe(true);
    const previousMemberships = memberships;
    await expect(
      client.execute({ repository: 'octo/project', kind: 'rerun', runId: 12 }),
    ).rejects.toThrow('membership');
    expect(memberships).toBe(previousMemberships + 1);
    expect(
      fetch.mock.calls.filter(
        ([input, init]) =>
          (init?.method ?? 'GET') !== 'GET' &&
          new URL(String(input)).pathname !== '/app/installations/1/access_tokens',
      ),
    ).toEqual([]);
  });

  it('validates a GitHub App installation and automatically refreshes expired installation tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    let tokens = 0;
    const fetch = transport((url, init) => {
      if (url.pathname === '/app/installations/1/access_tokens') {
        expect(init.method).toBe('POST');
        expect(new Headers(init.headers).get('authorization')).toMatch(/^bearer /i);
        tokens++;
        return json(
          {
            token: ['ghs', 'fixture', tokens].join('_'),
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            permissions: { actions: 'read' },
            repository_selection: 'selected',
          },
          201,
        );
      }
      expect(url.pathname).toBe('/installation/repositories');
      expect(new Headers(init.headers).get('authorization')).toContain(
        ['ghs', 'fixture', tokens].join('_'),
      );
      return json({ repositories: [{ full_name: 'octo/project', private: true }] });
    });
    const client = new GitHubClient({ appId: 1, installationId: 1, privateKey, fetch });
    expect(client.getConnectionStatus()).toMatchObject({
      mode: 'app',
      connected: false,
      writesEnabled: false,
    });
    expect(await client.discoverRepositories()).toEqual({
      repositories: [{ fullName: 'octo/project', private: true }],
      complete: true,
    });
    expect(client.getConnectionStatus()).toMatchObject({ connected: true, writesEnabled: false });
    expect(tokens).toBe(1);
    await vi.advanceTimersByTimeAsync(3600_001);
    await client.discoverRepositories();
    expect(tokens).toBe(2);
    expect(JSON.stringify(client.getConnectionStatus())).not.toContain('fixture');
  });

  it('defaults to public read-only access and requires explicit development PAT opt-in', async () => {
    const fetch = transport(api());
    const client = new GitHubClient({ fetch });
    expect(client.getConnectionStatus()).toMatchObject({
      mode: 'public',
      connected: true,
      writesEnabled: false,
    });
    expect(await client.discoverRepositories()).toEqual({ repositories: [], complete: true });
    expect(() => new GitHubClient({ token: 'classic-token', allowDevelopmentPat: true })).toThrow(
      'development',
    );
    vi.stubEnv('NODE_ENV', 'production');
    expect(
      () =>
        new GitHubClient({
          token: ['github', 'pat', 'fixture'].join('_'),
          allowDevelopmentPat: true,
        }),
    ).toThrow('development');
    await expect(
      client.execute({ repository: 'octo/project', kind: 'rerun', runId: 12 }),
    ).rejects.toThrow('disabled');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps PAT read-only and removes in-memory access on disconnect', async () => {
    const fetch = transport(api());
    const client = new GitHubClient({ ...patConfig(), fetch, allowWrites: true });
    expect(client.getConnectionStatus()).toMatchObject({
      mode: 'development_pat',
      writesEnabled: false,
    });
    await expect(
      client.execute({ repository: 'octo/project', kind: 'delete_artifacts', artifactIds: [1] }),
    ).rejects.toThrow('disabled');
    client.disconnect();
    await expect(client.snapshot('octo/project')).rejects.toThrow('cancelled');
    expect(client.getConnectionStatus()).toMatchObject({ connected: false, writesEnabled: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects incomplete or competing auth and checks installation permissions before execution', async () => {
    expect(() => new GitHubClient({ appId: 1 })).toThrow('requires');
    expect(
      () =>
        new GitHubClient({ appId: 1, installationId: 1, privateKey: 'fixture', token: 'fixture' }),
    ).toThrow('one');
    const fetch = transport(api());
    const client = new GitHubClient({
      appId: 1,
      installationId: 1,
      privateKey: 'fixture-not-a-key',
      allowWrites: true,
      fetch,
    });
    const permissions = client as unknown as {
      installationPermissions(): Promise<Record<string, string>>;
      status: { connected: boolean };
    };
    permissions.status.connected = true;
    vi.spyOn(permissions, 'installationPermissions').mockResolvedValue({ actions: 'read' });
    await expect(
      client.execute({ repository: 'octo/project', kind: 'rerun', runId: 1 }),
    ).rejects.toThrow('write permission');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks rejected credentials disconnected and returns no credential-bearing upstream errors', async () => {
    const fetch = transport(() =>
      json({ message: 'Bad credentials: extremely-sensitive-value' }, 401),
    );
    const client = new GitHubClient({ ...patConfig(), fetch });
    await expect(client.snapshot('octo/project')).rejects.toThrow('expired or were rejected');
    expect(client.getConnectionStatus()).toMatchObject({
      connected: false,
      error: 'GitHub credentials expired or were rejected',
    });
    expect(JSON.stringify(client.getConnectionStatus())).not.toContain('extremely-sensitive-value');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('GitHub REST collection and mapping', () => {
  it('maps real response shapes while preserving unknown mergeability, latest reviews and check app identity', async () => {
    const fetch = transport(api());
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot).toMatchObject({
      fullName: 'octo/project',
      cacheBytes: 2048,
      permissions: { actions: 'read' },
      config: {
        values: { requiredApprovals: 2, requiredChecks: ['build'], requireCodeOwnerReview: true },
      },
    });
    expect(snapshot.pullRequests[0]).toMatchObject({
      number: 7,
      mergeable: null,
      mergeableState: 'unknown',
      protectionKnown: true,
      checksComplete: true,
      reviewsComplete: true,
      approvals: 1,
      changesRequested: false,
      behindBy: 3,
      requiredCheckSources: [{ name: 'build', appId: 44 }],
    });
    expect(snapshot.pullRequests[0]?.checks).toMatchObject([
      { name: 'build', status: 'failure', appId: 44 },
      { name: 'lint', status: 'success' },
    ]);
    expect(snapshot.artifacts[0]).toMatchObject({ id: 1, sizeBytes: 8192, runId: 12 });
    expect(snapshot.recentIssues).toEqual([
      {
        number: 19,
        title: 'Improve reliability',
        state: 'open',
        author: 'maintainer',
        url: 'https://github.com/octo/project/issues/19',
        updatedAt: now,
      },
    ]);
    expect(snapshot.branches).toEqual([{ name: 'main', protected: true, sha: 'base' }]);
    expect(snapshot.recentCommits).toEqual([
      {
        sha: 'head',
        message: 'Improve retry handling',
        author: 'Maintainer',
        url: 'https://github.com/octo/project/commit/head',
        committedAt: now,
      },
    ]);
    expect(snapshot.runs[0]).toMatchObject({ id: 12, attempt: 2, durationSeconds: 60 });
    expect(snapshot.runs[0]?.jobs[0]?.logExcerpt).toContain('error TS123');
    expect(snapshot.runs[0]?.jobs[0]?.logExcerpt).not.toContain('fixture-value');
    expect(snapshot.runs[0]?.jobs[0]?.logExcerpt).not.toContain('fixture-authorization');
    const download = fetch.mock.calls.find(([url]) =>
      String(url).includes('blob.core.windows.net'),
    );
    expect(download?.[1]?.headers).toEqual({ Accept: 'text/plain' });
    expect(download?.[1]?.redirect).toBe('manual');
  });

  it('never interprets permission-limited branch protection or incomplete checks as full evidence', async () => {
    const fetch = transport(
      api((url) => {
        if (url.pathname.endsWith('/protection') || url.pathname.includes('/rules/'))
          return json({ message: 'not permitted' }, 403);
        if (url.pathname.endsWith('/check-runs')) return json({ message: 'not permitted' }, 403);
        return passthrough();
      }),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot.pullRequests[0]).toMatchObject({
      protectionKnown: false,
      checksComplete: false,
      reviewsComplete: true,
    });
    expect(snapshot.pullRequests[0]?.requiredChecks).toBeUndefined();
    expect(snapshot.config.inaccessible).toContain('branchProtection');
    expect(snapshot.config.values).not.toHaveProperty('branchProtection');
    expect(snapshot.warnings.some((message) => message.includes('incomplete'))).toBe(true);
    expect(snapshot.warnings.some((message) => message.includes('permission denied'))).toBe(true);
    expect(snapshot.collectionState).toMatchObject({
      pullRequests: false,
      config: false,
      artifacts: true,
    });
  });

  it.each(['check-runs', 'statuses', 'reviews'] as const)(
    'keeps independent check and review coverage when %s cannot be read',
    async (endpoint) => {
      const fetch = transport(
        api((url) =>
          url.pathname.endsWith(`/${endpoint}`)
            ? json({ message: 'not permitted' }, 403)
            : passthrough(),
        ),
      );
      const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
      expect(snapshot.pullRequests[0]).toMatchObject({
        checksComplete: endpoint === 'reviews',
        reviewsComplete: endpoint !== 'reviews',
        protectionKnown: true,
      });
      expect(snapshot.collectionState?.pullRequests).toBe(false);
      expect(snapshot.warnings).toContain(
        endpoint === 'reviews'
          ? 'Pull request #7 reviews incomplete; review requirements cannot be established from the returned sample'
          : 'Pull request #7 checks incomplete; absence does not establish a blocker',
      );
    },
  );

  it('marks bounded review pagination incomplete without discarding complete check evidence', async () => {
    const fetch = transport(
      api((url) =>
        url.pathname.endsWith('/reviews')
          ? json([{ user: { login: 'a' }, state: 'CHANGES_REQUESTED', submitted_at: now }], 200, {
              link: '<https://api.github.com/repos/octo/project/pulls/7/reviews?page=6>; rel="next"',
            })
          : passthrough(),
      ),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot.pullRequests[0]).toMatchObject({
      checksComplete: true,
      reviewsComplete: false,
      changesRequested: true,
    });
    expect(snapshot.collectionState?.pullRequests).toBe(false);
    expect(fetch.mock.calls.filter(([input]) => String(input).includes('/reviews?'))).toHaveLength(
      5,
    );
  });

  it('keeps public access connected when an optional endpoint requires authentication', async () => {
    const fetch = transport(
      api((url) =>
        url.pathname.endsWith('/protection') || url.pathname.endsWith('/permissions/workflow')
          ? json({}, 401)
          : passthrough(),
      ),
    );
    const client = new GitHubClient({ fetch });
    const snapshot = await client.snapshot('octo/project');
    expect(
      snapshot.warnings.some((message) => message.includes('authentication is required')),
    ).toBe(true);
    expect(client.getConnectionStatus()).toMatchObject({ connected: true, mode: 'public' });
    expect(client.getConnectionStatus().error).toBeUndefined();
  });

  it('limits recent activity to one sampled page and leaves inaccessible collections undefined', async () => {
    const samples = ['/issues', '/branches', '/commits'];
    const fetch = transport(
      api((url) => {
        if (!samples.some((path) => url.pathname.endsWith(path))) return passthrough();
        expect(url.searchParams.get('page')).toBe('1');
        expect(url.searchParams.get('per_page')).toBe(
          url.pathname.endsWith('/branches') ? '50' : '20',
        );
        return json([], 200, { link: '<https://attacker.invalid/page>; rel="next"' });
      }),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot).toMatchObject({ recentIssues: [], branches: [], recentCommits: [] });
    expect(
      snapshot.warnings.filter((warning) => warning.includes('sample of at most')),
    ).toHaveLength(3);
    expect(
      fetch.mock.calls.filter(([input]) =>
        samples.some((path) => new URL(String(input)).pathname.endsWith(path)),
      ),
    ).toHaveLength(3);
    const unavailable = transport(
      api((url) =>
        samples.some((path) => url.pathname.endsWith(path)) ? json({}, 403) : passthrough(),
      ),
    );
    const partial = await new GitHubClient({ fetch: unavailable }).snapshot('octo/project');
    expect(partial.recentIssues).toBeUndefined();
    expect(partial.branches).toBeUndefined();
    expect(partial.recentCommits).toBeUndefined();
    expect(partial.warnings).toContain('Recent issues: GitHub permission denied');
  });

  it('bounds repository discovery to five pages and never follows arbitrary link destinations', async () => {
    const fetch = transport((url) =>
      json(
        Array.from({ length: 100 }, (_, index) => ({
          full_name: `octo/repo-${url.searchParams.get('page')}-${index}`,
          private: index === 1,
        })),
        200,
        { link: '<https://attacker.invalid/page>; rel="next"' },
      ),
    );
    const client = new GitHubClient({ ...patConfig(), fetch });
    const repositories = await client.discoverRepositories();
    expect(repositories.repositories).toHaveLength(500);
    expect(repositories.complete).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(
      fetch.mock.calls.every(([input]) => new URL(String(input)).hostname === 'api.github.com'),
    ).toBe(true);
    expect(
      fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get('page')),
    ).toEqual(['1', '2', '3', '4', '5']);
  });

  it('uses conditional requests and cached bodies on 304 responses', async () => {
    let seen = 0;
    const fetch = transport(
      api((url, init) => {
        if (url.pathname !== '/repos/octo/project') return passthrough();
        seen++;
        if (seen === 1)
          return json({ name: 'project', default_branch: 'main', updated_at: now }, 200, {
            etag: '"metadata-v1"',
          });
        expect(new Headers(init.headers).get('if-none-match')).toBe('"metadata-v1"');
        return new Response(null, { status: 304 });
      }),
    );
    const client = new GitHubClient({ fetch });
    await client.snapshot('octo/project');
    const cached = await client.snapshot('octo/project');
    expect(cached.name).toBe('project');
    expect(seen).toBe(2);
  });

  it('preserves partial run/artifact data when other optional endpoints fail', async () => {
    const fetch = transport(
      api((url) =>
        url.pathname.endsWith('/pulls') || url.pathname.endsWith('/permissions/workflow')
          ? json({}, 403)
          : passthrough(),
      ),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot.pullRequests).toEqual([]);
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.config.inaccessible).toContain('defaultWorkflowPermissions');
    expect(snapshot.warnings).toContain('Pull requests: GitHub permission denied');
  });

  it('restores verified credential status when a cached discovery response is revalidated', async () => {
    let attempts = 0;
    const fetch = transport(() => {
      attempts++;
      if (attempts === 1)
        return json([{ full_name: 'octo/project', private: true }], 200, { etag: '"repos"' });
      if (attempts === 2) return json({}, 401);
      return new Response(null, { status: 304 });
    });
    const client = new GitHubClient({ ...patConfig(), fetch });
    await client.discoverRepositories();
    await expect(client.discoverRepositories()).rejects.toThrow('credentials');
    expect(client.getConnectionStatus().connected).toBe(false);
    expect(await client.discoverRepositories()).toMatchObject({
      repositories: [{ fullName: 'octo/project', private: true }],
      complete: true,
    });
    expect(client.getConnectionStatus()).toMatchObject({ connected: true, writesEnabled: false });
    expect(client.getConnectionStatus().error).toBeUndefined();
  });

  it('discards the old validator when a successful response no longer carries an ETag', async () => {
    let attempts = 0;
    const fetch = transport((_url, init) => {
      attempts++;
      const validator = new Headers(init.headers).get('if-none-match');
      if (attempts === 1) {
        expect(validator).toBeNull();
        return json([{ full_name: 'octo/old', private: false }], 200, { etag: '"old"' });
      }
      if (attempts === 2) expect(validator).toBe('"old"');
      else expect(validator).toBeNull();
      return json([{ full_name: 'octo/new', private: false }]);
    });
    const client = new GitHubClient({ ...patConfig(), fetch });
    await client.discoverRepositories();
    await client.discoverRepositories();
    expect(await client.discoverRepositories()).toMatchObject({
      repositories: [{ fullName: 'octo/new', private: false }],
    });
    expect(attempts).toBe(3);
  });

  it('rejects invalid repository paths before sending requests', async () => {
    const fetch = transport(api());
    const client = new GitHubClient({ fetch });
    await expect(client.snapshot('../project')).rejects.toThrow('Invalid');
    await expect(client.snapshot('octo/project/path')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('request reliability', () => {
  it('rejects repository redirects instead of treating an empty redirect body as metadata', async () => {
    const fetch = transport(
      () =>
        new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/repo' } }),
    );
    await expect(new GitHubClient({ fetch }).snapshot('octo/project')).rejects.toThrow(
      'GitHub request failed',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps disconnect final even when a transport completes after cancellation', async () => {
    let finish: ((response: Response) => void) | undefined;
    const fetch = transport(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const client = new GitHubClient({ ...patConfig(), fetch });
    const pending = client.discoverRepositories();
    await vi.waitFor(() => expect(finish).toBeDefined());
    client.disconnect();
    finish!(json([{ full_name: 'octo/project', private: true }]));
    await expect(pending).rejects.toThrow('cancelled');
    expect(client.getConnectionStatus()).toMatchObject({
      connected: false,
      identity: 'Disconnected',
    });
  });

  it('cancels active requests and queued waiters, then reuses all request slots', async () => {
    const controller = new AbortController();
    let cancelRequests = true;
    const base = api();
    const fetch = transport(async (url, init) => {
      if (!cancelRequests) return base(url, init);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    const client = new GitHubClient({ fetch });
    const pending = Promise.allSettled(
      Array.from({ length: 8 }, () => client.snapshot('octo/project', controller.signal)),
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    controller.abort();
    const outcomes = await pending;
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') expect(outcome.reason.name).toBe('AbortError');
    expect(fetch).toHaveBeenCalledTimes(4);
    cancelRequests = false;
    expect(await client.snapshot('octo/project')).toMatchObject({ name: 'project' });
  });

  it('retries bounded transient reads and tracks rate-limit metadata', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = transport(
      api((url) => {
        if (url.pathname !== '/repos/octo/project') return passthrough();
        attempts++;
        if (attempts < 3) return json({}, 503, { 'retry-after': '0' });
        return json({ name: 'project', default_branch: 'main', updated_at: now }, 200, {
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '59',
          'x-ratelimit-reset': '1800000000',
        });
      }),
    );
    const client = new GitHubClient({ fetch });
    const snapshot = client.snapshot('octo/project');
    await vi.runAllTimersAsync();
    await snapshot;
    expect(attempts).toBe(3);
    expect(client.getConnectionStatus().rateLimit).toMatchObject({ remaining: 59, limit: 60 });
  });

  it('honors secondary rate Retry-After and refuses excessively long blocking waits', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fetch = transport(
      api((url) => {
        if (url.pathname !== '/repos/octo/project') return passthrough();
        attempts++;
        return attempts === 1
          ? json({}, 403, { 'retry-after': '2' })
          : json({ default_branch: 'main' });
      }),
    );
    const client = new GitHubClient({ fetch });
    const snapshot = client.snapshot('octo/project');
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await snapshot;
    expect(attempts).toBe(2);
    const longWait = transport(() => json({}, 429, { 'retry-after': '120' }));
    await expect(new GitHubClient({ fetch: longWait }).snapshot('octo/project')).rejects.toThrow(
      'rate limit',
    );
    expect(longWait).toHaveBeenCalledTimes(1);
  });

  it('caps concurrency and propagates cancellation through in-flight requests and queue waiters', async () => {
    let active = 0;
    let maximum = 0;
    const base = api();
    const fetch = transport(async (url, init) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try {
        return await base(url, init);
      } finally {
        active--;
      }
    });
    await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(maximum).toBeLessThanOrEqual(4);
    const controller = new AbortController();
    controller.abort();
    const previousCalls = fetch.mock.calls.length;
    await expect(
      new GitHubClient({ fetch }).snapshot('octo/project', controller.signal),
    ).rejects.toThrow('cancelled');
    expect(fetch).toHaveBeenCalledTimes(previousCalls);
  });
});

describe('log security and resource limits', () => {
  it('persists a UTF-8 byte-bounded tail with final failure evidence after redacting the entire log', async () => {
    const source = '\u00e9'.repeat(MAX_LOG_EXCERPT) + '\nerror TS2345: terminal compiler failure';
    const fetch = transport(
      api((url) =>
        url.pathname.endsWith('/jobs/9/logs')
          ? new Response(source, { headers: { 'content-type': 'text/plain' } })
          : passthrough(),
      ),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    const excerpt = snapshot.runs[0]!.jobs[0]!.logExcerpt!;
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(MAX_LOG_EXCERPT);
    expect(excerpt).toContain('terminal compiler failure');
    expect(excerpt).not.toContain('\ufffd');
    expect(
      logExcerpt('-----BEGIN PRIVATE KEY-----\n' + 's'.repeat(MAX_LOG_EXCERPT * 2)),
    ).not.toContain('ssss');
  });

  it('allocates the failed-job budget in run order despite out-of-order job responses and exposes omitted logs', async () => {
    const fetch = transport(
      api(async (url) => {
        if (url.pathname.endsWith('/actions/runs'))
          return json({ workflow_runs: [12, 13, 14, 15].map((id) => ({ ...run, id })) });
        const jobs = /\/runs\/(\d+)\/jobs$/.exec(url.pathname);
        if (jobs) {
          const id = Number(jobs[1]);
          if (id === 12) await new Promise((resolve) => setTimeout(resolve, 30));
          return json({
            jobs: [
              {
                id,
                name: 'compile',
                conclusion: id === 12 ? 'action_required' : 'failure',
                html_url: '',
              },
            ],
          });
        }
        if (/\/jobs\/\d+\/logs$/.test(url.pathname))
          return new Response('error TS2345: failed', {
            headers: { 'content-type': 'text/plain' },
          });
        return passthrough();
      }),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    const paths = fetch.mock.calls
      .map(([input]) => new URL(String(input)).pathname)
      .filter((path) => path.endsWith('/logs'));
    expect(paths).toEqual([12, 13, 14].map((id) => `/repos/octo/project/actions/jobs/${id}/logs`));
    expect(snapshot.runs[0]!.jobs[0]!.logExcerpt).toContain('TS2345');
    expect(snapshot.runs[3]!.jobs[0]!.logExcerpt).toBeUndefined();
    expect(snapshot.collectionState?.runs).toBe(false);
    expect(snapshot.warnings).toContain(
      'Failed-job logs limited to 3 excerpts per refresh; additional failed jobs have no log evidence',
    );
  });

  it('redacts standalone JWT credentials before persistence', () => {
    const credential = ['eyJmaXh0dXJl', 'c3ludGhldGlj', 'c2lnbmF0dXJl'].join('.');
    expect(redactLog(`output: ${credential}`)).not.toContain(credential);
  });

  it('restricts signed log destinations and never follows hostile redirects', async () => {
    for (const url of [
      'http://productionresultssa7.blob.core.windows.net/log',
      'https://127.0.0.1/log',
      'https://productionresultssa7.blob.core.windows.net.attacker.invalid/log',
      'https://user:pass@productionresultssa7.blob.core.windows.net/log',
      'https://productionresultssa7.blob.core.windows.net:444/log',
    ])
      expect(isAllowedLogUrl(url)).toBe(false);
    expect(
      isAllowedLogUrl('https://productionresultssa7.blob.core.windows.net/log?sig=fixture'),
    ).toBe(true);
    const fetch = transport(
      api((url) =>
        url.pathname.endsWith('/jobs/9/logs')
          ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/internal' } })
          : passthrough(),
      ),
    );
    const snapshot = await new GitHubClient({ fetch }).snapshot('octo/project');
    expect(snapshot.runs[0]?.jobs[0]?.logExcerpt).toBeUndefined();
    expect(snapshot.warnings.some((message) => message.includes('destination rejected'))).toBe(
      true,
    );
    expect(
      fetch.mock.calls.every(([input]) => new URL(String(input)).hostname === 'api.github.com'),
    ).toBe(true);
  });

  it('bounds declared and streamed log sizes before returning data', async () => {
    await expect(
      readBoundedText(
        new Response('short', { headers: { 'content-length': String(MAX_LOG_BYTES + 1) } }),
      ),
    ).rejects.toThrow('size limit');
    await expect(readBoundedText(new Response('x'.repeat(MAX_LOG_BYTES + 1)))).rejects.toThrow(
      'size limit',
    );
    expect(await readBoundedText(new Response('ordinary build output'))).toBe(
      'ordinary build output',
    );
  });

  it('redacts configured secrets, credentials, authorization, URL signatures and private keys', () => {
    const source = [
      'password=hunter-test',
      'api_key=private-fixture',
      'Bearer auth-fixture',
      'https://user:pass@example.test/?sig=signed-fixture',
      'configured-value',
      '{"token":"json-fixture-value","password":"quoted fixture value"}',
      JSON.stringify({
        password: 'escaped"secret-suffix',
        client_secret: "single'quote-value",
        private_key: 'key-fixture',
      }),
      '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----',
    ].join('\n');
    const cleaned = redactLog(source, ['configured-value']);
    for (const secret of [
      'hunter-test',
      'private-fixture',
      'auth-fixture',
      'user:pass',
      'signed-fixture',
      'configured-value',
      'json-fixture-value',
      'quoted fixture value',
      'secret-suffix',
      'quote-value',
      'key-fixture',
      '\nfixture\n',
    ])
      expect(cleaned).not.toContain(secret);
    expect(
      redactLog('build failed\n-----BEGIN RSA PRIVATE KEY-----\nsynthetic-truncated-pem'),
    ).not.toContain('synthetic-truncated-pem');
    expect(
      redactLog('https://example.test/log?X-Amz-Signature=synthetic-query&sig=synthetic-sig'),
    ).not.toContain('synthetic-query');
    expect(redactLog(String.raw`password="escaped\"secret-suffix"`)).not.toContain('secret-suffix');
  });
});
