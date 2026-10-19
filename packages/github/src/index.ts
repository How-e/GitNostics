import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';
import { actionRequestSchema, repoNameSchema } from '@gitnostics/shared';
import type {
  ActionRequest,
  Artifact,
  Check,
  ConnectionStatus,
  PullRequest,
  RepositoryConfig,
  RepositoryDiscovery,
  RepositorySnapshot,
  WorkflowJob,
  WorkflowRun,
} from '@gitnostics/shared';
import { isAllowedLogUrl, MAX_LOG_BYTES, logExcerpt, readBoundedText, redactLog } from './logs.js';
export {
  logExcerpt,
  isAllowedLogUrl,
  MAX_LOG_BYTES,
  MAX_LOG_EXCERPT,
  readBoundedText,
  redactLog,
} from './logs.js';

type Json = Record<string, unknown>;
type Parameters = Record<string, unknown>;
interface ApiResponse {
  data: unknown;
  headers: Record<string, string | number | undefined>;
  status: number;
}
interface Cached {
  data: unknown;
  etag: string;
  headers: ApiResponse['headers'];
  bytes: number;
}
interface Collection {
  items: Json[];
  complete: boolean;
}
interface Protection {
  known: boolean;
  checks: { name: string; appId?: number }[];
  approvals: number;
  codeOwners: boolean;
  values: RepositoryConfig['values'];
}
export interface GitHubClientConfig {
  appId?: string | number;
  privateKey?: string;
  installationId?: string | number;
  token?: string;
  allowDevelopmentPat?: boolean;
  allowWrites?: boolean;
  fetch?: typeof fetch;
}

const object = (input: unknown): Json =>
  input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Json) : {};
const string = (input: unknown, fallback = ''): string =>
  typeof input === 'string' ? input : fallback;
const number = (input: unknown, fallback = 0): number =>
  typeof input === 'number' && Number.isFinite(input) ? input : fallback;
const array = (input: unknown): Json[] => (Array.isArray(input) ? input.map(object) : []);
const boolean = (input: unknown): boolean => input === true;
const statusOf = (error: unknown): number => number(object(error).status);
const headersOf = (error: unknown): ApiResponse['headers'] =>
  (object(object(error).response).headers as ApiResponse['headers']) ?? {};
const iso = (input: unknown): string => {
  const value = string(input);
  return Number.isFinite(Date.parse(value)) ? value : new Date(0).toISOString();
};
const abortError = (): Error => new DOMException('GitHub operation cancelled', 'AbortError');
const safeUrl = (input: unknown): string => {
  try {
    const url = new URL(string(input));
    return url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.port
      ? url.href
      : '';
  } catch {
    return '';
  }
};

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Environment-owned credentials stay in this server-only client and are never returned. */
export class GitHubClient {
  private octokit?: Octokit;
  private status: ConnectionStatus;
  private readonly fetcher: typeof fetch;
  private readonly lifetime = new AbortController();
  private secrets: string[] = [];
  private readonly cache = new Map<string, Cached>();
  private cacheBytes = 0;
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private readonly allowWrites: boolean;

