import { describe, expect, it } from 'vitest';
import type { Artifact, PullRequest, RepositorySnapshot, WorkflowRun } from '@gitnostics/shared';
import { redactLog as redactGitHubLog } from '../../github/src/logs.js';
import {
  artifactRecommendations,
  authoritativeFindingTypes,
  classifyFailure,
  configurationDriftRule,
  correlateFailures,
  diagnose,
  fingerprint,
  LOG_LIMITS,
  normalizeFailureSignature,
  redactLog,
  requiredChecksRule,
  workflowAnalytics,
} from '../src/index.js';

const now = new Date('2026-10-18T12:00:00Z');
function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 1,
    title: 'Fix checks',
    author: 'maintainer',
    url: 'https://github.com/example/project/pull/1',
    headSha: 'abc123',
    baseBranch: 'main',
    draft: false,
    mergeable: true,
    mergeableState: 'clean',
    checks: [],
    approvals: 1,
    changesRequested: false,
    updatedAt: now.toISOString(),
    requiredChecks: [],
    protectionKnown: true,
    ...overrides,
  };
}
function snapshot(overrides: Partial<RepositorySnapshot> = {}): RepositorySnapshot {
  return {
    fullName: 'example/project',
    name: 'project',
    owner: 'example',
    description: '',
    url: 'https://github.com/example/project',
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    stars: 0,
    openIssues: 0,
    updatedAt: now.toISOString(),
    permissions: { actions: 'read', administration: 'unknown' },
    pullRequests: [],
    runs: [],
    artifacts: [],
    config: { values: {}, inaccessible: [] },
    warnings: [],
    ...overrides,
  };
}
function run(id: number, overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id,
    workflowId: 1,
    name: 'CI',
    title: 'Run CI',
    branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'failure',
    url: `https://github.com/example/project/actions/runs/${id}`,
    createdAt: `2026-10-${String(10 + id).padStart(2, '0')}T12:00:00Z`,
    updatedAt: now.toISOString(),
    durationSeconds: 120,
    attempt: 1,
    jobs: [
      {
        id: id * 10,
        name: 'test',
        conclusion: 'failure',
        url: `https://github.com/example/project/actions/runs/${id}/job/${id * 10}`,
        logExcerpt: 'AssertionError: expected true to be false',
      },
    ],
    ...overrides,
  };
}
function artifact(id: number, overrides: Partial<Artifact> = {}): Artifact {
  return {
    id,
    name: `build-${id}`,
    sizeBytes: 1024,
    createdAt: '2026-09-01T12:00:00Z',
    expiresAt: '2026-12-01T12:00:00Z',
    expired: false,
    runId: 12,
    ...overrides,
  };
}

