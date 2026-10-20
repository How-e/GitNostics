import { DeferredContent } from './deferred-content';
import { lazy, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  ArrowUpRight,
  Box,
  CheckSquare,
  Database,
  HardDrive,
  LockKeyhole,
  Play,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import type { ActionKind, Artifact } from '@gitnostics/shared';
import { bytesLabel } from '@gitnostics/shared';
import { useApp } from './context';
import {
  Badge,
  Empty,
  ExternalLink,
  FilterSelect,
  Modal,
  PageHeading,
  Pagination,
  Panel,
  RepositoryFilter,
  SearchField,
  usePage,
} from './components';
import { dateLabel, duration, relative } from './format';

interface ArtifactRow {
  artifact: Artifact;
  repository: string;
  syncedAt: string | null;
}
const artifactKey = (row: ArtifactRow) => `${row.repository}:${row.artifact.id}`;

const StorageChart = lazy(() =>
  import('./charts').then((module) => ({ default: module.StorageChart })),
);

export function StoragePage() {
  const { data, mode, busy, preview } = useApp();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').toLowerCase();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cleanup, setCleanup] = useState(false);
  useEffect(() => {
    setSelected(new Set());
    setCleanup(false);
  }, [mode]);
  const allArtifacts: ArtifactRow[] = data.repositories.flatMap((repository) =>
    (repository.snapshot?.artifacts ?? []).map((artifact) => ({
      artifact,
      repository: repository.fullName,
      syncedAt: repository.syncedAt,
    })),
  );
  const oldEnough = (artifact: Artifact) =>
    Date.parse(artifact.createdAt) < Date.now() - data.settings.artifactAgeDays * 86_400_000;
  const artifacts = allArtifacts
    .filter(
      (row) =>
        (!params.get('repo') || row.repository === params.get('repo')) &&
        row.artifact.name.toLowerCase().includes(q) &&
        (!params.get('age') ||
          (params.get('age') === 'old' ? oldEnough(row.artifact) : row.artifact.expired)),
    )
    .sort((a, b) =>
      params.get('sort') === 'oldest'
        ? a.artifact.createdAt.localeCompare(b.artifact.createdAt)
        : params.get('sort') === 'expires'
          ? a.artifact.expiresAt.localeCompare(b.artifact.expiresAt)
          : b.artifact.sizeBytes - a.artifact.sizeBytes,
    );
  const page = usePage(artifacts);
  const selectedArtifacts = allArtifacts.filter((row) => selected.has(artifactKey(row)));
  const selectedRepos = [...new Set(selectedArtifacts.map((row) => row.repository))];
  const totalBytes = artifacts.reduce((sum, row) => sum + row.artifact.sizeBytes, 0);
  const oldBytes = artifacts
    .filter((row) => oldEnough(row.artifact))
    .reduce((sum, row) => sum + row.artifact.sizeBytes, 0);
  const cacheBytes = data.repositories
    .filter((r) => !params.get('repo') || r.fullName === params.get('repo'))
    .reduce((sum, r) => sum + (r.snapshot?.cacheBytes ?? 0), 0);
  const historyByDate = new Map<string, number>();
  const histories = data.storageHistory.filter(
    (h) => !params.get('repo') || h.repository === params.get('repo'),
  );
  // A repository can be synchronized several times a day; keep only its last daily sample.
  const dailySamples = new Map<string, { repository: string; capturedAt: string; bytes: number }>();
  for (const item of histories) {
    const key = `${item.repository}:${item.capturedAt.slice(0, 10)}`;
    const existing = dailySamples.get(key);
    if (!existing || existing.capturedAt < item.capturedAt) dailySamples.set(key, item);
  }
  for (const item of dailySamples.values()) {
    const key = item.capturedAt.slice(0, 10);
    historyByDate.set(key, (historyByDate.get(key) ?? 0) + item.bytes);
  }
  const chart = [...historyByDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, bytes]) => ({ day, megabytes: Math.round(bytes / 104857.6) / 10 }));
  const toggle = (key: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return (
    <>
      <PageHeading
        title="Artifact & storage analysis"
        description="Know what is retained, what is aging, and what a cleanup would affect."
        action={
          <button
            className="button"
            disabled={!selectedArtifacts.length || busy}
            onClick={() => setCleanup(true)}
          >
            <ShieldCheck size={15} />
            Review cleanup{selectedArtifacts.length > 0 ? ` (${selectedArtifacts.length})` : ''}
          </button>
        }
      />
      <div className="storage-stats">
        <div>
          <span>Retained artifact storage</span>
          <strong>{bytesLabel(totalBytes)}</strong>
          <small>{artifacts.length} artifacts in current view</small>
        </div>
        <div>
          <span>Older than {data.settings.artifactAgeDays} days</span>
          <strong className={oldBytes ? 'warn' : ''}>{bytesLabel(oldBytes)}</strong>
          <small>Review candidates, never auto-deleted</small>
        </div>
        <div>
          <span>Reported Actions cache</span>
          <strong>{bytesLabel(cacheBytes)}</strong>
          <small>May be incomplete with limited permissions</small>
        </div>
      </div>
      <Panel
        title="Recorded storage snapshots"
        description="Artifacts observed at synchronization time. Daily samples include only repositories observed that day."
      >
        {chart.length ? (
          <div className="chart-container storage-chart">
            <DeferredContent label="Loading chart..." chart>
              <StorageChart data={chart} />
            </DeferredContent>
          </div>
        ) : (
          <Empty title="No historical snapshots yet">
            Synchronize to record the current retained artifact storage.
          </Empty>
        )}
      </Panel>
      <div className="filter-bar">
        <div className="search-wrap">
          <Search size={15} />
          <SearchField placeholder="Search artifact names…" />
        </div>
        <RepositoryFilter />
        <FilterSelect label="Artifact age" parameter="age">
          <option value="">All ages</option>
          <option value="old">Older than {data.settings.artifactAgeDays} days</option>
          <option value="expired">Reported expired</option>
        </FilterSelect>
        <FilterSelect label="Sort artifacts" parameter="sort">
          <option value="">Largest first</option>
          <option value="oldest">Oldest first</option>
          <option value="expires">Expiration date</option>
        </FilterSelect>
        <span className="filter-count">{artifacts.length} artifacts</span>
      </div>
      {selectedArtifacts.length > 0 && (
        <div className="selection-bar">
          <CheckSquare size={15} />
          <span>
            {selectedArtifacts.length} selected ·{' '}
            {bytesLabel(selectedArtifacts.reduce((sum, row) => sum + row.artifact.sizeBytes, 0))} ·{' '}
            {selectedRepos.length} repositor{selectedRepos.length === 1 ? 'y' : 'ies'}
          </span>
          <button onClick={() => setSelected(new Set())}>
            Clear selection <X size={13} />
          </button>
        </div>
      )}
      <Panel>
        <div className="table-scroll">
          <table className="artifact-table">
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <input
                    type="checkbox"
                    aria-label="Select artifacts on this page"
                    checked={page.length > 0 && page.every((row) => selected.has(artifactKey(row)))}
                    disabled={!page.length}
                    onChange={(event) =>
                      setSelected((previous) => {
                        const next = new Set(previous);
                        for (const row of page) {
                          if (event.target.checked) next.add(artifactKey(row));
                          else next.delete(artifactKey(row));
                        }
                        return next;
                      })
                    }
                  />
                </th>
                <th>Artifact</th>
                <th>Size</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Assessment</th>
              </tr>
            </thead>
            <tbody>
              {page.map((row) => (
                <tr
                  key={artifactKey(row)}
                  className={selected.has(artifactKey(row)) ? 'selected-row' : ''}
                >
                  <td className="checkbox-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select ${row.artifact.name} in ${row.repository}`}
                      checked={selected.has(artifactKey(row))}
                      onChange={() => toggle(artifactKey(row))}
                    />
                  </td>
                  <td>
                    <div className="artifact-name">
                      <Box size={16} />
                      <strong>{row.artifact.name}</strong>
                    </div>
                    <span className="table-subtext">
                      {row.repository}
                      {row.artifact.runId ? (
                        <>
                          {' '}
                          ·{' '}
                          <ExternalLink
                            href={`https://github.com/${row.repository}/actions/runs/${row.artifact.runId}`}
                          >
                            Run #{row.artifact.runId}
                          </ExternalLink>
                        </>
                      ) : null}
                    </span>
                    <span className="cached small" title={dateLabel(row.syncedAt)}>
                      Cached {relative(row.syncedAt)}
                    </span>
                  </td>
                  <td data-label="Size" className="mono">
                    {bytesLabel(row.artifact.sizeBytes)}
                  </td>
                  <td data-label="Created">
                    <time title={dateLabel(row.artifact.createdAt)}>
                      {relative(row.artifact.createdAt)}
                    </time>
                  </td>
                  <td data-label="Expires">
                    <time title={dateLabel(row.artifact.expiresAt)}>
                      {new Date(row.artifact.expiresAt).toLocaleDateString()}
                    </time>
                  </td>
                  <td data-label="Assessment">
                    {row.artifact.expired ? (
                      <Badge>Reported expired</Badge>
                    ) : oldEnough(row.artifact) ? (
                      <Badge tone="medium">Review retention</Badge>
                    ) : (
                      <Badge>Retained</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!artifacts.length && (
          <Empty title="No retained artifacts in this view" icon={<Database size={25} />}>
            Synchronize your repositories or adjust the artifact filters.
          </Empty>
        )}
      </Panel>
      <Pagination total={artifacts.length} />
      <div className="quiet-note">
        <CircleStorageIcon />
        <p>
          These are cached retained artifact sizes, not historical billing totals. GitHub
          compression, retention, cache access, and billing calculations can differ. Storage
          selection never deletes data automatically.
        </p>
      </div>
      <Modal
        open={cleanup}
        onOpenChange={setCleanup}
        title="Review selected cleanup"
        description="Each repository requires a separate impact preview and exact-text confirmation."
        wide
      >
        <div className="permission-notice">
          <ShieldCheck size={18} />
          <p>
            {mode === 'demo'
              ? 'Every action in this workspace is simulated. No GitHub mutation will occur.'
              : 'A preview does not delete anything. GitHub writes require server opt-in, operator authentication, and repository permissions.'}
          </p>
        </div>
        {selectedRepos.map((repository) => {
          const rows = selectedArtifacts.filter((row) => row.repository === repository);
          return (
            <div className="cleanup-group" key={repository}>
              <div>
                <strong>{repository}</strong>
                <span>
                  {rows.length} artifacts ·{' '}
                  {bytesLabel(rows.reduce((sum, row) => sum + row.artifact.sizeBytes, 0))}
                </span>
              </div>
              <button
                className="button"
                disabled={busy || rows.length > 100}
                onClick={() => {
                  setCleanup(false);
                  void preview({
                    repository,
                    kind: 'delete_artifacts',
                    artifactIds: rows.map((row) => row.artifact.id),
                  });
                }}
              >
                <Trash2 size={14} />
                Preview deletion
              </button>
              {rows.length > 100 && (
                <p className="error-message">
                  Select no more than 100 artifacts per repository for one operation.
                </p>
              )}
              <ul className="cleanup-artifacts">
                {rows.map((row) => (
                  <li key={row.artifact.id}>
                    <span>{row.artifact.name}</span>
                    <span className="mono">{bytesLabel(row.artifact.sizeBytes)}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </Modal>
    </>
  );
}
function CircleStorageIcon() {
  return <HardDrive size={17} />;
}

export function SafeActionsPage() {
  const { data, mode, busy, preview } = useApp();
  const [params] = useSearchParams();
  const initial = params.get('repo') ?? data.repositories[0]?.fullName ?? '';
  const [repository, setRepository] = useState(initial);
  const [kind, setKind] = useState<ActionKind>('rerun_failed');
  const [runId, setRunId] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [ref, setRef] = useState('');
  const record = data.repositories.find((r) => r.fullName === repository);
  const runs = record?.snapshot?.runs ?? [];
  const workflows = [
    ...new Map(
      runs.map((run) => [run.workflowId, { id: run.workflowId, name: run.name }]),
    ).values(),
  ];
  useEffect(() => {
    setRepository(params.get('repo') ?? data.repositories[0]?.fullName ?? '');
    setRunId('');
    setWorkflowId('');
    setRef('');
  }, [mode, params, data.repositories.length]);
  return (
    <>
      <PageHeading
        title="Safe action center"
        description="A deliberate path from evidence to resolution. Preview first, confirm explicitly."
        action={
          <Badge
            tone={
              mode === 'demo' ? 'medium' : data.connection.writesEnabled ? 'success' : 'neutral'
            }
          >
            <LockKeyhole size={12} />
            {mode === 'demo'
              ? 'Simulation only'
              : data.connection.writesEnabled
                ? 'Writes opted in'
                : 'Read-only by default'}
          </Badge>
        }
      />
      <div className="safe-action-intro">
        <div className="safe-action-symbol">
          <ShieldCheck size={29} />
        </div>
        <div>
          <h2>You stay in control of every operation.</h2>
          <p>
            GitNostics checks permissions, explains the impact, and records the outcome. Every
            execution needs a valid preview and your exact confirmation.
          </p>
        </div>
      </div>
      <div className="safe-action-layout">
        <Panel
          title="Prepare an operation"
          description="Nothing executes when you request a preview."
        >
          <form
            className="action-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (kind === 'dispatch')
                void preview({
                  repository,
                  kind,
                  workflowId: Number(workflowId),
                  ref: ref || record?.snapshot?.defaultBranch || 'main',
                });
              else if (kind !== 'delete_artifacts')
                void preview({ repository, kind, runId: Number(runId) });
            }}
          >
            <label>
              Repository
              <select
                required
                aria-label="Action repository"
                value={repository}
                onChange={(event) => {
                  setRepository(event.target.value);
                  setRunId('');
                  setWorkflowId('');
                  setRef('');
                }}
              >
                <option value="">Select repository</option>
                {data.repositories.map((r) => (
                  <option key={r.fullName}>{r.fullName}</option>
                ))}
              </select>
            </label>
            <label>
              Operation
              <select
                aria-label="Operation"
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as ActionKind);
                  setRunId('');
                }}
              >
                <option value="rerun_failed">Rerun failed jobs</option>
                <option value="rerun">Rerun workflow</option>
                <option value="dispatch">Dispatch workflow</option>
                <option value="delete_artifacts">Delete selected artifacts</option>
              </select>
            </label>
            {kind === 'delete_artifacts' ? (
              <div className="form-note">
                Select the exact artifacts in Storage, then review cleanup.
                <Link className="button" to={`/storage?repo=${encodeURIComponent(repository)}`}>
                  <Database size={15} />
                  Select artifacts
                </Link>
              </div>
            ) : kind === 'dispatch' ? (
              <>
                <label>
                  Cached workflow
                  <select
                    aria-label="Workflow"
                    required
                    value={workflowId}
                    onChange={(event) => setWorkflowId(event.target.value)}
                  >
                    <option value="">Select a workflow</option>
                    {workflows.map((workflow) => (
                      <option key={workflow.id} value={workflow.id}>
                        {workflow.name} (#{workflow.id})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Branch or tag
                  <input
                    aria-label="Dispatch reference"
                    placeholder={record?.snapshot?.defaultBranch ?? 'main'}
                    value={ref}
                    onChange={(event) => setRef(event.target.value)}
                    maxLength={255}
                  />
                </label>
                <p className="form-note">
                  The workflow must support <code>workflow_dispatch</code>. The server verifies
                  permitted operations; GitHub may reject unsupported workflows.
                </p>
              </>
            ) : (
              <label>
                Completed workflow run
                <select
                  aria-label="Workflow run"
                  required
                  value={runId}
                  onChange={(event) => setRunId(event.target.value)}
                >
                  <option value="">Select a cached run</option>
                  {runs
                    .filter((run) => run.status === 'completed')
                    .map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.name} #{run.id} · {run.conclusion ?? 'unknown'} ·{' '}
                        {duration(run.durationSeconds)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {kind !== 'delete_artifacts' && (
              <button
                className="button primary"
                disabled={busy || !repository || (kind === 'dispatch' ? !workflowId : !runId)}
              >
                <ShieldCheck size={16} />
                Preview operation
              </button>
            )}
            {!data.repositories.length && (
              <p className="form-note">
                Add and synchronize a repository to prepare supported actions.
              </p>
            )}
          </form>
        </Panel>
        <div className="safe-action-notes">
          <Panel title="Available operations">
            <div className="operation-list">
              <div>
                <Play size={17} />
                <div>
                  <h3>Workflow reruns</h3>
                  <p>Rerun failed jobs or an entire completed workflow from cached evidence.</p>
                </div>
              </div>
              <div>
                <Database size={17} />
                <div>
                  <h3>Selective artifact cleanup</h3>
                  <p>
                    Choose exact artifact IDs, inspect retained size, and confirm each repository
                    separately.
                  </p>
                </div>
              </div>
              <div>
                <ArrowUpRight size={17} />
                <div>
                  <h3>Workflow dispatch</h3>
                  <p>Request an explicitly selected workflow on a branch or tag.</p>
                </div>
              </div>
            </div>
          </Panel>
          <div className="permission-notice">
            <LockKeyhole size={19} />
            <div>
              <strong>
                {mode === 'demo'
                  ? 'Isolated demo environment'
                  : data.connection.writesEnabled
                    ? 'Writes are enabled for this operator'
                    : 'GitHub writes are currently closed'}
              </strong>
              <p>
                {mode === 'demo'
                  ? 'Previews and confirmations work locally. Every execution is recorded as a simulation.'
                  : 'Live operations require server write opt-in, an authenticated operator, accessible resources, and sufficient GitHub App permissions. Previews explain unavailable operations.'}
              </p>
              <Link to="/settings" className="text-link">
                Review connection and permissions <ArrowUpRight size={13} />
              </Link>
            </div>
          </div>
          <Link className="button" to="/activity">
            View action audit history <ArrowUpRight size={14} />
          </Link>
        </div>
      </div>
    </>
  );
}
