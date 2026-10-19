import type { WorkflowRun } from '@gitnostics/shared';
import { failed } from './format';

export function workflowTrend(runs: WorkflowRun[], now = new Date()) {
  const counts = new Map<string, { success: number; failure: number }>();
  for (const run of runs) {
    const timestamp = Date.parse(run.createdAt);
    if (!Number.isFinite(timestamp)) continue;
    const day = new Date(timestamp).toISOString().slice(0, 10);
    const count = counts.get(day) ?? { success: 0, failure: 0 };
    if (run.conclusion === 'success') count.success += 1;
    if (failed(run)) count.failure += 1;
    counts.set(day, count);
  }
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (13 - index));
    const day = date.toISOString().slice(0, 10);
    const count = counts.get(day);
    return {
      day: date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      success: count?.success ?? 0,
      failure: count?.failure ?? 0,
    };
  });
}