describe('PR evidence rules', () => {
  it.each(['head', 'merge'] as const)(
    'identifies the actual %s commit in required-check evidence and explanations',
    (checksSource) => {
      const checksSha = `${checksSource}-revision`;
      const location = checksSource === 'merge' ? 'test merge commit' : 'pull request head commit';
      const findings = diagnose(
        snapshot({
          pullRequests: [
            pr({
              checksSha,
              checksSource,
              requiredChecks: ['failed', 'pending', 'missing'],
              checksComplete: true,
              checks: [
                { name: 'failed', status: 'failure' },
                { name: 'pending', status: 'pending' },
              ],
            }),
          ],
        }),
      );
      expect(findings).toHaveLength(3);
      for (const finding of findings) {
        expect(finding.explanation).toContain(location);
        expect(finding.evidence).toContainEqual({ label: 'Check commit', value: checksSha });
        expect(finding.evidence).toContainEqual({
          label: 'Check source',
          value: checksSource === 'merge' ? 'Test merge commit' : 'Pull request head commit',
        });
        if (checksSource === 'merge') expect(finding.explanation).not.toContain('head commit');
      }
    },
  );

  it.each([true, false])(
    'keeps legacy snapshots compatible without inventing a check source (%s complete)',
    (checksComplete) => {
      const findings = diagnose(
        snapshot({
          pullRequests: [pr({ requiredChecks: ['missing'], checksComplete })],
        }),
      );
      expect(findings[0]).toMatchObject({
        ruleId: 'pr.required-check-missing',
        confidence: checksComplete ? 'probable' : 'insufficient_evidence',
      });
      expect(findings[0]!.explanation).not.toContain('head commit');
      expect(findings[0]!.evidence).toContainEqual({
        label: 'Check source',
        value: 'Not recorded in this snapshot',
      });
      expect(findings[0]!.evidence.some((item) => item.label === 'Check commit')).toBe(false);
    },
  );

  it.each([
    ['failure', 'pr.required-check-failed'],
    ['pending', 'pr.required-check-pending'],
  ] as const)(
    'requires both a successful check-run and same-name %s commit status to pass',
    (status, ruleId) => {
      const findings = diagnose(
        snapshot({
          pullRequests: [
            pr({
              requiredChecks: ['test'],
              checks: [
                { name: 'test', status: 'success', appId: 7 },
                { name: 'test', status, url: 'https://github.com/example/project/commit/abc123' },
              ],
            }),
          ],
        }),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ ruleId, confidence: 'confirmed' });
    },
  );

  it('accepts a shared required name only after every observed check and status passes', () => {
    expect(
      diagnose(
        snapshot({
          pullRequests: [
            pr({
              requiredChecks: ['test'],
              checks: [
                { name: 'test', status: 'success', appId: 7 },
                { name: 'test', status: 'success' },
              ],
            }),
          ],
        }),
      ),
    ).toEqual([]);
  });
  it('distinguishes failed, pending and missing checks and deduplicates repeated requirements', () => {
    const findings = diagnose(
      snapshot({
        pullRequests: [
          pr({
            requiredChecks: ['test', 'build', 'lint', 'test'],
            checks: [
              { name: 'test', status: 'failure' },
              { name: 'build', status: 'pending' },
            ],
          }),
        ],
      }),
      undefined,
      { now },
    );
    expect(findings.map((value) => [value.ruleId, value.severity, value.confidence])).toEqual([
      ['pr.required-check-failed', 'high', 'confirmed'],
      ['pr.required-check-pending', 'medium', 'confirmed'],
      ['pr.required-check-missing', 'medium', 'probable'],
    ]);
    expect(new Set(findings.map((value) => value.fingerprint)).size).toBe(3);
  });

  it('requires the specified GitHub App source to satisfy a required check', () => {
    const data = snapshot({
      pullRequests: [
        pr({
          requiredChecks: ['test'],
          requiredCheckSources: [{ name: 'test', appId: 7 }],
          checks: [{ name: 'test', status: 'success', appId: 9 }],
        }),
      ],
    });
    expect(diagnose(data)[0]).toMatchObject({
      ruleId: 'pr.required-check-missing',
      confidence: 'probable',
    });
    data.pullRequests[0]!.checks.push({ name: 'test', status: 'success', appId: 7 });
    expect(diagnose(data)).toEqual([]);
  });

  it('accepts skipped, neutral and wildcard source checks without inventing path-filter blockers', () => {
    expect(
      diagnose(
        snapshot({
          pullRequests: [
            pr({
              requiredChecks: ['test', 'build'],
              requiredCheckSources: [{ name: 'test', appId: -1 }],
              checks: [
                { name: 'test', status: 'skipped', appId: 4 },
                { name: 'build', status: 'neutral' },
              ],
              workflowPathFilters: ['src/**'],
            }),
          ],
        }),
      ),
    ).toEqual([]);
    const findings = diagnose(
      snapshot({
        pullRequests: [pr({ requiredChecks: ['test'], workflowPathFilters: ['src/**'] })],
      }),
    );
    expect(findings[0]!.explanation).not.toMatch(/caused by.*path|path.filter/i);
  });

  it('does not convert permission failures or incomplete check collection into confirmed defects', () => {
    const unknown = diagnose(
      snapshot({
        pullRequests: [
          pr({ protectionKnown: false, requiredChecks: ['test'], requiredApprovals: 2 }),
        ],
      }),
    );
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({
      ruleId: 'pr.protection-unavailable',
      severity: 'info',
      confidence: 'insufficient_evidence',
    });
    const incomplete = diagnose(
      snapshot({ pullRequests: [pr({ requiredChecks: ['test'], checksComplete: false })] }),
    );
    expect(incomplete[0]).toMatchObject({
      ruleId: 'pr.required-check-missing',
      severity: 'info',
      confidence: 'insufficient_evidence',
    });
    const incompleteReviews = diagnose(
      snapshot({
        pullRequests: [pr({ approvals: 0, requiredApprovals: 2, checksComplete: false })],
      }),
    );
    expect(incompleteReviews[0]).toMatchObject({
      ruleId: 'pr.missing-approvals',
      severity: 'info',
      confidence: 'insufficient_evidence',
    });
  });

  it('handles conflicts, unknown mergeability, draft state, reviews and an outdated branch independently', () => {
    const findings = diagnose(
      snapshot({
        pullRequests: [
          pr({
            mergeable: false,
            draft: true,
            approvals: 0,
            requiredApprovals: 2,
            requiresCodeOwnerReview: true,
            reviewDecision: 'REVIEW_REQUIRED',
            changesRequested: true,
            behindBy: 3,
          }),
          pr({ number: 2, mergeable: null }),
        ],
      }),
    );
    expect(findings.find((value) => value.ruleId === 'pr.merge-conflict')).toMatchObject({
      severity: 'high',
      confidence: 'confirmed',
    });
    expect(findings.find((value) => value.ruleId === 'pr.missing-approvals')).toMatchObject({
      confidence: 'confirmed',
    });
    expect(findings.find((value) => value.ruleId === 'pr.codeowner-evidence')).toMatchObject({
      confidence: 'insufficient_evidence',
    });
    expect(findings.find((value) => value.ruleId === 'pr.outdated')?.explanation).toContain(
      'does not establish',
    );
    expect(findings.find((value) => value.ruleId === 'pr.mergeability-unknown')?.confidence).toBe(
      'insufficient_evidence',
    );
    expect(findings.map((value) => value.ruleId)).toContain('pr.draft');
  });

  it('evaluates approval completeness independently from check collection', () => {
    const completeReviews = diagnose(
      snapshot({
        pullRequests: [
          pr({ approvals: 0, requiredApprovals: 2, checksComplete: false, reviewsComplete: true }),
        ],
      }),
    );
    expect(completeReviews.find((value) => value.ruleId === 'pr.missing-approvals')).toMatchObject({
      confidence: 'confirmed',
      severity: 'medium',
    });
    const incompleteReviews = diagnose(
      snapshot({
        pullRequests: [
          pr({
            approvals: 0,
            requiredApprovals: 2,
            changesRequested: true,
            requiredChecks: ['build'],
            checksComplete: true,
            reviewsComplete: false,
          }),
        ],
        collectionState: { pullRequests: false, runs: true, artifacts: true, config: true },
      }),
    );
    expect(
      incompleteReviews.find((value) => value.ruleId === 'pr.missing-approvals'),
    ).toMatchObject({
      confidence: 'insufficient_evidence',
      severity: 'info',
    });
    expect(
      incompleteReviews.find((value) => value.ruleId === 'pr.changes-requested'),
    ).toMatchObject({
      confidence: 'insufficient_evidence',
    });
    expect(
      incompleteReviews.find((value) => value.ruleId === 'pr.changes-requested')?.explanation,
    ).toContain('later approval or dismissal');
    expect(
      incompleteReviews.find((value) => value.ruleId === 'pr.required-check-missing'),
    ).toMatchObject({ confidence: 'probable', severity: 'medium' });
  });

  it('keeps fingerprints stable across head commits and evidence changes but isolates repository and PR', () => {
    const first = diagnose(snapshot({ pullRequests: [pr({ requiredChecks: ['test'] })] }))[0]!;
    const next = diagnose(
      snapshot({
        pullRequests: [
          pr({ requiredChecks: ['test'], headSha: 'new-commit', title: 'Renamed PR' }),
        ],
      }),
    )[0]!;
    expect(next.fingerprint).toBe(first.fingerprint);
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(
      diagnose(
        snapshot({ fullName: 'other/project', pullRequests: [pr({ requiredChecks: ['test'] })] }),
      )[0]!.fingerprint,
    ).not.toBe(first.fingerprint);
    expect(
      diagnose(snapshot({ pullRequests: [pr({ number: 2, requiredChecks: ['test'] })] }))[0]!
        .fingerprint,
    ).not.toBe(first.fingerprint);
    expect(fingerprint('ab', 'c')).not.toBe(fingerprint('a', 'bc'));
  });

  it('exports each diagnostic rule for independent evaluation', () => {
    expect(
      requiredChecksRule.evaluate({
        snapshot: snapshot({ pullRequests: [pr({ requiredChecks: ['build'] })] }),
        now,
        artifactAgeDays: 30,
      }),
    ).toHaveLength(1);
  });
});

