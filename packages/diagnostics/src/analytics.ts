import type { Artifact, WorkflowRun } from '@gitnostics/shared';

export interface WorkflowAnalytics {
  workflowId: number;
  name: string;
  totalRuns: number;
  completedRuns: number;
  successfulRuns: number;
  failedRuns: number;
  cancelledRuns: number;
  runningRuns: number;
  rerunCount: number;
  successRate: number | null;
  failureRate: number | null;
  averageDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  recentRegression: boolean;
  repeatedFailingJobs: { name: string; failures: number }[];
  daily: {
    date: string;
    successes: number;
    failures: number;
    averageDurationSeconds: number | null;
  }[];
}

const failed = (run: WorkflowRun): boolean =>
  ['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion ?? '');
const validDuration = (run: WorkflowRun): boolean =>
  run.status === 'completed' && Number.isFinite(run.durationSeconds) && run.durationSeconds >= 0;
const average = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/** Rates exclude cancelled, skipped, neutral and unfinished runs; all counts remain visible. */
export function workflowAnalytics(runs: WorkflowRun[]): WorkflowAnalytics[] {
  const grouped = new Map<number, WorkflowRun[]>();
  for (const run of runs) {
    const group = grouped.get(run.workflowId) ?? [];
    group.push(run);
    grouped.set(run.workflowId, group);
  }
  return [...grouped]
    .map(([workflowId, group]) => {
      const sorted = [...group].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id,
      );
      const completed = group.filter((run) => run.status === 'completed');
      const successfulRuns = completed.filter((run) => run.conclusion === 'success').length;
      const failedRuns = completed.filter(failed).length;
      const denominator = successfulRuns + failedRuns;
      const durations = completed
        .filter(validDuration)
        .map((run) => run.durationSeconds)
        .sort((a, b) => a - b);
      const mid = Math.floor(durations.length / 2);
      const medianDurationSeconds =
        durations.length === 0
          ? null
          : durations.length % 2
            ? durations[mid]!
            : (durations[mid - 1]! + durations[mid]!) / 2;
      const jobs = new Map<string, Set<number>>();
      const days = new Map<string, WorkflowRun[]>();
      for (const run of group) {
        const date = new Date(run.createdAt);
        if (Number.isFinite(date.getTime())) {
          const key = date.toISOString().slice(0, 10);
          days.set(key, [...(days.get(key) ?? []), run]);
        }
        for (const job of run.jobs) {
          if (
            !['failure', 'timed_out', 'startup_failure', 'action_required'].includes(
              job.conclusion ?? '',
            )
          )
            continue;
          const failures = jobs.get(job.name) ?? new Set<number>();
          failures.add(run.id);
          jobs.set(job.name, failures);
        }
      }
      const decisive = sorted.filter(
        (run) => run.status === 'completed' && (run.conclusion === 'success' || failed(run)),
      );
      return {
        workflowId,
        name: sorted[0]?.name ?? '',
        totalRuns: group.length,
        completedRuns: completed.length,
        successfulRuns,
        failedRuns,
        cancelledRuns: completed.filter((run) => run.conclusion === 'cancelled').length,
        runningRuns: group.length - completed.length,
        rerunCount: group.reduce((count, run) => count + Math.max(0, run.attempt - 1), 0),
        successRate: denominator ? successfulRuns / denominator : null,
        failureRate: denominator ? failedRuns / denominator : null,
        averageDurationSeconds: average(durations),
        medianDurationSeconds,
        recentRegression: Boolean(
          decisive[0] &&
          failed(decisive[0]) &&
          decisive.slice(1, 6).some((run) => run.conclusion === 'success'),
        ),
        repeatedFailingJobs: [...jobs]
          .filter(([, ids]) => ids.size > 1)
          .map(([name, ids]) => ({ name, failures: ids.size }))
          .sort((a, b) => b.failures - a.failures || a.name.localeCompare(b.name)),
        daily: [...days]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, dayRuns]) => ({
            date,
            successes: dayRuns.filter(
              (run) => run.status === 'completed' && run.conclusion === 'success',
            ).length,
            failures: dayRuns.filter((run) => run.status === 'completed' && failed(run)).length,
            averageDurationSeconds: average(
              dayRuns.filter(validDuration).map((run) => run.durationSeconds),
            ),
          })),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.workflowId - b.workflowId);
}

export interface ArtifactRecommendation {
  artifactId: number;
  name: string;
  sizeBytes: number;
  ageDays: number | null;
  reasons: ('age' | 'size')[];
  expiresAt: string;
  runId?: number;
}

export const LARGE_ARTIFACT_BYTES = 100 * 1024 * 1024;

/** Current retained metadata only; these are review candidates, never billing or automatic deletion estimates. */
export function artifactRecommendations(
  artifacts: Artifact[],
  ageDays = 30,
  now = new Date(),
): ArtifactRecommendation[] {
  const threshold = Number.isFinite(ageDays) && ageDays >= 1 ? ageDays : 30;
  const nowMs = now.getTime();
  return artifacts
    .flatMap((artifact): ArtifactRecommendation[] => {
      const expiryMs = Date.parse(artifact.expiresAt);
      if (artifact.expired || (Number.isFinite(expiryMs) && expiryMs <= nowMs)) return [];
      const createdMs = Date.parse(artifact.createdAt);
      const age =
        Number.isFinite(createdMs) && Number.isFinite(nowMs)
          ? Math.max(0, Math.floor((nowMs - createdMs) / 86_400_000))
          : null;
      const reasons: ArtifactRecommendation['reasons'] = [];
      if (age !== null && age >= threshold) reasons.push('age');
      if (artifact.sizeBytes >= LARGE_ARTIFACT_BYTES) reasons.push('size');
      if (!reasons.length) return [];
      return [
        {
          artifactId: artifact.id,
          name: artifact.name,
          sizeBytes: artifact.sizeBytes,
          ageDays: age,
          reasons,
          expiresAt: artifact.expiresAt,
          ...(artifact.runId === undefined ? {} : { runId: artifact.runId }),
        },
      ];
    })
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.artifactId - b.artifactId);
}
