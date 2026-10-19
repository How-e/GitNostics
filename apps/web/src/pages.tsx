import { DeferredContent } from './deferred-content';
import { lazy, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  Database,
  Download,
  FlaskConical,
  FolderGit2,
  GitBranch,
  GitPullRequest,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
} from 'lucide-react';
import { bytesLabel, severityWeight } from '@gitnostics/shared';
import { useApp } from './context';
import {
  Badge,
  Cached,
  Empty,
  ExternalLink,
  FilterSelect,
  FindingRows,
  FindingSummary,
  FindingsEmpty,
  IconButton,
  Metric,
  Modal,
  PageHeading,
  Pagination,
  Panel,
  RepositoryFilter,
  SearchField,
  Status,
  usePage,
} from './components';
import {
  dateLabel,
  failed,
  latestSync,
  relative,
  repoPath,
  repositoryHref,
  unresolved,
} from './format';
const WorkflowChart = lazy(() =>
  import('./charts').then((module) => ({ default: module.WorkflowChart })),
);

export function AddRepository({ open, close }: { open: boolean; close: () => void }) {
  const { busy, mutate, mode } = useApp();
  const [fullName, setFullName] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
      title="Monitor a repository"
      description="Add a repository by its GitHub owner/name. Public repositories need no GitHub credentials."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void mutate(
            '/api/repositories',
            { fullName: fullName.trim() },
            'Repository added. Synchronize to retrieve GitHub evidence.',
          ).then((result) => {
            if (result !== undefined) {
              close();
              setFullName('');
            }
          });
        }}
      >
        <label className="form-field">
          Repository
          <input
            autoFocus
            aria-label="Repository owner/name"
            placeholder="owner/repository"
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            maxLength={201}
            required
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
          />
          <span className="input-help">
            {mode === 'demo'
              ? 'Demo repositories are fixed fixtures. Switch to the live workspace to add a repository.'
              : 'Private repositories require a server-configured GitHub App.'}
          </span>
        </label>
        <div className="dialog-actions">
          <button className="button" type="button" onClick={close}>
            Cancel
          </button>
          <button className="button primary" disabled={busy || mode === 'demo'}>
            <Plus size={15} />
            Add repository
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function OverviewPage({ exploreDemo }: { exploreDemo: () => void }) {
  const { data, mode, busy, mutate } = useApp();
  const [adding, setAdding] = useState(false);
  const repos = data.repositories;
  const active = data.findings
    .filter(unresolved)
    .sort((a, b) => severityWeight[b.severity] - severityWeight[a.severity]);
  const prs = repos.flatMap((r) => r.snapshot?.pullRequests ?? []);
  const runs = repos.flatMap((r) => r.snapshot?.runs ?? []);
  const artifacts = repos.flatMap((r) => r.snapshot?.artifacts ?? []);
  const failures = runs.filter(failed);
  const totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.sizeBytes, 0);
  const busyRepos = repos.filter((r) => ['syncing', 'queued'].includes(r.syncStatus));
  const workflowTrend = Array.from({ length: 14 }, (_, i) => {
    const date = new Date();
    date.setDate(date.getDate() - (13 - i));
    const day = date.toISOString().slice(0, 10);
    const dayRuns = runs.filter((r) => r.createdAt.slice(0, 10) === day);
    return {
      day: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      success: dayRuns.filter((r) => r.conclusion === 'success').length,
      failure: dayRuns.filter(failed).length,
    };
  });
  return (
    <>
      <PageHeading
        title="Your repositories, diagnosed."
        description="The signal behind your pull requests, workflows, and repository health."
        eyebrow="COMMAND CENTER"
        action={
          <>
            <button
              className="button"
              disabled={busy || !repos.length}
              onClick={() =>
                void mutate(
                  busyRepos.length ? '/api/sync/cancel' : '/api/sync',
                  {},
                  busyRepos.length ? 'Cancellation requested' : 'Repository synchronization queued',
                )
              }
            >
              <RefreshCw size={15} className={busyRepos.length ? 'spin' : ''} />
              {busyRepos.length ? 'Cancel sync' : 'Sync repositories'}
            </button>
            <button
              className="button primary"
              disabled={mode === 'demo'}
              onClick={() => setAdding(true)}
            >
              <Plus size={15} />
              Add repository
            </button>
          </>
        }
      />
      {!repos.length ? (
        <div className="onboarding panel">
          <div className="onboarding-copy">
            <div className="onboarding-icon">
              <FolderGit2 size={33} />
            </div>
            <h2>
              Good diagnostics start
              <br />
              with your first repository.
            </h2>
            <p>
              Find the reason a pull request is blocked, connect recurring workflow failures, and
              see where artifacts accumulate.
            </p>
            <div className="button-row">
              <button
                className="button primary"
                disabled={mode === 'demo'}
                onClick={() => setAdding(true)}
              >
                <Plus size={16} />
                Add a repository
              </button>
              {mode === 'live' && (
                <button className="button" disabled={busy} onClick={exploreDemo}>
                  <FlaskConical size={16} />
                  Explore demo
                </button>
              )}
            </div>
            <span className="onboarding-note">
              <LockKeyhole size={13} />
              Public repositories work without credentials. Read-only by default.
            </span>
          </div>
          <div className="onboarding-steps">
            <div>
              <span>01</span>
              <div>
                <h3>Connect the context</h3>
                <p>
                  Add a public repository or configure a least-privilege GitHub App in Settings.
                </p>
              </div>
            </div>
            <div>
              <span>02</span>
              <div>
                <h3>Follow the evidence</h3>
                <p>
                  Review supported diagnostics with confidence, source evidence, and cached
                  timestamps.
                </p>
              </div>
            </div>
            <div>
              <span>03</span>
              <div>
                <h3>Resolve with control</h3>
                <p>
                  Inspect impact previews and explicitly confirm every supported GitHub operation.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="metrics-grid">
            <Metric
              label="Monitored repositories"
              value={repos.length.toString().padStart(2, '0')}
              detail={`${repos.filter((r) => r.syncStatus === 'error').length} sync errors`}
              icon={<FolderGit2 size={18} />}
              to="/repositories"
            />
            <Metric
              label="Open pull requests"
              value={prs.length.toString().padStart(2, '0')}
              detail={`${active.filter((f) => f.type === 'pull_request').length} blocker findings`}
              icon={<GitPullRequest size={18} />}
              to="/pull-requests"
            />
            <Metric
              label="Failed workflow runs"
              value={failures.length.toString().padStart(2, '0')}
              detail={`${runs.length} cached runs inspected`}
              icon={<Activity size={18} />}
              to="/actions"
              tone={failures.length ? 'metric-warn' : ''}
            />
            <Metric
              label="Retained artifacts"
              value={bytesLabel(totalBytes)}
              detail={`${artifacts.length} artifacts in cache`}
              icon={<Database size={18} />}
              to="/storage"
            />
          </div>
          <div className={`attention-strip ${active.length ? '' : 'all-clear'}`}>
            <div className="attention-icon">
              {active.length ? <CircleAlert size={21} /> : <ShieldCheck size={21} />}
            </div>
            <div>
              <strong>
                {active.length
                  ? `${active.length} diagnostic finding${active.length === 1 ? '' : 's'} need attention`
                  : 'No unresolved findings in cached evidence'}
              </strong>
              <p>
                {active.length
                  ? `${active.filter((f) => f.confidence === 'confirmed').length} confirmed · ${active.filter((f) => f.confidence === 'probable').length} probable · Prioritized by severity`
                  : 'Results cover the supported rules and available GitHub permissions.'}
              </p>
            </div>
            <Link to="/findings">
              Review findings <ArrowRight size={16} />
            </Link>
          </div>
          <div className="overview-columns">
            <Panel
              title="Needs your attention"
              description="Highest-priority unresolved diagnostics"
              action={
                <Link className="text-link" to="/findings">
                  View all <ArrowUpRight size={14} />
                </Link>
              }
            >
              {active.length ? (
                <FindingRows findings={active.slice(0, 5)} compact />
              ) : (
                <FindingsEmpty />
              )}
            </Panel>
            <Panel
              title="Workflow pulse"
              description="Run conclusions in the cached 14-day window"
              action={<Badge>14 days</Badge>}
            >
              <div className="chart-legend">
                <span>
                  <i className="legend-square green" />
                  Successful
                </span>
                <span>
                  <i className="legend-square amber" />
                  Failed
                </span>
              </div>
              {runs.length ? (
                <div className="chart-container">
                  <DeferredContent label="Loading chart..." chart>
                    <WorkflowChart data={workflowTrend} />
                  </DeferredContent>
                </div>
              ) : (
                <Empty title="No workflow runs cached">
                  Synchronize a repository to inspect its workflow activity.
                </Empty>
              )}
              <div className="chart-footnote">
                <span>{data.incidents.length} correlated incidents</span>
                <Link to="/actions">
                  Investigate <ArrowRight size={13} />
                </Link>
              </div>
            </Panel>
          </div>
          <Panel
            title="Repository health"
            description="Unresolved diagnostics, synchronization status, and observed activity"
            action={
              <Link className="text-link" to="/repositories">
                All repositories <ArrowUpRight size={14} />
              </Link>
            }
          >
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Repository</th>
                    <th>Diagnostics</th>
                    <th>Open PRs</th>
                    <th>Latest workflow</th>
                    <th>Data freshness</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {repos.slice(0, 6).map((repo) => (
                    <tr key={repo.fullName}>
                      <td>
                        <Link className="repo-name" to={repositoryHref(repo.fullName)}>
                          <FolderGit2 size={16} />
                          {repo.fullName}
                        </Link>
                        <span className="table-subtext">
                          {repo.snapshot?.language ?? 'Language unavailable'}
                        </span>
                      </td>
                      <td>
                        <FindingSummary repository={repo.fullName} />
                      </td>
                      <td className="mono">{repo.snapshot?.pullRequests.length ?? '–'}</td>
                      <td>
                        {repo.snapshot?.runs[0] ? (
                          <Status
                            value={repo.snapshot.runs[0].conclusion ?? repo.snapshot.runs[0].status}
                          />
                        ) : (
                          <span className="muted">No cached runs</span>
                        )}
                      </td>
                      <td>
                        <Cached repository={repo} />
                      </td>
                      <td>
                        <Link
                          className="row-arrow"
                          aria-label={`Open ${repo.fullName}`}
                          to={repositoryHref(repo.fullName)}
                        >
                          <ArrowUpRight size={16} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          <div className="overview-bottom">
            <div className="quiet-note">
              <ShieldCheck size={16} />
              <p>
                <strong>Every diagnosis has a source.</strong> GitNostics distinguishes confirmed
                blockers from probable causes and incomplete evidence.
              </p>
            </div>
            <span className="muted small">Most recent cache: {dateLabel(latestSync(repos))}</span>
          </div>
        </>
      )}
      <AddRepository open={adding} close={() => setAdding(false)} />
    </>
  );
}

export function RepositoriesPage() {
  const { data, mode, busy, mutate } = useApp();
  const [params] = useSearchParams();
  const [adding, setAdding] = useState(false);
  const search = (params.get('q') ?? '').toLowerCase();
  const repositories = data.repositories
    .filter(
      (r) =>
        `${r.fullName} ${r.snapshot?.description ?? ''}`.toLowerCase().includes(search) &&
        (!params.get('favorite') || r.favorite) &&
        (!params.get('state') || r.syncStatus === params.get('state')),
    )
    .sort((a, b) =>
      params.get('sort') === 'updated'
        ? (b.syncedAt ?? '').localeCompare(a.syncedAt ?? '')
        : Number(b.favorite) - Number(a.favorite) || a.fullName.localeCompare(b.fullName),
    );
  const page = usePage(repositories);
  return (
    <>
      <PageHeading
        title="Repositories"
        description="Your monitored repositories, their evidence, and synchronization health."
        action={
          <button
            className="button primary"
            disabled={mode === 'demo'}
            onClick={() => setAdding(true)}
          >
            <Plus size={15} />
            Add repository
          </button>
        }
      />
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search repositories…" />
        </div>
        <FilterSelect label="Favorites" parameter="favorite">
          <option value="">All repositories</option>
          <option value="yes">Favorites only</option>
        </FilterSelect>
        <FilterSelect label="Synchronization status" parameter="state">
          <option value="">All sync states</option>
          <option value="idle">Idle</option>
          <option value="syncing">Syncing</option>
          <option value="queued">Queued</option>
          <option value="error">Error</option>
        </FilterSelect>
        <FilterSelect label="Sort repositories" parameter="sort">
          <option value="">Favorites, then name</option>
          <option value="updated">Last synchronized</option>
        </FilterSelect>
        <span className="filter-count">{repositories.length} repositories</span>
      </div>
      <div className="repository-grid">
        {page.map((repo) => (
          <article className="repository-card panel" key={repo.fullName}>
            <div className="repository-card-top">
              <div className="repository-glyph">
                <FolderGit2 size={21} />
              </div>
              <IconButton
                label={repo.favorite ? `Unfavorite ${repo.fullName}` : `Favorite ${repo.fullName}`}
                disabled={busy}
                onClick={() =>
                  void mutate(
                    repoPath(repo.fullName),
                    { favorite: !repo.favorite },
                    'Favorite updated',
                    'PATCH',
                  )
                }
              >
                <Star
                  size={17}
                  className={repo.favorite ? 'favorite-star' : ''}
                  fill={repo.favorite ? 'currentColor' : 'none'}
                />
              </IconButton>
            </div>
            <Link className="repository-card-name" to={repositoryHref(repo.fullName)}>
              <span>{repo.fullName.split('/')[0]} /</span>
              <strong>{repo.fullName.split('/')[1]}</strong>
            </Link>
            <p>
              {repo.snapshot?.description ||
                'No description cached. Synchronize to retrieve repository metadata.'}
            </p>
            <div className="repository-card-tags">
              {repo.snapshot?.private && (
                <Badge>
                  <LockKeyhole size={11} />
                  Private
                </Badge>
              )}
              {repo.snapshot?.language && <Badge>{repo.snapshot.language}</Badge>}
              <FindingSummary repository={repo.fullName} />
            </div>
            <div className="repository-card-stats">
              <span>
                <GitPullRequest size={14} />
                {repo.snapshot?.pullRequests.length ?? 0} open PRs
              </span>
              <span>
                <Database size={14} />
                {bytesLabel(
                  (repo.snapshot?.artifacts ?? []).reduce((sum, a) => sum + a.sizeBytes, 0),
                )}
              </span>
            </div>
            <div className="repository-card-footer">
              <Cached repository={repo} />
              <Status value={repo.syncStatus} />
            </div>
            {repo.error && <p className="error-message">{repo.error}</p>}
          </article>
        ))}
      </div>
      {!repositories.length && (
        <Panel>
          <Empty
            title={
              data.repositories.length
                ? 'No repositories match your filters'
                : 'Your workspace starts here'
            }
            action={
              !data.repositories.length && (
                <button
                  className="button primary"
                  disabled={mode === 'demo'}
                  onClick={() => setAdding(true)}
                >
                  <Plus size={15} />
                  Add repository
                </button>
              )
            }
          >
            {data.repositories.length
              ? 'Try another search or sync state.'
              : 'Add a GitHub owner/repository to begin collecting diagnostic evidence.'}
          </Empty>
        </Panel>
      )}
      <Pagination total={repositories.length} />
      <AddRepository open={adding} close={() => setAdding(false)} />
    </>
  );
}

export function RepositoryPage() {
  const { owner, repo: name } = useParams();
  const { data, busy, mutate } = useApp();
  const fullName = `${owner}/${name}`;
  const repository = data.repositories.find((r) => r.fullName === fullName);
  const snapshot = repository?.snapshot;
  const findings = data.findings.filter((f) => f.repository === fullName && unresolved(f));
  const [removing, setRemoving] = useState(false);
  if (!repository)
    return (
      <Empty
        title="Repository not monitored"
        action={
          <Link className="button" to="/repositories">
            Back to repositories
          </Link>
        }
      >
        This repository isn't part of the current workspace.
      </Empty>
    );
  return (
    <>
      <Link className="back-link" to="/repositories">
        Repositories <span>/ {fullName}</span>
      </Link>
      <PageHeading
        title={name ?? fullName}
        description={
          snapshot?.description ??
          'Synchronize this repository to collect metadata and diagnostic evidence.'
        }
        eyebrow={owner}
        action={
          <>
            <button
              className="button"
              disabled={busy}
              onClick={() =>
                void mutate(
                  repoPath(fullName),
                  { favorite: !repository.favorite },
                  'Favorite updated',
                  'PATCH',
                )
              }
            >
              <Star size={15} fill={repository.favorite ? 'currentColor' : 'none'} />
              {repository.favorite ? 'Favorited' : 'Favorite'}
            </button>
            <button
              className="button primary"
              disabled={
                busy ||
                !repository.selected ||
                ['syncing', 'queued'].includes(repository.syncStatus)
              }
              onClick={() =>
                void mutate(
                  '/api/sync',
                  { repository: fullName },
                  'Repository synchronization queued',
                )
              }
            >
              <RefreshCw size={15} />
              Synchronize
            </button>
          </>
        }
      />
      <div className="repo-detail-meta">
        <Badge>{snapshot ? (snapshot.private ? 'Private' : 'Public') : 'Visibility unknown'}</Badge>
        {snapshot?.language && <Badge>{snapshot.language}</Badge>}
        <span>
          <GitBranch size={14} />
          {snapshot?.defaultBranch ?? 'Unknown branch'}
        </span>
        <Cached repository={repository} />
        {snapshot && <ExternalLink href={snapshot.url}>Open on GitHub</ExternalLink>}
      </div>
      {repository.error && (
        <div className="permission-notice">
          <CircleAlert size={18} />
          <p>{repository.error}</p>
        </div>
      )}
      {snapshot?.warnings.map((warning, i) => (
        <div className="permission-notice" key={i}>
          <CircleAlert size={16} />
          <p>{warning}</p>
        </div>
      ))}
      <div className="metrics-grid">
        <Metric
          to={`/findings?repo=${encodeURIComponent(fullName)}`}
          label="Unresolved findings"
          value={findings.length}
          detail="Supported diagnostic rules"
          icon={<ShieldCheck size={18} />}
        />
        <Metric
          to={`/pull-requests?repo=${encodeURIComponent(fullName)}`}
          label="Open pull requests"
          value={snapshot?.pullRequests.length ?? '–'}
          detail="Reviews, checks, and blockers"
          icon={<GitPullRequest size={18} />}
        />
        <Metric
          to={`/actions?repo=${encodeURIComponent(fullName)}`}
          label="Workflow runs"
          value={snapshot?.runs.length ?? '–'}
          detail="Cached workflow evidence"
          icon={<Activity size={18} />}
        />
        <Metric
          to={`/storage?repo=${encodeURIComponent(fullName)}`}
          label="Artifact storage"
          value={bytesLabel((snapshot?.artifacts ?? []).reduce((sum, a) => sum + a.sizeBytes, 0))}
          detail={`${snapshot?.artifacts.length ?? 0} artifacts`}
          icon={<Database size={18} />}
        />
      </div>
      <Panel
        title="Repository diagnostics"
        action={
          <Link className="text-link" to={`/findings?repo=${encodeURIComponent(fullName)}`}>
            All findings <ArrowRight size={14} />
          </Link>
        }
      >
        {findings.length ? <FindingRows findings={findings} /> : <FindingsEmpty />}
      </Panel>
      <div className="detail-columns">
        <Panel
          title="Configuration evidence"
          description="Values observed through available GitHub permissions"
          action={
            <button
              className="button small-button"
              disabled={busy || !snapshot}
              onClick={() =>
                void mutate(
                  '/api/baselines',
                  { repository: fullName },
                  'Configuration baseline saved',
                )
              }
            >
              <Download size={13} />
              Save baseline
            </button>
          }
        >
          {snapshot ? (
            <>
              <dl className="config-list">
                {Object.entries(snapshot.config.values).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key.replaceAll('_', ' ')}</dt>
                    <dd>
                      {Array.isArray(value)
                        ? value.join(', ') || '(empty)'
                        : String(value ?? 'Unknown')}
                    </dd>
                  </div>
                ))}
              </dl>
              {snapshot.config.inaccessible.length > 0 && (
                <div className="permission-notice">
                  <LockKeyhole size={16} />
                  <p>
                    Unavailable with current permissions: {snapshot.config.inaccessible.join(', ')}.
                    Missing permission is not a security regression.
                  </p>
                </div>
              )}
            </>
          ) : (
            <Empty title="No configuration observed">
              Synchronize to retrieve accessible configuration values.
            </Empty>
          )}
        </Panel>
        <Panel title="Monitoring preferences" description="Applies to this GitNostics workspace">
          <div className="settings-compact">
            <label className="toggle-row">
              <div>
                <strong>Monitor this repository</strong>
                <span>Enable monitoring to refresh and schedule this repository.</span>
              </div>
              <input
                type="checkbox"
                checked={repository.selected}
                disabled={busy}
                onChange={(event) =>
                  void mutate(
                    repoPath(fullName),
                    { selected: event.target.checked },
                    'Monitoring selection updated',
                    'PATCH',
                  )
                }
              />
            </label>
            <div className="form-note">
              Baseline comparisons appear as configuration findings after a subsequent
              synchronization.
            </div>
            <Link className="button" to={`/safe-actions?repo=${encodeURIComponent(fullName)}`}>
              <ShieldCheck size={15} />
              Review available safe actions
            </Link>
            <button className="button danger-quiet" onClick={() => setRemoving(true)}>
              Remove from workspace
            </button>
          </div>
        </Panel>
      </div>
      {snapshot && (
        <div className="detail-columns">
          <Panel
            title="Recent commits"
            description="Up to 20 commits from the cached default branch"
          >
            {snapshot.recentCommits === undefined ? (
              <Empty title="Commit evidence unavailable">
                Synchronize with Contents read permission to retrieve recent commits.
              </Empty>
            ) : snapshot.recentCommits.length ? (
              <div className="repository-activity">
                {snapshot.recentCommits.map((commit) => (
                  <div key={commit.sha}>
                    <ExternalLink href={commit.url}>{commit.message.split('\n')[0]}</ExternalLink>
                    <span className="table-subtext mono">
                      {commit.sha.slice(0, 8)} · {commit.author} · {relative(commit.committedAt)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No commits returned" />
            )}
          </Panel>
          <Panel
            title="Issues & branches"
            description="Recent open issue sample and up to 50 observed branches"
          >
            <div className="repository-activity">
              {snapshot.branches === undefined ? (
                <p className="muted">Branch evidence unavailable.</p>
              ) : (
                <div className="inline-meta">
                  {snapshot.branches.map((branch) => (
                    <Badge key={branch.name}>
                      {branch.name}
                      {branch.protected ? ' · protected' : ''}
                    </Badge>
                  ))}
                </div>
              )}
              {snapshot.recentIssues === undefined ? (
                <p className="muted">Issue evidence unavailable with the current permissions.</p>
              ) : snapshot.recentIssues.length ? (
                snapshot.recentIssues.map((issue) => (
                  <div key={issue.number}>
                    <ExternalLink href={issue.url}>
                      #{issue.number} {issue.title}
                    </ExternalLink>
                    <span className="table-subtext">
                      {issue.author} · updated {relative(issue.updatedAt)}
                    </span>
                  </div>
                ))
              ) : (
                <p className="muted">
                  No issues in the returned sample. Pull requests are excluded.
                </p>
              )}
            </div>
          </Panel>
        </div>
      )}
      <Modal
        open={removing}
        onOpenChange={setRemoving}
        title="Remove monitored repository?"
        description="This removes the repository's locally cached data from this workspace. The GitHub repository will not be modified."
      >
        <p className="mono">{fullName}</p>
        <div className="dialog-actions">
          <button className="button" onClick={() => setRemoving(false)}>
            Cancel
          </button>
          <button
            className="button danger"
            disabled={busy}
            onClick={() => {
              void mutate(
                repoPath(fullName),
                {},
                'Repository removed from workspace',
                'DELETE',
              ).then((result) => {
                if (result !== undefined) setRemoving(false);
              });
            }}
          >
            Remove from workspace
          </button>
        </div>
      </Modal>
    </>
  );
}

export function FindingsPage() {
  const { data } = useApp();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').toLowerCase();
  const findings = data.findings
    .filter(
      (f) =>
        (!params.get('repo') || f.repository === params.get('repo')) &&
        (!params.get('severity') || f.severity === params.get('severity')) &&
        (!params.get('type') || f.type === params.get('type')) &&
        (params.get('status') === 'all' ||
          (params.get('status') ? f.status === params.get('status') : unresolved(f))) &&
        `${f.title} ${f.explanation} ${f.ruleId}`.toLowerCase().includes(q),
    )
    .sort(
      (a, b) =>
        severityWeight[b.severity] - severityWeight[a.severity] ||
        b.lastObservedAt.localeCompare(a.lastObservedAt),
    );
  const page = usePage(findings);
  return (
    <>
      <PageHeading
        title="Diagnostic findings"
        description="Prioritized observations, with the evidence and confidence behind every claim."
        action={<Badge>{data.findings.filter(unresolved).length} unresolved</Badge>}
      />
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search findings…" />
        </div>
        <RepositoryFilter />
        <FilterSelect label="Severity" parameter="severity">
          <option value="">All severities</option>
          {['critical', 'high', 'medium', 'low', 'info'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </FilterSelect>
        <FilterSelect label="Finding status" parameter="status">
          <option value="">Unresolved</option>
          <option value="all">All history</option>
          {['new', 'active', 'acknowledged', 'resolved', 'suppressed'].map((v) => (
            <option key={v}>{v}</option>
          ))}
        </FilterSelect>
        <FilterSelect label="Finding type" parameter="type">
          <option value="">All types</option>
          <option value="pull_request">Pull requests</option>
          <option value="workflow">Workflows</option>
          <option value="configuration">Configuration drift</option>
          <option value="storage">Storage</option>
        </FilterSelect>
      </div>
      <div className="confidence-key">
        <span>
          <CheckCircle2 size={13} />
          Confirmed: directly observed
        </span>
        <span>
          <CircleAlert size={13} />
          Probable: supporting evidence
        </span>
        <span>
          <Search size={13} />
          Insufficient evidence: needs verification
        </span>
      </div>
      <Panel
        title={`${findings.length} finding${findings.length !== 1 ? 's' : ''}`}
        action={<span className="muted small">Sorted by severity</span>}
      >
        {findings.length ? <FindingRows findings={page} /> : <FindingsEmpty />}
      </Panel>
      <Pagination total={findings.length} />
    </>
  );
}

export function ActivityPage() {
  const { data } = useApp();
  const [params] = useSearchParams();
  const kinds = [...new Set(data.activity.map((a) => a.kind))].sort();
  const q = (params.get('q') ?? '').toLowerCase();
  const events = data.activity
    .filter(
      (a) =>
        (!params.get('repo') || a.repository === params.get('repo')) &&
        (!params.get('kind') || a.kind === params.get('kind')) &&
        `${a.message} ${a.kind}`.toLowerCase().includes(q),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const page = usePage(events, 20);
  return (
    <>
      <PageHeading
        title="Activity"
        description="A local audit trail of synchronization, diagnostic changes, and approved operations."
      />
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search activity…" />
        </div>
        <RepositoryFilter />
        <FilterSelect label="Activity type" parameter="kind">
          <option value="">All event types</option>
          {kinds.map((kind) => (
            <option key={kind} value={kind}>
              {kind.replaceAll('_', ' ')}
            </option>
          ))}
        </FilterSelect>
        <span className="filter-count">{events.length} events</span>
      </div>
      <Panel>
        {events.length ? (
          <div className="activity-list">
            {page.map((event) => (
              <div className="activity-row" key={event.id}>
                <div className={`activity-icon ${event.kind.includes('fail') ? 'bad' : ''}`}>
                  {event.kind.includes('sync') ? (
                    <RefreshCw size={15} />
                  ) : event.kind.includes('action') ? (
                    <ShieldCheck size={16} />
                  ) : event.kind.includes('finding') ? (
                    <CircleAlert size={16} />
                  ) : (
                    <Activity size={16} />
                  )}
                </div>
                <div>
                  <div className="activity-message">{event.message}</div>
                  <div className="finding-meta">
                    <Badge>{event.kind.replaceAll('_', ' ')}</Badge>
                    {event.repository && (
                      <Link to={repositoryHref(event.repository)}>{event.repository}</Link>
                    )}
                  </div>
                </div>
                <time dateTime={event.createdAt} title={dateLabel(event.createdAt)}>
                  {relative(event.createdAt)}
                </time>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No activity to display">
            Synchronization and action events will be recorded here.
          </Empty>
        )}
      </Panel>
      <Pagination total={events.length} size={20} />
      <p className="muted small">
        Events belong to the {data.mode} workspace. Local retention preferences apply.
      </p>
    </>
  );
}