describe('accessible configuration drift', () => {
  it('compares saved values and uses stable setting fingerprints', () => {
    const baseline = {
      values: { defaultBranch: 'main', requiredReviews: 2, requiredChecks: ['test', 'build'] },
      inaccessible: [],
    };
    const data = snapshot({
      config: {
        values: { defaultBranch: 'develop', requiredReviews: 1, requiredChecks: ['build', 'test'] },
        inaccessible: [],
      },
    });
    const findings = configurationDriftRule.evaluate({
      snapshot: data,
      baseline,
      now,
      artifactAgeDays: 30,
    });
    expect(findings).toHaveLength(2);
    expect(findings.map((value) => value.severity)).toEqual(['medium', 'high']);
    expect(findings[0]!.evidence).toContainEqual({
      label: 'Previous baseline value',
      value: '"main"',
    });
    data.config.values.defaultBranch = 'master';
    expect(
      configurationDriftRule.evaluate({ snapshot: data, baseline, now, artifactAgeDays: 30 })[0]!
        .fingerprint,
    ).toBe(findings[0]!.fingerprint);
  });

  it('does not classify inaccessible or absent current settings as security regressions', () => {
    const baseline = {
      values: { protection: true, security: true, unknownAtBaseline: true },
      inaccessible: ['unknownAtBaseline'],
    };
    const findings = diagnose(
      snapshot({ config: { values: { protection: null }, inaccessible: ['protection'] } }),
      baseline,
    );
    expect(findings).toHaveLength(2);
    expect(
      findings.every(
        (value) =>
          value.confidence === 'insufficient_evidence' &&
          value.ruleId === 'config.unavailable' &&
          value.severity === 'info',
      ),
    ).toBe(true);
  });

  it('treats an accessible null as a known changed value', () => {
    const findings = diagnose(
      snapshot({ config: { values: { protection: null }, inaccessible: [] } }),
      { values: { protection: true }, inaccessible: [] },
    );
    expect(findings[0]).toMatchObject({ ruleId: 'config.drift', confidence: 'confirmed' });
    expect(diagnose(snapshot())).toEqual([]);
  });
});

