import type { WorkflowRun } from '@gitnostics/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { workflowTrend } from './workflow-calendar';

function run(createdAt: string, conclusion = 'success'): WorkflowRun {
  return {
    id: 1,
    workflowId: 1,
    name: 'Fixture workflow',
    title: 'Fixture run',
    branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion,
    url: 'https://github.com/example/project/actions/runs/1',
    createdAt,
    updatedAt: createdAt,
    durationSeconds: 1,
    attempt: 1,
    jobs: [],
  };
}

const label = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

afterEach(() => vi.unstubAllEnvs());

describe('workflow pulse UTC calendar', () => {
  it.each([
    { timeZone: 'America/New_York', now: '2026-10-20T03:30:00Z', localDay: 19 },
    { timeZone: 'Pacific/Kiritimati', now: '2026-10-20T10:30:00Z', localDay: 21 },
  ])('keeps labels and run buckets aligned in $timeZone', ({ timeZone, now, localDay }) => {
    vi.stubEnv('TZ', timeZone);
    expect(new Date(now).getDate()).toBe(localDay);
    const trend = workflowTrend(
      [
        run('2026-10-19T23:59:59Z', 'failure'),
        run('2026-10-20T00:00:00Z'),
        run('2026-10-20T23:59:59Z'),
        run('2026-10-21T00:00:00Z', 'failure'),
      ],
      new Date(now),
    );
    expect(trend).toHaveLength(14);
    expect(trend.at(0)).toEqual({ day: label('2026-10-07'), success: 0, failure: 0 });
    expect(trend.at(-2)).toEqual({ day: label('2026-10-19'), success: 0, failure: 1 });
    expect(trend.at(-1)).toEqual({ day: label('2026-10-20'), success: 2, failure: 0 });
  });

  it('includes 14 consecutive UTC dates across a local daylight-saving transition', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const runs = Array.from({ length: 14 }, (_, index) => {
      const date = String(index + 1).padStart(2, '0');
      return run(`2026-11-${date}T00:00:00Z`);
    });
    const trend = workflowTrend(runs, new Date('2026-11-14T00:30:00Z'));
    expect(trend.map((day) => day.day)).toEqual(
      Array.from({ length: 14 }, (_, index) =>
        label(`2026-11-${String(index + 1).padStart(2, '0')}`),
      ),
    );
    expect(trend.map((day) => day.success)).toEqual(Array<number>(14).fill(1));
    expect(trend.map((day) => day.failure)).toEqual(Array<number>(14).fill(0));
  });

  it('excludes runs outside the UTC window and counts supported failed conclusions', () => {
    const trend = workflowTrend(
      [
        run('2026-10-06T23:59:59Z'),
        run('2026-10-07T00:00:00Z'),
        run('2026-10-20T00:00:00Z', 'timed_out'),
        run('2026-10-20T01:00:00Z', 'action_required'),
        run('2026-10-20T02:00:00Z', 'startup_failure'),
        run('2026-10-20T03:00:00Z', 'cancelled'),
      ],
      new Date('2026-10-20T12:00:00Z'),
    );
    expect(trend.at(0)).toEqual({ day: label('2026-10-07'), success: 1, failure: 0 });
    expect(trend.at(-1)).toEqual({ day: label('2026-10-20'), success: 0, failure: 3 });
  });
});
