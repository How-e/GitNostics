import { DeferredContent } from './deferred-content';
import { lazy, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ExternalLink as ExternalIcon,
  GitBranch,
  GitPullRequest,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import type { PullRequest, RepositoryRecord, WorkflowRun } from '@gitnostics/shared';
import { useApp } from './context';
import {
  Badge,
  Cached,
  Empty,
  ExternalLink,
  FilterSelect,
  FindingRows,
  Modal,
  PageHeading,
  Pagination,
  Panel,
  RepositoryFilter,
  SearchField,
  Status,
  usePage,
} from './components';
import { dateLabel, duration, relative, repositoryHref, unresolved } from './format';

interface PRRow {
  repository: RepositoryRecord;
  pr: PullRequest;
}
const incompleteMergeEvidence = ({ repository, pr }: PRRow) =>
  !pr.protectionKnown ||
  pr.mergeable === null ||
  pr.checksComplete === false ||
  pr.reviewsComplete === false ||
  repository.snapshot?.collectionState?.pullRequests === false;

interface RunRow {
  repository: RepositoryRecord;
  run: WorkflowRun;
}

const DurationChart = lazy(() =>
  import('./charts').then((module) => ({ default: module.DurationChart })),
);

export function PullRequestsPage() {
  const { data, mode } = useApp();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').toLowerCase();
  const [selection, setSelection] = useState<{
    mode: typeof mode;
    repository: string;
    number: number;
  }>();
  const selectedRepository = data.repositories.find(
    (repository) => repository.fullName === selection?.repository,
  );
  const selectedPR = selectedRepository?.snapshot?.pullRequests.find(
    (pr) => pr.number === selection?.number,
  );
  const selected: PRRow | undefined =
    selection?.mode === mode && selectedRepository && selectedPR
      ? { repository: selectedRepository, pr: selectedPR }
      : undefined;
  useEffect(() => setSelection(undefined), [mode]);
  const findingsFor = (row: PRRow) =>
    data.findings.filter(
      (f) =>
        f.repository === row.repository.fullName &&
        f.type === 'pull_request' &&
        (f.resourceUrl === row.pr.url ||
          f.evidence.some((e) => e.value === String(row.pr.number) || e.url === row.pr.url)) &&
        unresolved(f),
    );
  const rows = data.repositories
    .flatMap((repository) =>
      (repository.snapshot?.pullRequests ?? []).map((pr) => ({ repository, pr })),
    )
    .filter(
      (row) =>
        (!params.get('repo') || row.repository.fullName === params.get('repo')) &&
        `${row.pr.title} ${row.pr.author} ${row.pr.number}`.toLowerCase().includes(q) &&
        (!params.get('state') ||
          (params.get('state') === 'draft'
            ? row.pr.draft
            : params.get('state') === 'unknown'
              ? incompleteMergeEvidence(row)
              : findingsFor(row).length > 0)),
    )
    .sort((a, b) => b.pr.updatedAt.localeCompare(a.pr.updatedAt));
  const page = usePage(rows);
  return (
    <>
      <PageHeading
        title="Pull request diagnostics"
        description="Understand what blocks a merge, what is known, and what still needs verification."
      />
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search pull requests…" />
        </div>
        <RepositoryFilter />
        <FilterSelect label="Pull request state" parameter="state">
          <option value="">All open pull requests</option>
          <option value="blocked">With diagnostic findings</option>
          <option value="draft">Drafts</option>
          <option value="unknown">Incomplete evidence</option>
        </FilterSelect>
        <span className="filter-count">{rows.length} pull requests</span>
      </div>
      <Panel>
        {rows.length ? (
          <div className="pr-list">
            {page.map((row) => (
              <article className="pr-row" key={`${row.repository.fullName}:${row.pr.number}`}>
                <GitPullRequest className={findingsFor(row).length ? 'warn' : 'good'} size={21} />
                <div className="pr-main">
                  <button
                    className="title-button"
                    onClick={() =>
                      setSelection({
                        mode,
                        repository: row.repository.fullName,
                        number: row.pr.number,
                      })
                    }
                  >
                    {row.pr.title}
                  </button>
                  <div className="finding-meta">
                    <Link to={repositoryHref(row.repository.fullName)}>
                      {row.repository.fullName}
                    </Link>
                    <span className="mono">#{row.pr.number}</span>
                    <span>by {row.pr.author}</span>
                    <span>{relative(row.pr.updatedAt)}</span>
                  </div>
                  <div className="pr-signals">
                    {row.pr.draft ? <Badge>Draft</Badge> : null}
                    {findingsFor(row).length ? (
                      <Badge tone="medium">
                        {findingsFor(row).length} diagnostic finding
                        {findingsFor(row).length !== 1 ? 's' : ''}
                      </Badge>
                    ) : !incompleteMergeEvidence(row) ? (
                      <Badge>No supported blockers found</Badge>
                    ) : null}
                    {incompleteMergeEvidence(row) && <Badge>Incomplete merge evidence</Badge>}
                    <span>
                      <CheckCircle2 size={13} />
                      {row.pr.checks.filter((c) => c.status === 'success').length}/
                      {row.pr.checks.length} checks passed
                    </span>
                    <span>
                      {row.pr.approvals} approval{row.pr.approvals !== 1 ? 's' : ''}
                    </span>
                  </div>
                </div>
                <div className="pr-right">
                  <Cached repository={row.repository} />
                  <ExternalLink href={row.pr.url}>GitHub</ExternalLink>
                  <button
                    className="text-link"
                    onClick={() =>
                      setSelection({
                        mode,
                        repository: row.repository.fullName,
                        number: row.pr.number,
                      })
                    }
                  >
                    Investigate <ArrowRight size={13} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <Empty title="No pull requests in this view" icon={<GitPullRequest size={25} />}>
            Synchronize a monitored repository or adjust the current filters.
          </Empty>
        )}
      </Panel>
      <Pagination total={rows.length} />
      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelection(undefined);
        }}
        title={selected ? `#${selected.pr.number} ${selected.pr.title}` : 'Pull request'}
        description="Merge diagnostics from the most recently cached GitHub evidence."
        wide
      >
        {selected && (
          <>
            <div className="inline-meta">
              <Badge>{selected.repository.fullName}</Badge>
              <Badge>{selected.pr.baseBranch}</Badge>
              <ExternalLink href={selected.pr.url}>Open pull request</ExternalLink>
            </div>
            {!selected.pr.protectionKnown && (
              <div className="permission-notice">
                <CircleHelp size={18} />
                <p>
                  Branch protection evidence is unavailable. Check results alone do not establish
                  merge eligibility.
                </p>
              </div>
            )}
            {selected.pr.mergeable === null && (
              <div className="permission-notice">
                <CircleHelp size={18} />
                <p>Mergeability is unavailable. Merge eligibility still needs verification.</p>
              </div>
            )}
            {(selected.pr.checksComplete === false ||
              (selected.pr.checksComplete === undefined &&
                selected.repository.snapshot?.collectionState?.pullRequests === false)) && (
              <div className="permission-notice">
                <CircleHelp size={18} />
                <p>Check evidence is incomplete. Missing results may not have been collected.</p>
              </div>
            )}
            {(selected.pr.reviewsComplete === false ||
              (selected.pr.reviewsComplete === undefined &&
                selected.repository.snapshot?.collectionState?.pullRequests === false)) && (
              <div className="permission-notice">
                <CircleHelp size={18} />
                <p>Review evidence is incomplete. Approval counts may omit reviews.</p>
              </div>
            )}
            <dl className="observation-meta">
              <div>
                <dt>Mergeability</dt>
                <dd>
                  {selected.pr.mergeable === null
                    ? 'Unknown'
                    : selected.pr.mergeable
                      ? 'No conflicts observed'
                      : 'Conflicts reported'}
                </dd>
              </div>
              <div>
                <dt>Merge state</dt>
                <dd>{selected.pr.mergeableState}</dd>
              </div>
              <div>
                <dt>Review approvals</dt>
                <dd>
                  {selected.pr.approvals} / {selected.pr.requiredApprovals ?? 'unknown requirement'}
                </dd>
              </div>
              <div>
                <dt>Head revision</dt>
                <dd className="mono">{selected.pr.headSha.slice(0, 12)}</dd>
              </div>
            </dl>
            <div className="evidence-section">
              <h3>Check evidence</h3>
              {selected.pr.checks.length ? (
                <div className="check-list">
                  {selected.pr.checks.map((check, index) => (
                    <div key={`${check.name}:${index}`}>
                      <span>
                        {check.url ? (
                          <ExternalLink href={check.url}>{check.name}</ExternalLink>
                        ) : (
                          check.name
                        )}
                      </span>
                      <Status value={check.status} />
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No check results were returned for this head revision.</p>
              )}
            </div>
            <div className="evidence-section">
              <h3>Related diagnostic findings</h3>
              {findingsFor(selected).length ? (
                <FindingRows findings={findingsFor(selected)} compact />
              ) : (
                <p className="muted">
                  No supported blocker findings are linked to this PR. This does not guarantee it
                  can merge.
                </p>
              )}
            </div>
            <p className="muted small">
              Cached at {dateLabel(selected.repository.syncedAt)}. Review GitHub before merging;
              GitNostics never merges pull requests.
            </p>
          </>
        )}
      </Modal>
    </>
  );
}

export function ActionsPage() {
  const { data, mode, busy, preview } = useApp();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').toLowerCase();
  const [selection, setSelection] = useState<{
    mode: typeof mode;
    repository: string;
    id: number;
  }>();
  const selectedRepository = data.repositories.find(
    (repository) => repository.fullName === selection?.repository,
  );
  const selectedRun = selectedRepository?.snapshot?.runs.find((run) => run.id === selection?.id);
  const selected: RunRow | undefined =
    selection?.mode === mode && selectedRepository && selectedRun
      ? { repository: selectedRepository, run: selectedRun }
      : undefined;
  useEffect(() => setSelection(undefined), [mode]);
  const all = data.repositories
    .flatMap((repository) => (repository.snapshot?.runs ?? []).map((run) => ({ repository, run })))
    .filter(
      (row) =>
        (!params.get('repo') || row.repository.fullName === params.get('repo')) &&
        `${row.run.name} ${row.run.title} ${row.run.branch}`.toLowerCase().includes(q),
    );
  const runs = all
    .filter(
      (row) =>
        !params.get('conclusion') ||
        (row.run.conclusion ?? row.run.status) === params.get('conclusion'),
    )
    .sort((a, b) => b.run.createdAt.localeCompare(a.run.createdAt));
  const page = usePage(runs);
  const workflows = data.workflowAnalytics.filter((workflow) =>
    all.some(
      (row) =>
        row.repository.fullName === workflow.repository &&
        row.run.workflowId === workflow.workflowId,
    ),
  );
  const trend = [...all]
    .sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt))
    .slice(-30)
    .map((row) => ({
      name: `#${row.run.id}`,
      duration: Math.round(row.run.durationSeconds / 6) / 10,
      workflow: row.run.name,
    }));
  const incidents = data.incidents.filter(
    (incident) =>
      !params.get('repo') || incident.runs.some((run) => all.some((row) => row.run.id === run.id)),
  );
  return (
    <>
      <PageHeading
        title="Actions intelligence"
        description="Find recurring failures and understand workflow behavior across cached runs."
        action={
          <Link className="button" to="/safe-actions">
            <ShieldCheck size={15} />
            Safe action center
          </Link>
        }
      />
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search workflows or branches…" />
        </div>
        <RepositoryFilter />
        <FilterSelect label="Run conclusion" parameter="conclusion">
          <option value="">All conclusions</option>
          <option value="failure">Failed</option>
          <option value="success">Successful</option>
          <option value="in_progress">In progress</option>
          <option value="cancelled">Cancelled</option>
          <option value="timed_out">Timed out</option>
        </FilterSelect>
        <span className="filter-count">{runs.length} runs</span>
      </div>
      <div className="analytics-grid">
        <Panel
          title="Workflow performance"
          description="Success ÷ (success + failure); canceled, skipped, neutral and unfinished runs excluded"
        >
          {workflows.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th>Runs</th>
                    <th>Success</th>
                    <th>Avg duration</th>
                  </tr>
                </thead>
                <tbody>
                  {workflows.slice(0, 8).map((workflow) => (
                    <tr key={`${workflow.repository}:${workflow.workflowId}`}>
                      <td>
                        <strong>{workflow.name}</strong>
                        <span className="table-subtext">{workflow.repository}</span>
                        {workflow.recentRegression && (
                          <Badge tone="medium">Recent regression</Badge>
                        )}
                        {workflow.repeatedFailingJobs.map((job) => (
                          <span className="table-subtext" key={job.name}>
                            {job.name}: {job.failures} failing runs
                          </span>
                        ))}
                      </td>
                      <td>
                        {workflow.totalRuns}
                        <span className="table-subtext">
                          {workflow.failedRuns} failed · {workflow.rerunCount} reruns
                        </span>
                      </td>
                      <td>
                        <Badge tone={workflow.failedRuns ? 'medium' : 'success'}>
                          {workflow.successRate === null
                            ? 'n/a'
                            : `${Math.round(workflow.successRate * 100)}%`}
                        </Badge>
                      </td>
                      <td className="mono">
                        {workflow.averageDurationSeconds === null
                          ? 'n/a'
                          : duration(workflow.averageDurationSeconds)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No workflow evidence yet">
              Synchronize a repository to inspect workflow performance.
            </Empty>
          )}
        </Panel>
        <Panel
          title="Execution duration"
          description="Most recent 30 cached runs, in chronological order"
        >
          {trend.length ? (
            <div className="chart-container tall">
              <DeferredContent label="Loading chart..." chart>
                <DurationChart data={trend} />
              </DeferredContent>
            </div>
          ) : (
            <Empty title="No duration data">Durations appear after workflow synchronization.</Empty>
          )}
        </Panel>
      </div>
      <Panel
        title="Correlated incidents"
        description="Normalized failure signatures shared by multiple runs"
        action={<Badge>{incidents.length} groups</Badge>}
      >
        {incidents.length ? (
          <div className="incident-list">
            {incidents.map((incident) => (
              <details className="incident" key={incident.fingerprint}>
                <summary>
                  <div className="incident-count">
                    {incident.count}
                    <span>runs</span>
                  </div>
                  <div>
                    <Badge tone="medium">{incident.category.replaceAll('_', ' ')}</Badge>
                    <strong>{incident.signature}</strong>
                    <span className="muted small">
                      First seen {relative(incident.firstSeen)} · Last seen{' '}
                      {relative(incident.lastSeen)}
                    </span>
                  </div>
                  <ChevronDown size={17} />
                </summary>
                <div className="incident-body">
                  <p>
                    A shared normalized signature suggests a related cause. Review each run to
                    establish its scope.
                  </p>
                  {incident.runs.map((run, index) => (
                    <div className="incident-run" key={`${run.id}:${index}`}>
                      <ExternalLink href={run.url}>
                        {run.name} #{run.id}
                      </ExternalLink>
                      <span>{run.job}</span>
                    </div>
                  ))}
                </div>
              </details>
            ))}
          </div>
        ) : (
          <Empty title="No correlated failure groups">
            Recurring failure signatures will appear as grouped incidents when sufficient log
            evidence is available.
          </Empty>
        )}
      </Panel>
      <Panel
        title="Workflow run history"
        description="Select a run to inspect its jobs and bounded log evidence"
      >
        {runs.length ? (
          <div className="run-list">
            {page.map((row) => (
              <div className="run-row" key={`${row.repository.fullName}:${row.run.id}`}>
                <div className="run-state">
                  <Status value={row.run.conclusion ?? row.run.status} />
                </div>
                <div className="run-main">
                  <button
                    className="title-button"
                    onClick={() =>
                      setSelection({ mode, repository: row.repository.fullName, id: row.run.id })
                    }
                  >
                    {row.run.title || row.run.name}
                  </button>
                  <div className="finding-meta">
                    <span>{row.repository.fullName}</span>
                    <span>{row.run.name}</span>
                    <span>
                      <GitBranch size={11} />
                      {row.run.branch}
                    </span>
                    <span className="mono">
                      #{row.run.id} · attempt {row.run.attempt}
                    </span>
                  </div>
                </div>
                <div className="run-timing">
                  <span className="mono">{duration(row.run.durationSeconds)}</span>
                  <time title={dateLabel(row.run.createdAt)}>{relative(row.run.createdAt)}</time>
                </div>
                <button
                  className="button small-button"
                  onClick={() =>
                    setSelection({ mode, repository: row.repository.fullName, id: row.run.id })
                  }
                >
                  Inspect <ArrowUpRight size={13} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No workflow runs in this view" icon={<Play size={24} />}>
            Synchronize a repository or adjust the active filters.
          </Empty>
        )}
      </Panel>
      <Pagination total={runs.length} />
      <Modal
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelection(undefined);
        }}
        title={selected?.run.title || selected?.run.name || 'Workflow run'}
        description="Cached run metadata, job results, and available redacted log excerpts."
        wide
      >
        {selected && (
          <>
            <div className="inline-meta">
              <Status value={selected.run.conclusion ?? selected.run.status} />
              <Badge>Attempt {selected.run.attempt}</Badge>
              <ExternalLink href={selected.run.url}>View on GitHub</ExternalLink>
            </div>
            <dl className="observation-meta">
              <div>
                <dt>Repository</dt>
                <dd>{selected.repository.fullName}</dd>
              </div>
              <div>
                <dt>Trigger</dt>
                <dd>
                  {selected.run.event} · {selected.run.branch}
                </dd>
              </div>
              <div>
                <dt>Duration</dt>
                <dd>{duration(selected.run.durationSeconds)}</dd>
              </div>
              <div>
                <dt>Cached</dt>
                <dd>{dateLabel(selected.repository.syncedAt)}</dd>
              </div>
            </dl>
            <div className="evidence-section">
              <h3>Job evidence</h3>
              {selected.run.jobs.length ? (
                selected.run.jobs.map((job) => (
                  <details className="job-details" key={job.id}>
                    <summary>
                      <ExternalLink href={job.url}>{job.name}</ExternalLink>
                      <Status value={job.conclusion ?? 'pending'} />
                      <ChevronDown size={15} />
                    </summary>
                    <div>
                      {job.logExcerpt ? (
                        <pre className="log-excerpt">{job.logExcerpt}</pre>
                      ) : (
                        <p className="muted">
                          No retained log excerpt is available for this job. Follow the GitHub link
                          to inspect complete logs.
                        </p>
                      )}
                    </div>
                  </details>
                ))
              ) : (
                <p className="muted">
                  Jobs were unavailable or not included in this synchronization.
                </p>
              )}
            </div>
            <div className="dialog-actions">
              <ExternalLink className="button" href={selected.run.url}>
                Open full logs <ExternalIcon size={13} />
              </ExternalLink>
              <div>
                <button
                  className="button"
                  disabled={busy || selected.run.status !== 'completed'}
                  onClick={() => {
                    const row = selected;
                    setSelection(undefined);
                    void preview({
                      repository: row.repository.fullName,
                      kind: 'rerun_failed',
                      runId: row.run.id,
                    });
                  }}
                >
                  <RefreshCw size={14} />
                  Preview failed-job rerun
                </button>
                <button
                  className="button primary"
                  disabled={busy || selected.run.status !== 'completed'}
                  onClick={() => {
                    const row = selected;
                    setSelection(undefined);
                    void preview({
                      repository: row.repository.fullName,
                      kind: 'rerun',
                      runId: row.run.id,
                    });
                  }}
                >
                  <Play size={14} />
                  Preview rerun
                </button>
              </div>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