describe('bounded log classification and correlation', () => {
  it('keeps terminal failures when a persisted excerpt has more than 500 short lines', () => {
    const log = `${'progress\n'.repeat(600)}error TS2322: terminal compile failure`;
    const result = classifyFailure(log);
    expect(result.category).toBe('compilation');
    expect(result.excerpt).toContain('terminal compile failure');
    expect(result.excerpt.split('\n')).toHaveLength(LOG_LIMITS.lines);
  });

  it('redacts multiline secrets before selecting the final diagnostic lines', () => {
    const log = [
      '-----BEGIN PRIVATE KEY-----',
      ...Array.from({ length: 600 }, () => 'fixture-private-material'),
      '-----END PRIVATE KEY-----',
      'error TS2322: terminal compile failure',
    ].join('\n');
    const result = classifyFailure(log);
    expect(result.category).toBe('compilation');
    expect(result.excerpt).not.toContain('fixture-private-material');
    expect(result.excerpt).toContain('[REDACTED PRIVATE KEY]');
  });

  it('removes signed URL credentials from excerpts and unknown failure signatures', () => {
    const source =
      'failure https://example.test/log?sig=fixture-sig&X-Amz-Credential=fixture-credential&signature=fixture-signature';
    const result = classifyFailure(source);
    for (const secret of ['fixture-sig', 'fixture-credential', 'fixture-signature']) {
      expect(result.excerpt).not.toContain(secret);
      expect(result.signature).not.toContain(secret);
    }
  });

  it('preserves useful categories through GitHub redaction and keeps normalized values secret-free', () => {
    const secret = 'synthetic-sensitive-value';
    const raw = `npm ERR! ERESOLVE unable to resolve dependency tree\nAuthorization: Bearer ${secret}\nhttps://example.test/log?token=${secret}`;
    const fetched = redactGitHubLog(raw, [secret]);
    const result = classifyFailure(fetched);
    expect(result.category).toBe('dependency_installation');
    expect(result.excerpt).not.toContain(secret);
    expect(result.signature).not.toContain(secret);
    expect(result.category).not.toContain(secret);
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    ['AssertionError: expected 2 to equal 3', 'test_assertion'],
    ['src/index.ts(12,2): error TS2322: Type string is not assignable', 'compilation'],
    ["ModuleNotFoundError: No module named 'requests'", 'missing_dependency'],
    ['npm ERR! ERESOLVE unable to resolve dependency tree', 'dependency_installation'],
    ['Resource not accessible by integration', 'authentication'],
    ['TimeoutError: operation timed out after 60 seconds', 'timeout'],
    ['fetch failed: ECONNRESET', 'network'],
    [
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      'out_of_memory',
    ],
    ['Invalid workflow configuration: unexpected input', 'configuration'],
  ])('classifies %s as %s using log evidence', (log, category) => {
    expect(classifyFailure(log)).toMatchObject({ category, confidence: 'probable' });
  });

  it('normalizes timestamps, runner paths, execution IDs and durations without discarding error identity', () => {
    const a =
      '2026-10-15T12:00:00.123Z ##[error]Cannot find module foo at /home/runner/work/a/a.js:45 process 123 after 20 seconds';
    const b =
      '2026-10-16T09:00:00.555Z ##[error]Cannot find module foo at /home/runner/work/b/b.js:67 process 999 after 99 seconds';
    expect(normalizeFailureSignature(a)).toBe(normalizeFailureSignature(b));
    expect(classifyFailure(a).fingerprint).toBe(classifyFailure(b).fingerprint);
    expect(classifyFailure(a.replace('module foo', 'module bar')).fingerprint).not.toBe(
      classifyFailure(a).fingerprint,
    );
  });

  it('redacts token formats, credentials, query tokens, headers and private keys before returning evidence', () => {
    const fixtureSecret = 'fixture-value-123';
    const log = [
      `Authorization: Bearer ${fixtureSecret}`,
      `Authorization: token ${fixtureSecret}`,
      `GITHUB_TOKEN=${fixtureSecret}`,
      `password="${fixtureSecret}"`,
      `password="escaped\\"${fixtureSecret}"`,
      `{"api_key":"${fixtureSecret}"}`,
      `https://operator:${fixtureSecret}@example.test/path?token=${fixtureSecret}`,
      `ghp_${fixtureSecret.replaceAll('-', '')}`,
      '-----BEGIN PRIVATE KEY-----',
      fixtureSecret,
      '-----END PRIVATE KEY-----',
      'AssertionError: expected true to be false',
    ].join('\n');
    const result = classifyFailure(log);
    expect(result.excerpt).not.toContain(fixtureSecret);
    expect(result.excerpt).not.toContain('ghp_');
    expect(result.excerpt).toContain('[REDACTED]');
    expect(result.signature).not.toContain(fixtureSecret);
  });

  it('bounds bytes, lines and long lines even for multibyte input or redaction expansion', () => {
    for (const text of [
      'é'.repeat(LOG_LIMITS.bytes),
      'ghp_x '.repeat(LOG_LIMITS.bytes),
      'x\n'.repeat(LOG_LIMITS.lines * 2),
    ]) {
      const redacted = redactLog(text);
      expect(Buffer.byteLength(redacted)).toBeLessThanOrEqual(LOG_LIMITS.bytes);
      expect(redacted.split('\n').length).toBeLessThanOrEqual(LOG_LIMITS.lines);
      expect(redacted.split('\n').every((line) => line.length <= LOG_LIMITS.lineCharacters)).toBe(
        true,
      );
    }
    expect(classifyFailure('unclassified result').confidence).toBe('insufficient_evidence');
    expect(classifyFailure('').category).toBe('unknown');
  });

  it('counts distinct runs, preserves supporting jobs and groups repeated signatures', () => {
    const one = run(1);
    one.jobs.push({ ...one.jobs[0]!, id: 11, name: 'integration' });
    const incidents = correlateFailures([
      one,
      run(2),
      run(3, { conclusion: 'success' }),
      run(4, { jobs: [] }),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      category: 'test_assertion',
      count: 2,
      firstSeen: one.createdAt,
      lastSeen: run(2).createdAt,
    });
    expect(incidents[0]!.runs).toHaveLength(3);
    expect(
      correlateFailures([
        run(1, {
          jobs: [
            {
              id: 10,
              name: 'test',
              conclusion: 'failure',
              url: '',
              logExcerpt: 'Process exited with code 1',
            },
          ],
        }),
      ]),
    ).toEqual([]);
    const findings = diagnose(snapshot({ runs: [one, run(2), run(4, { jobs: [] })] }));
    expect(findings.find((value) => value.ruleId === 'workflow.failure-signature')).toMatchObject({
      severity: 'high',
      confidence: 'probable',
    });
    expect(
      findings.find((value) => value.ruleId === 'workflow.failure-unclassified'),
    ).toMatchObject({ confidence: 'insufficient_evidence' });
  });
});

