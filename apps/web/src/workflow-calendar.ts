import type { WorkflowRun } from '@gitnostics/shared';
import { failed } from './format';

export function workflowTrend(runs: WorkflowRun[], now = new Date()) {
  return Array.from({ length: 14 }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (13 - index));
    const day = date.toISOString().slice(0, 10);
    const dayRuns = runs.filter((run) => run.createdAt.slice(0, 10) === day);
    return {
      day: date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      }),
      success: dayRuns.filter((run) => run.conclusion === 'success').length,
      failure: dayRuns.filter(failed).length,
    };
  });
}
