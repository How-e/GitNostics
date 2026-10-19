import type { Finding, RepositoryRecord, WorkflowRun } from '@gitnostics/shared';

export const dateLabel = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not yet synchronized';
export const relative = (value?: string | null) => {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Never synced';
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : `${Math.floor(minutes / 1440)}d ago`;
};
export const duration = (seconds: number) =>
  `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
export const unresolved = (finding: Finding) =>
  !['resolved', 'suppressed'].includes(finding.status);
export const failed = (run: WorkflowRun) =>
  ['failure', 'timed_out', 'action_required', 'startup_failure'].includes(run.conclusion ?? '');
export const repositoryHref = (name: string) =>
  `/repositories/${name.split('/').map(encodeURIComponent).join('/')}`;
export const repoPath = (name: string) =>
  `/api/repositories/${name.split('/').map(encodeURIComponent).join('/')}`;
export const latestSync = (repos: RepositoryRecord[]) =>
  repos
    .map((r) => r.syncedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
    .at(-1);
export const safeExternalUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
};