describe('workflow analytics', () => {
  it('uses completed success/failure outcomes as the denominator and reports duration, reruns and repeated jobs', () => {
    const values = [
      run(1, { conclusion: 'success', durationSeconds: 60, jobs: [] }),
      run(2, { durationSeconds: 180, attempt: 3 }),
      run(3, { conclusion: 'cancelled', durationSeconds: 30, jobs: [] }),
      run(4, { status: 'in_progress', conclusion: null, durationSeconds: 999, jobs: [] }),
      run(5, { durationSeconds: 90 }),
    ];
    const result = workflowAnalytics(values)[0]!;
    expect(result).toMatchObject({
      totalRuns: 5,
      completedRuns: 4,
      successfulRuns: 1,
      failedRuns: 2,
      cancelledRuns: 1,
      runningRuns: 1,
      rerunCount: 2,
      successRate: 1 / 3,
      failureRate: 2 / 3,
      averageDurationSeconds: 90,
      medianDurationSeconds: 75,
      recentRegression: true,
      repeatedFailingJobs: [{ name: 'test', failures: 2 }],
    });
    expect(result.daily).toHaveLength(5);
    expect(result.daily[0]).toMatchObject({
      date: '2026-10-11',
      successes: 1,
      failures: 0,
      averageDurationSeconds: 60,
    });
  });

  it('returns null rates for no decisive completed outcomes and isolates workflow identities', () => {
    expect(workflowAnalytics([])).toEqual([]);
    expect(
      workflowAnalytics([run(1, { status: 'queued', conclusion: null, jobs: [] })])[0],
    ).toMatchObject({ successRate: null, failureRate: null, medianDurationSeconds: null });
    expect(workflowAnalytics([run(1), run(2, { workflowId: 2 })])).toHaveLength(2);
  });
});