  constructor(config: GitHubClientConfig = {}) {
    this.fetcher = config.fetch ?? globalThis.fetch;
    this.allowWrites = config.allowWrites === true;
    const appFields = [config.appId, config.privateKey, config.installationId];
    const hasApp = appFields.every((value) => value !== undefined && value !== '');
    if (appFields.some((value) => value !== undefined && value !== '') && !hasApp)
      throw new GitHubError('GitHub App requires app ID, private key, and installation ID');
    if (hasApp && config.token) throw new GitHubError('Configure one GitHub authentication method');
    if (
      config.token &&
      !(
        process.env.NODE_ENV === 'development' &&
        config.allowDevelopmentPat &&
        config.token.startsWith('github_pat_')
      )
    ) {
      throw new GitHubError(
        'Fine-grained PAT authentication requires NODE_ENV=development and explicit opt-in',
      );
    }
    this.secrets = [config.token, config.privateKey].filter((value): value is string =>
      Boolean(value),
    );
    const apiFetch: typeof fetch = async (input, init) => {
      const target = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (
        target.protocol !== 'https:' ||
        target.hostname !== 'api.github.com' ||
        target.username ||
        target.password ||
        target.port
      )
        throw new GitHubError('Outbound GitHub destination rejected');
      const response = await this.fetcher(input, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([
          this.lifetime.signal,
          AbortSignal.timeout(15000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      });
      if (
        response.status === 204 ||
        response.status === 304 ||
        (response.status >= 300 && response.status < 400)
      )
        return response;
      const body = await readBoundedText(
        response,
        /\/actions\/jobs\/\d+\/logs$/.test(target.pathname) ? MAX_LOG_BYTES : 8 * 1024 * 1024,
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
    const base = {
      userAgent: 'GitNostics/0.1.0',
      request: { fetch: apiFetch, timeout: 15000 },
      log: { debug() {}, info() {}, warn() {}, error() {} },
    };
    this.octokit = hasApp
      ? new Octokit({
          ...base,
          authStrategy: createAppAuth,
          auth: {
            appId: config.appId,
            privateKey: config.privateKey,
            installationId: config.installationId,
          },
        })
      : new Octokit({ ...base, ...(config.token ? { auth: config.token } : {}) });
    this.status = {
      mode: hasApp ? 'app' : config.token ? 'development_pat' : 'public',
      connected: !hasApp && !config.token,
      identity: hasApp
        ? `GitHub App installation ${String(config.installationId)}`
        : config.token
          ? 'Development fine-grained PAT (read-only)'
          : 'Public GitHub access',
      writesEnabled: false,
      ...(hasApp || config.token
        ? { error: 'Credentials configured; verify with repository discovery or refresh' }
        : {}),
    };
  }

  getConnectionStatus(): ConnectionStatus {
    return structuredClone(this.status);
  }

  disconnect(): void {
    this.lifetime.abort();
    this.cache.clear();
    this.cacheBytes = 0;
    this.octokit = undefined;
    this.secrets = [];
    this.status = {
      ...this.status,
      connected: false,
      writesEnabled: false,
      identity: 'Disconnected',
    };
  }

  private async permit<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortError();
    if (this.active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener('abort', cancel);
          resolve();
        };
        const cancel = () => {
          const index = this.waiters.indexOf(wake);
          if (index !== -1) this.waiters.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener('abort', cancel, { once: true });
        this.waiters.push(wake);
      });
    } else this.active++;
    // A released slot is reserved for its waiter rather than racing new requests.
    try {
      if (signal.aborted) throw abortError();
      return await operation();
    } finally {
      const wake = this.waiters.shift();
      if (wake) wake();
      else this.active--;
    }
  }

  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', cancel);
        resolve();
      }, milliseconds);
      const cancel = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        reject(abortError());
      };
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  private trackRate(headers: ApiResponse['headers']): void {
    const remaining = Number(headers['x-ratelimit-remaining']);
    const limit = Number(headers['x-ratelimit-limit']);
    const reset = Number(headers['x-ratelimit-reset']);
    if (
      Number.isFinite(remaining) &&
      Number.isFinite(limit) &&
      Number.isFinite(reset) &&
      Number.isFinite(new Date(reset * 1000).getTime())
    )
      this.status.rateLimit = { remaining, limit, resetAt: new Date(reset * 1000).toISOString() };
  }

  private markConnected(): void {
    if (this.status.mode === 'public') return;
    this.status.connected = true;
    this.status.writesEnabled = this.status.mode === 'app' && this.allowWrites;
    delete this.status.error;
  }

  private async request(
    route: string,
    parameters: Parameters = {},
    signal?: AbortSignal,
    conditional = true,
  ): Promise<ApiResponse> {
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const key = `${route}:${JSON.stringify(parameters)}`;
    const cached = conditional && route.startsWith('GET ') ? this.cache.get(key) : undefined;
    return this.permit(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (combined.aborted || !this.octokit) throw abortError();
        const timeout = AbortSignal.timeout(15000);
        try {
          const result = (await this.octokit.request(route, {
            ...parameters,
            headers: {
              'X-GitHub-Api-Version': '2022-11-28',
              ...(cached ? { 'If-None-Match': cached.etag } : {}),
            },
            request: { signal: AbortSignal.any([combined, timeout]) },
          })) as ApiResponse;
          if (combined.aborted || !this.octokit) throw abortError();
          if (
            result.status >= 300 &&
            !(
              result.status === 302 &&
              route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs'
            )
          )
            throw new GitHubError('Unexpected GitHub redirect', result.status);
          this.trackRate(result.headers);
          this.markConnected();
          if (conditional && route.startsWith('GET ')) {
            if (this.cache.has(key)) {
              this.cacheBytes -= this.cache.get(key)!.bytes;
              this.cache.delete(key);
            }
          }
          if (conditional && route.startsWith('GET ') && result.headers.etag) {
            const bytes = Buffer.byteLength(JSON.stringify(result.data) ?? '');
            while (
              this.cache.size &&
              (this.cache.size >= 300 || this.cacheBytes + bytes > 16 * 1024 * 1024)
            ) {
              const oldest = this.cache.keys().next().value as string;
              this.cacheBytes -= this.cache.get(oldest)!.bytes;
              this.cache.delete(oldest);
            }
            if (bytes <= 16 * 1024 * 1024) {
              this.cache.set(key, {
                data: result.data,
                etag: String(result.headers.etag),
                headers: result.headers,
                bytes,
              });
              this.cacheBytes += bytes;
            }
          }
          return result;
        } catch (error) {
          const status = statusOf(error);
          const headers = headersOf(error);
          if (combined.aborted || !this.octokit) throw abortError();
          this.trackRate(headers);
          if (status === 304 && cached) {
            this.markConnected();
            return { data: cached.data, headers: { ...cached.headers, ...headers }, status: 304 };
          }
          // Log download redirects are handled separately without forwarding credentials.
          if (
            status === 302 &&
            headers.location &&
            route === 'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs'
          )
            return { data: null, headers, status };
          if (timeout.aborted) throw new GitHubError('GitHub request timed out');
          if (status === 401 && this.status.mode !== 'public') {
            this.status.connected = false;
            this.status.error = 'GitHub credentials expired or were rejected';
            this.status.writesEnabled = false;
          }
          const retryAfterValue = headers['retry-after'];
          const retryAfter =
            retryAfterValue === undefined
              ? undefined
              : Number.isFinite(Number(retryAfterValue))
                ? Number(retryAfterValue) * 1000
                : Date.parse(String(retryAfterValue)) - Date.now();
          const exhausted = headers['x-ratelimit-remaining'] === '0';
          const rateLimited =
            status === 429 ||
            (status === 403 && (headers['retry-after'] !== undefined || exhausted));
          const resetDelay = exhausted
            ? Math.max(0, Number(headers['x-ratelimit-reset']) * 1000 - Date.now())
            : 0;
          const retryDelay =
            retryAfter !== undefined && Number.isFinite(retryAfter)
              ? retryAfter
              : resetDelay || 250 * 2 ** attempt + Math.random() * 100;
          const retryable =
            route.startsWith('GET ') && (rateLimited || status >= 500 || status === 0);
          if (retryable && attempt < 2 && retryDelay <= 30000) {
            await this.delay(Math.max(0, retryDelay), combined);
            continue;
          }
          throw new GitHubError(
            status === 401
              ? this.status.mode === 'public'
                ? 'GitHub authentication is required for this endpoint'
                : 'GitHub credentials expired or were rejected'
              : rateLimited
                ? 'GitHub rate limit reached; refresh after the reported reset time'
                : status === 403
                  ? 'GitHub permission denied'
                  : status === 404
                    ? 'GitHub resource unavailable or permission-limited'
                    : status >= 500
                      ? 'GitHub is temporarily unavailable'
                      : 'GitHub request failed',
            status,
          );
        }
      }
      throw new GitHubError('GitHub retry limit reached');
    }, combined);
  }

  private async collection(
    route: string,
    parameters: Parameters,
    property: string | undefined,
    signal?: AbortSignal,
    maximum = 500,
  ): Promise<Collection> {
    const items: Json[] = [];
    const perPage = Math.min(100, maximum);
    for (let page = 1; page <= Math.ceil(maximum / perPage); page++) {
      const response = await this.request(
        route,
        { ...parameters, per_page: perPage, page },
        signal,
      );
      const payload = property ? object(response.data)[property] : response.data;
      if (!Array.isArray(payload))
        throw new GitHubError('GitHub returned an unexpected collection');
      const batch = array(payload);
      const remaining = maximum - items.length;
      items.push(...batch.slice(0, remaining));
      const hasNext = /<[^>]+>;\s*rel="next"/.test(String(response.headers.link ?? ''));
      if (batch.length > remaining) return { items, complete: false };
      if (!hasNext) return { items, complete: true };
    }
    return { items, complete: false };
  }

  private async sample(
    route: string,
    parameters: Parameters,
    limit: number,
    label: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<Json[]> {
    const response = await this.request(route, { ...parameters, per_page: limit, page: 1 }, signal);
    if (!Array.isArray(response.data))
      throw new GitHubError('GitHub returned an unexpected collection');
    if (
      response.data.length > limit ||
      /<[^>]+>;\s*rel="next"/.test(String(response.headers.link ?? ''))
    )
      warnings.push(
        `${label} is a sample of at most ${limit} recent API entries; additional entries are not included`,
      );
    return array(response.data).slice(0, limit);
  }

  private repository(fullName: string): { owner: string; repo: string } {
    repoNameSchema.parse(fullName);
    const [owner, repo] = fullName.split('/');
    if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..')
      throw new GitHubError('Invalid GitHub repository name');
    return { owner, repo };
  }

  async discoverRepositories(signal?: AbortSignal): Promise<RepositoryDiscovery> {
    if (this.status.mode === 'public') return { repositories: [], complete: true };
    const result =
      this.status.mode === 'app'
        ? await this.collection('GET /installation/repositories', {}, 'repositories', signal)
        : await this.collection(
            'GET /user/repos',
            { affiliation: 'owner,collaborator,organization_member', sort: 'updated' },
            undefined,
            signal,
          );
    return {
      repositories: result.items
        .filter((repo) => repoNameSchema.safeParse(repo.full_name).success)
        .map((repo) => ({ fullName: string(repo.full_name), private: boolean(repo.private) })),
      complete: result.complete,
    };
  }

  private async optional<T>(
    label: string,
    operation: () => Promise<T>,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || this.lifetime.signal.aborted || object(error).name === 'AbortError')
        throw error;
      warnings.push(
        `${label}: ${error instanceof GitHubError ? error.message : 'GitHub data unavailable'}`,
      );
      return undefined;
    }
  }

  private async protection(
    parameters: Parameters,
    branchName: string,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<Protection> {
    const branchParameters = { ...parameters, branch: branchName };
    const [branch, legacy, rules] = await Promise.all([
      this.optional(
        'Branch metadata',
        () => this.request('GET /repos/{owner}/{repo}/branches/{branch}', branchParameters, signal),
        warnings,
        signal,
      ),
      this.optional(
        'Branch protection',
        () =>
          this.request(
            'GET /repos/{owner}/{repo}/branches/{branch}/protection',
            branchParameters,
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Active branch rules',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/rules/branches/{branch}',
            branchParameters,
            undefined,
            signal,
          ),
        warnings,
        signal,
      ),
    ]);
    const checks: { name: string; appId?: number }[] = [];
    const values: RepositoryConfig['values'] = {};
    const protection = object(legacy?.data);
    const checkSettings = object(protection.required_status_checks);
    for (const check of array(checkSettings.checks))
      checks.push({
        name: string(check.context),
        ...(typeof check.app_id === 'number' && check.app_id > 0 ? { appId: check.app_id } : {}),
      });
    if (!checks.length && Array.isArray(checkSettings.contexts))
      for (const context of checkSettings.contexts)
        if (typeof context === 'string') checks.push({ name: context });
    let approvals = number(
      object(protection.required_pull_request_reviews).required_approving_review_count,
    );
    let codeOwners = boolean(
      object(protection.required_pull_request_reviews).require_code_owner_reviews,
    );
    for (const rule of rules?.items ?? []) {
      const parameters = object(rule.parameters);
      if (rule.type === 'required_status_checks') {
        for (const check of array(parameters.required_status_checks))
          checks.push({
            name: string(check.context),
            ...(typeof check.integration_id === 'number' && check.integration_id > 0
              ? { appId: check.integration_id }
              : {}),
          });
      }
      if (rule.type === 'pull_request') {
        approvals = Math.max(approvals, number(parameters.required_approving_review_count));
        codeOwners ||= boolean(parameters.require_code_owner_review);
      }
    }
    const known = Boolean(
      branch && rules?.complete && (legacy || object(branch.data).protected === false),
    );
    if (known) {
      values.branchProtection =
        boolean(object(branch?.data).protected) || Boolean(rules?.items.length);
      values.requiredChecks = [...new Set(checks.map((check) => check.name))].sort();
      values.requiredApprovals = approvals;
      values.requireCodeOwnerReview = codeOwners;
    }
    if (rules && !rules.complete)
      warnings.push('Active branch rules truncated; protection requirements are incomplete');
    return { known, checks: checks.filter((check) => check.name), approvals, codeOwners, values };
  }

  async snapshot(fullName: string, signal?: AbortSignal): Promise<RepositorySnapshot> {
    const parameters = this.repository(fullName);
    const repo = object((await this.request('GET /repos/{owner}/{repo}', parameters, signal)).data);
    const warnings: string[] = [];
    const defaultBranch = string(repo.default_branch, 'main');
    const [
      prs,
      runs,
      artifacts,
      protection,
      workflowPermissions,
      cacheUsage,
      appPermissions,
      membership,
      recentIssues,
      branches,
      recentCommits,
    ] = await Promise.all([
      this.optional(
        'Pull requests',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/pulls',
            { ...parameters, state: 'open', sort: 'updated', direction: 'desc' },
            undefined,
            signal,
            25,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Workflow runs',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/actions/runs',
            parameters,
            'workflow_runs',
            signal,
            30,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Artifacts',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/actions/artifacts',
            parameters,
            'artifacts',
            signal,
          ),
        warnings,
        signal,
      ),
      this.protection(parameters, defaultBranch, warnings, signal),
      this.optional(
        'Workflow permissions',
        () =>
          this.request(
            'GET /repos/{owner}/{repo}/actions/permissions/workflow',
            parameters,
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Actions cache usage',
        () => this.request('GET /repos/{owner}/{repo}/actions/cache/usage', parameters, signal),
        warnings,
        signal,
      ),
      this.status.mode === 'app'
        ? this.optional(
            'Installation permissions',
            () => this.installationPermissions(),
            warnings,
            signal,
          )
        : Promise.resolve(undefined),
      this.status.mode === 'app'
        ? this.optional(
            'Installation repository membership',
            () => this.installationMembership(fullName, signal),
            warnings,
            signal,
          )
        : Promise.resolve(undefined),
      this.optional(
        'Recent issues',
        () =>
          this.sample(
            'GET /repos/{owner}/{repo}/issues',
            { ...parameters, state: 'open', sort: 'updated', direction: 'desc' },
            20,
            'Recent issues',
            warnings,
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Branches',
        () =>
          this.sample(
            'GET /repos/{owner}/{repo}/branches',
            parameters,
            50,
            'Branches',
            warnings,
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Recent commits',
        () =>
          this.sample(
            'GET /repos/{owner}/{repo}/commits',
            parameters,
            20,
            'Recent commits',
            warnings,
            signal,
          ),
        warnings,
        signal,
      ),
    ]);
    if (recentIssues?.some((issue) => issue.pull_request))
      warnings.push('Recent issues exclude pull requests from the sampled GitHub issue entries');
    if (this.status.mode === 'app' && !membership?.included)
      warnings.push(
        membership?.complete
          ? 'Repository is outside the selected GitHub App installation; write permissions are unavailable'
          : 'Installation repository membership could not be confirmed; write permissions are unavailable',
      );
    for (const [name, result, maximum] of [
      ['Pull requests', prs, 25],
      ['Workflow runs', runs, 30],
      ['Artifacts', artifacts, 500],
    ] as const)
      if (result && !result.complete)
        warnings.push(
          `${name} truncated at ${maximum} items; totals and diagnostics cover the returned sample`,
        );
    if (prs && !prs.complete)
      warnings.push('Pull request details limited to the 25 most recently updated open requests');
    if (runs && !runs.complete)
      warnings.push('Workflow history limited to 30 recent runs; rates describe this sample');
    let jobsComplete = true;
    const pullRequests = (
      await Promise.all(
        (prs?.items ?? [])
          .slice(0, 25)
          .map((pr) =>
            this.optional(
              `Pull request #${number(pr.number)}`,
              () => this.pullRequest(parameters, pr, defaultBranch, protection, warnings, signal),
              warnings,
              signal,
            ),
          ),
      )
    ).filter((pr): pr is PullRequest => Boolean(pr));
    const workflowRuns = await Promise.all(
      (runs?.items ?? []).slice(0, 30).map(async (run, index) => {
        const result = this.mapRun(run);
        if (index >= 10) {
          jobsComplete = false;
          return result;
        }
        const jobs = await this.optional(
          `Jobs for run ${result.id}`,
          () =>
            this.collection(
              'GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs',
              { ...parameters, run_id: result.id, filter: 'latest' },
              'jobs',
              signal,
            ),
          warnings,
          signal,
        );
        if (jobs && !jobs.complete)
          warnings.push(`Jobs for run ${result.id} truncated at 500 items`);
        if (!jobs?.complete) jobsComplete = false;
        result.jobs = await Promise.all(
          (jobs?.items ?? []).map(async (item) => {
            const job: WorkflowJob = {
              id: number(item.id),
              name: this.clean(item.name),
              conclusion: typeof item.conclusion === 'string' ? item.conclusion : null,
              url: safeUrl(item.html_url),
              ...(item.started_at ? { startedAt: iso(item.started_at) } : {}),
              ...(item.completed_at ? { completedAt: iso(item.completed_at) } : {}),
            };
            return job;
          }),
        );
        return result;
      }),
    );
    // Reserve the bounded budget in API run/job order, independent of response latency.
    const failedJobs = workflowRuns.flatMap((run) =>
      run.jobs.filter((job) =>
        ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(
          job.conclusion ?? '',
        ),
      ),
    );
    await Promise.all(
      failedJobs.slice(0, 3).map(async (job) => {
        const excerpt = await this.optional(
          `Logs for job ${job.id}`,
          () => this.jobLog(parameters, job.id, signal),
          warnings,
          signal,
        );
        if (excerpt) job.logExcerpt = excerpt;
        else jobsComplete = false;
      }),
    );
    if (failedJobs.length > 3) {
      jobsComplete = false;
      warnings.push(
        'Failed-job logs limited to 3 excerpts per refresh; additional failed jobs have no log evidence',
      );
    }
    if ((runs?.items.length ?? 0) > 10)
      warnings.push(
        'Job details collected for the 10 most recent runs; at most 3 failed-job log excerpts per refresh',
      );
    const config: RepositoryConfig = {
      values: { defaultBranch, ...protection.values },
      inaccessible: [],
    };
    if (!protection.known)
      config.inaccessible.push(
        'branchProtection',
        'requiredChecks',
        'requiredApprovals',
        'requireCodeOwnerReview',
      );
    if (workflowPermissions) {
      const data = object(workflowPermissions.data);
      config.values.defaultWorkflowPermissions = string(data.default_workflow_permissions);
      config.values.canApprovePullRequests = boolean(data.can_approve_pull_request_reviews);
    } else config.inaccessible.push('defaultWorkflowPermissions', 'canApprovePullRequests');
    const security = object(repo.security_and_analysis);
    for (const key of [
      'advanced_security',
      'secret_scanning',
      'secret_scanning_push_protection',
    ] as const) {
      if (typeof object(security[key]).status === 'string')
        config.values[key] = string(object(security[key]).status);
      else config.inaccessible.push(key);
    }
    const mappedArtifacts: Artifact[] = (artifacts?.items ?? []).map((item) => ({
      id: number(item.id),
      name: this.clean(item.name),
      sizeBytes: number(item.size_in_bytes),
      createdAt: iso(item.created_at),
      expiresAt: iso(item.expires_at),
      expired: boolean(item.expired),
      ...(typeof object(item.workflow_run).id === 'number'
        ? { runId: number(object(item.workflow_run).id) }
        : {}),
    }));
    const permissions: RepositorySnapshot['permissions'] = {
      actions:
        appPermissions?.actions === 'write' && membership?.included
          ? 'write'
          : appPermissions?.actions === 'read' || runs
            ? 'read'
            : 'unknown',
      administration:
        appPermissions?.administration === 'write' && membership?.included
          ? 'write'
          : appPermissions?.administration === 'read' || protection.known
            ? 'read'
            : 'unknown',
    };
    return {
      fullName,
      name: this.clean(repo.name),
      owner: parameters.owner,
      description: this.clean(repo.description),
      url: safeUrl(repo.html_url),
      private: boolean(repo.private),
      defaultBranch,
      language: typeof repo.language === 'string' ? this.clean(repo.language) : null,
      stars: number(repo.stargazers_count),
      openIssues: number(repo.open_issues_count),
      updatedAt: iso(repo.updated_at),
      permissions,
      pullRequests,
      runs: workflowRuns,
      artifacts: mappedArtifacts,
      config,
      ...(recentIssues
        ? {
            recentIssues: recentIssues
              .filter((issue) => !issue.pull_request)
              .map((issue) => ({
                number: number(issue.number),
                title: this.clean(issue.title),
                state: this.clean(issue.state),
                author: this.clean(object(issue.user).login),
                url: safeUrl(issue.html_url),
                updatedAt: iso(issue.updated_at),
              })),
          }
        : {}),
      ...(branches
        ? {
            branches: branches.map((branch) => ({
              name: this.clean(branch.name),
              protected: boolean(branch.protected),
              sha: this.clean(object(branch.commit).sha),
            })),
          }
        : {}),
      ...(recentCommits
        ? {
            recentCommits: recentCommits.map((commit) => ({
              sha: this.clean(commit.sha),
              message: this.clean(object(commit.commit).message),
              author: this.clean(
                object(commit.author).login ?? object(object(commit.commit).author).name,
              ),
              url: safeUrl(commit.html_url),
              committedAt: iso(
                object(object(commit.commit).committer).date ??
                  object(object(commit.commit).author).date,
              ),
            })),
          }
        : {}),
      ...(cacheUsage
        ? { cacheBytes: number(object(cacheUsage.data).active_caches_size_in_bytes) }
        : {}),
      warnings: [...new Set(warnings)],
      collectionState: {
        pullRequests: Boolean(
          prs?.complete &&
          prs.items.length <= 25 &&
          pullRequests.length === prs.items.length &&
          pullRequests.every((pr) => pr.checksComplete && pr.reviewsComplete && pr.protectionKnown),
        ),
        runs: Boolean(runs?.complete && runs.items.length <= 30 && jobsComplete),
        artifacts: Boolean(artifacts?.complete),
        config: config.inaccessible.length === 0,
      },
    };
  }

  private clean(input: unknown): string {
    return redactLog(string(input), this.secrets).slice(0, 4096);
  }

  private async installationPermissions(): Promise<Record<string, string>> {
    if (!this.octokit || this.status.mode !== 'app' || this.lifetime.signal.aborted)
      throw new GitHubError('GitHub App is not connected');
    const authentication = await this.octokit.auth({ type: 'installation' });
    return object(object(authentication).permissions) as Record<string, string>;
  }

  private async installationMembership(
    fullName: string,
    signal?: AbortSignal,
  ): Promise<{ included: boolean; complete: boolean }> {
    if (this.status.mode !== 'app') return { included: false, complete: true };
    // Every verification performs current conditional API requests. A prior snapshot
    // never grants access to a repository removed from a selected installation.
    const repositories = await this.collection(
      'GET /installation/repositories',
      {},
      'repositories',
      signal,
    );
    return {
      included: repositories.items.some(
        (repository) => string(repository.full_name).toLowerCase() === fullName.toLowerCase(),
      ),
      complete: repositories.complete,
    };
  }

  private async pullRequest(
    parameters: Parameters,
    listed: Json,
    defaultBranch: string,
    defaultProtection: Protection,
    warnings: string[],
    signal?: AbortSignal,
  ): Promise<PullRequest> {
    const pr = object(
      (
        await this.request(
          'GET /repos/{owner}/{repo}/pulls/{pull_number}',
          { ...parameters, pull_number: number(listed.number) },
          signal,
        )
      ).data,
    );
    const headSha = string(object(pr.head).sha);
    const baseBranch = string(object(pr.base).ref, defaultBranch);
    const [checks, statuses, reviews, protection, comparison] = await Promise.all([
      this.optional(
        'Pull request check runs',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/commits/{ref}/check-runs',
            { ...parameters, ref: headSha, filter: 'latest' },
            'check_runs',
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Pull request commit statuses',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/commits/{ref}/statuses',
            { ...parameters, ref: headSha },
            undefined,
            signal,
          ),
        warnings,
        signal,
      ),
      this.optional(
        'Pull request reviews',
        () =>
          this.collection(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
            { ...parameters, pull_number: number(pr.number) },
            undefined,
            signal,
          ),
        warnings,
        signal,
      ),
      baseBranch === defaultBranch
        ? Promise.resolve(defaultProtection)
        : this.protection(parameters, baseBranch, warnings, signal),
      this.optional(
        'Pull request branch comparison',
        () =>
          this.request(
            'GET /repos/{owner}/{repo}/compare/{basehead}',
            { ...parameters, basehead: `${string(object(pr.base).sha)}...${headSha}` },
            signal,
          ),
        warnings,
        signal,
      ),
    ]);
    const mappedChecks: Check[] = (checks?.items ?? []).map((item) => ({
      name: this.clean(item.name),
      status: item.status !== 'completed' ? 'pending' : this.checkConclusion(item.conclusion),
      url: safeUrl(item.html_url),
      ...(typeof object(item.app).id === 'number' ? { appId: number(object(item.app).id) } : {}),
    }));
    const statusContexts = new Set<string>();
    for (const item of statuses?.items ?? []) {
      const context = this.clean(item.context);
      if (statusContexts.has(context)) continue;
      statusContexts.add(context);
      mappedChecks.push({
        name: context,
        status:
          item.state === 'success' ? 'success' : item.state === 'pending' ? 'pending' : 'failure',
        url: safeUrl(item.target_url),
      });
    }
    const latestReviews = new Map<string, Json>();
    for (const review of reviews?.items ?? []) {
      const actor = string(object(review.user).login);
      if (!actor || review.state === 'COMMENTED' || review.state === 'PENDING') continue;
      const prior = latestReviews.get(actor);
      if (!prior || iso(review.submitted_at) >= iso(prior.submitted_at))
        latestReviews.set(actor, review);
    }
    const checksComplete = Boolean(checks?.complete && statuses?.complete);
    const reviewsComplete = Boolean(reviews?.complete);
    if (!checksComplete)
      warnings.push(
        `Pull request #${number(pr.number)} checks incomplete; absence does not establish a blocker`,
      );
    if (!reviewsComplete)
      warnings.push(
        `Pull request #${number(pr.number)} reviews incomplete; review requirements cannot be established from the returned sample`,
      );
    return {
      number: number(pr.number),
      title: this.clean(pr.title),
      author: this.clean(object(pr.user).login),
      url: safeUrl(pr.html_url),
      headSha,
      baseBranch,
      draft: boolean(pr.draft),
      mergeable: typeof pr.mergeable === 'boolean' ? pr.mergeable : null,
      mergeableState: string(pr.mergeable_state, 'unknown'),
      checks: mappedChecks,
      checksComplete,
      reviewsComplete,
      approvals: [...latestReviews.values()].filter((review) => review.state === 'APPROVED').length,
      changesRequested: [...latestReviews.values()].some(
        (review) => review.state === 'CHANGES_REQUESTED',
      ),
      updatedAt: iso(pr.updated_at),
      protectionKnown: protection.known,
      ...(protection.known
        ? {
            requiredChecks: [...new Set(protection.checks.map((check) => check.name))],
            requiredCheckSources: protection.checks,
            requiredApprovals: protection.approvals,
            requiresCodeOwnerReview: protection.codeOwners,
          }
        : {}),
      ...(comparison ? { behindBy: number(object(comparison.data).behind_by) } : {}),
    };
  }

  private checkConclusion(input: unknown): Check['status'] {
    if (input === 'success') return 'success';
    if (input === 'skipped') return 'skipped';
    if (input === 'neutral') return 'neutral';
    if (input === null || input === undefined) return 'pending';
    return 'failure';
  }

  private mapRun(run: Json): WorkflowRun {
    const createdAt = iso(run.run_started_at ?? run.created_at);
    const updatedAt = iso(run.updated_at);
    return {
      id: number(run.id),
      workflowId: number(run.workflow_id),
      name: this.clean(run.name),
      title: this.clean(run.display_title),
      branch: this.clean(run.head_branch),
      event: string(run.event),
      status: string(run.status),
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
      url: safeUrl(run.html_url),
      createdAt,
      updatedAt,
      durationSeconds: Math.max(
        0,
        Math.round((Date.parse(updatedAt) - Date.parse(createdAt)) / 1000),
      ),
      attempt: number(run.run_attempt, 1),
      jobs: [],
    };
  }

  private async jobLog(
    parameters: Parameters,
    jobId: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.request(
      'GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs',
      { ...parameters, job_id: jobId },
      signal,
      false,
    );
    if (response.status !== 302) {
      if (typeof response.data !== 'string')
        throw new GitHubError('GitHub log response was not plain text');
      return logExcerpt(response.data, this.secrets);
    }
    const location = String(response.headers.location ?? '');
    if (!isAllowedLogUrl(location))
      throw new GitHubError('GitHub log download destination rejected');
    const combined = AbortSignal.any([
      this.lifetime.signal,
      AbortSignal.timeout(10000),
      ...(signal ? [signal] : []),
    ]);
    return this.permit(async () => {
      const download = await this.fetcher(location, {
        redirect: 'manual',
        signal: combined,
        headers: { Accept: 'text/plain' },
      });
      if (!download.ok || download.status >= 300) {
        await download.body?.cancel();
        throw new GitHubError('GitHub log download unavailable');
      }
      return logExcerpt(await readBoundedText(download), this.secrets);
    }, combined);
  }

  /** Called only after the HTTP layer has verified operator authorization and confirmation. */
  async execute(input: ActionRequest, signal?: AbortSignal): Promise<void> {
    const request = actionRequestSchema.parse(input);
    if (!this.allowWrites || this.status.mode !== 'app' || !this.status.connected)
      throw new GitHubError('GitHub writes are disabled');
    const permissions = await this.installationPermissions();
    if (permissions.actions !== 'write')
      throw new GitHubError('GitHub App Actions write permission is required', 403);
    const parameters = this.repository(request.repository);
    const membership = await this.installationMembership(request.repository, signal);
    if (!membership.included)
      throw new GitHubError(
        'Repository membership in the GitHub App installation could not be verified',
        403,
      );
    // Resolve repository access before any mutation; a broad installation permission is insufficient.
    await this.request('GET /repos/{owner}/{repo}', parameters, signal, false);
    if (request.kind === 'rerun_failed' || request.kind === 'rerun') {
      if (!request.runId) throw new GitHubError('A workflow run is required');
      await this.request(
        request.kind === 'rerun_failed'
          ? 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs'
          : 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun',
        { ...parameters, run_id: request.runId },
        signal,
        false,
      );
    } else if (request.kind === 'delete_artifacts') {
      if (!request.artifactIds?.length) throw new GitHubError('Select artifacts to delete');
      for (const artifactId of [...new Set(request.artifactIds)])
        await this.request(
          'DELETE /repos/{owner}/{repo}/actions/artifacts/{artifact_id}',
          { ...parameters, artifact_id: artifactId },
          signal,
          false,
        );
    } else {
      if (!request.workflowId || !request.ref)
        throw new GitHubError('A workflow and branch or tag ref are required');
      await this.request(
        'POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches',
        { ...parameters, workflow_id: request.workflowId, ref: request.ref },
        signal,
        false,
      );
    }
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