describe('artifact retention recommendations', () => {
  it('uses configurable age and independent size criteria and excludes expired metadata', () => {
    const values = [
      artifact(1),
      artifact(2, { createdAt: now.toISOString(), sizeBytes: 200 * 1024 * 1024 }),
      artifact(3, { expired: true }),
      artifact(4, { expiresAt: '2026-10-01T12:00:00Z' }),
      artifact(5, { createdAt: now.toISOString() }),
    ];
    const recommendations = artifactRecommendations(values, 30, now);
    expect(recommendations).toHaveLength(2);
    expect(recommendations[0]).toMatchObject({
      artifactId: 2,
      ageDays: 0,
      reasons: ['size'],
      runId: 12,
    });
    expect(recommendations[1]).toMatchObject({ artifactId: 1, ageDays: 47, reasons: ['age'] });
    expect(artifactRecommendations(values, 90, now).map((value) => value.artifactId)).toEqual([2]);
  });

  it('handles future or invalid timestamps conservatively and emits a review finding without deleting', () => {
    expect(
      artifactRecommendations(
        [artifact(1, { createdAt: 'invalid' }), artifact(2, { createdAt: '2027-01-01T00:00:00Z' })],
        30,
        now,
      ),
    ).toEqual([]);
    const findings = diagnose(snapshot({ artifacts: [artifact(1)] }), undefined, {
      now,
      artifactAgeDays: 30,
    });
    expect(findings[0]).toMatchObject({
      ruleId: 'storage.retention',
      safeAction: 'delete_artifacts',
      severity: 'low',
    });
    expect(findings[0]!.explanation).toContain('not historical billed usage');
  });
});

describe('collection authority', () => {
  it.each([
    { checksComplete: false },
    { reviewsComplete: false },
    { protectionKnown: false },
    { mergeable: null },
  ])('does not resolve PR findings when per-PR evidence is incomplete: %o', (partial) => {
    expect(
      authoritativeFindingTypes(
        snapshot({
          collectionState: { pullRequests: true, runs: true, artifacts: true, config: true },
          pullRequests: [pr(partial)],
        }),
      ),
    ).toEqual(['workflow', 'storage', 'configuration']);
  });

  it('retains PR authority when a dirty merge state establishes conflict despite a null boolean', () => {
    expect(
      authoritativeFindingTypes(
        snapshot({ pullRequests: [pr({ mergeable: null, mergeableState: 'dirty' })] }),
      ),
    ).toContain('pull_request');
  });

  it('preserves compatibility with complete snapshots and maps partial collection types independently', () => {
    expect(authoritativeFindingTypes(snapshot())).toEqual([
      'pull_request',
      'workflow',
      'storage',
      'configuration',
    ]);
    expect(
      authoritativeFindingTypes(
        snapshot({
          collectionState: { pullRequests: true, runs: false, artifacts: true, config: false },
        }),
      ),
    ).toEqual(['pull_request', 'storage']);
    expect(
      authoritativeFindingTypes(
        snapshot({
          collectionState: { pullRequests: false, runs: false, artifacts: false, config: false },
        }),
      ),
    ).toEqual([]);
  });

  it('treats absent required checks as insufficient when PR collection is incomplete', () => {
    const findings = diagnose(
      snapshot({
        collectionState: { pullRequests: false, runs: true, artifacts: true, config: true },
        pullRequests: [pr({ requiredChecks: ['test'] })],
      }),
    );
    expect(findings[0]).toMatchObject({
      ruleId: 'pr.required-check-missing',
      confidence: 'insufficient_evidence',
      severity: 'info',
    });
  });
});
