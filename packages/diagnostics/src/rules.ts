import type {
  ConfigValue,
  Evidence,
  FindingInput,
  PullRequest,
  RepositoryConfig,
  RepositorySnapshot,
} from '@gitnostics/shared';
import { artifactRecommendations } from './analytics.js';
import { correlateFailures, fingerprint } from './logs.js';

export interface RuleContext {
  snapshot: RepositorySnapshot;
  baseline?: RepositoryConfig;
  now: Date;
  artifactAgeDays: number;
}
export interface DiagnosticRule {
  id: string;
  version: number;
  evaluate(context: RuleContext): FindingInput[];
}

function finding(
  snapshot: RepositorySnapshot,
  ruleId: string,
  subject: string,
  details: Omit<FindingInput, 'ruleId' | 'ruleVersion' | 'fingerprint' | 'repository'>,
): FindingInput {
  return {
    ...details,
    repository: snapshot.fullName,
    ruleId,
    ruleVersion: 1,
    fingerprint: fingerprint('finding-v1', snapshot.fullName, ruleId, subject),
  };
}

const prEvidence = (pr: PullRequest): Evidence[] => [
  { label: 'Pull request', value: `#${pr.number} ${pr.title}`, url: pr.url },
  { label: 'Head commit', value: pr.headSha },
];

export const mergeabilityRule: DiagnosticRule = {
  id: 'pr.mergeability',
  version: 1,
  evaluate({ snapshot }) {
    return snapshot.pullRequests.flatMap((pr): FindingInput[] => {
      if (pr.mergeable === false || pr.mergeableState === 'dirty')
        return [
          finding(snapshot, 'pr.merge-conflict', String(pr.number), {
            type: 'pull_request',
            severity: 'high',
            confidence: 'confirmed',
            title: `PR #${pr.number} has merge conflicts`,
            explanation:
              'GitHub reports that the pull request cannot merge cleanly with its base branch.',
            recommendation:
              'Resolve the conflicts in the source branch, review the result, and rerun required checks.',
            resourceUrl: pr.url,
            evidence: [
              ...prEvidence(pr),
              { label: 'Mergeability', value: `${String(pr.mergeable)} (${pr.mergeableState})` },
            ],
          }),
        ];
      if (pr.mergeable === null)
        return [
          finding(snapshot, 'pr.mergeability-unknown', String(pr.number), {
            type: 'pull_request',
            severity: 'info',
            confidence: 'insufficient_evidence',
            title: `PR #${pr.number} mergeability is not available`,
            explanation:
              'GitHub has not supplied a completed mergeability calculation. This does not establish a merge conflict.',
            recommendation:
              'Refresh after GitHub completes its calculation; inspect the pull request if this persists.',
            resourceUrl: pr.url,
            evidence: prEvidence(pr),
          }),
        ];
      return [];
    });
  },
};

export const requiredChecksRule: DiagnosticRule = {
  id: 'pr.required-checks',
  version: 1,
  evaluate({ snapshot }) {
    const output: FindingInput[] = [];
    for (const pr of snapshot.pullRequests) {
      if (!pr.protectionKnown) {
        output.push(
          finding(snapshot, 'pr.protection-unavailable', String(pr.number), {
            type: 'pull_request',
            severity: 'info',
            confidence: 'insufficient_evidence',
            title: `PR #${pr.number} protection requirements are unavailable`,
            explanation:
              'The available API data does not establish all applicable branch protection or ruleset requirements. Missing access is not evidence of weak protection.',
            recommendation:
              'Inspect repository rules in GitHub or grant the integration read access to the applicable configuration.',
            resourceUrl: pr.url,
            evidence: prEvidence(pr),
          }),
        );
        continue;
      }
      const required = [...(pr.requiredCheckSources ?? [])];
      for (const name of pr.requiredChecks ?? [])
        if (!required.some((check) => check.name === name)) required.push({ name });
      const seen = new Set<string>();
      for (const check of required) {
        const key = JSON.stringify([check.name, check.appId ?? null]);
        if (seen.has(key)) continue;
        seen.add(key);
        const matches = pr.checks.filter(
          (result) =>
            result.name === check.name &&
            (check.appId === undefined || check.appId === -1 || check.appId === result.appId),
        );
        const evidence: Evidence[] = [
          ...prEvidence(pr),
          { label: 'Required check', value: check.name },
          ...(check.appId === undefined || check.appId === -1
            ? []
            : [{ label: 'Required app ID', value: String(check.appId) }]),
        ];
        const subject = `${pr.number}:${key}`;
        // A check run and commit status with the same required name must both pass.
        // An accepted conclusion cannot hide another matching failure or pending result.
        if (
          matches.length &&
          matches.every((result) => ['success', 'neutral', 'skipped'].includes(result.status))
        )
          continue;
        if (!matches.length) {
          const complete =
            pr.checksComplete !== false && snapshot.collectionState?.pullRequests !== false;
          output.push(
            finding(snapshot, 'pr.required-check-missing', subject, {
              type: 'pull_request',
              severity: complete ? 'medium' : 'info',
              confidence: complete ? 'probable' : 'insufficient_evidence',
              title: `PR #${pr.number}: required check “${check.name}” is not reported`,
              explanation: complete
                ? 'No matching status or check run from the required source was observed on the current head commit. This may block merging; the available evidence does not establish why the check is missing.'
                : 'Check collection was incomplete, so the absence of this required check cannot establish a blocker.',
              recommendation: complete
                ? 'Inspect the required check name, producing GitHub App, workflow triggers and current head commit in GitHub. Do not remove the requirement to make the branch mergeable.'
                : 'Restore check-read access or retry synchronization before concluding that the check is absent.',
              resourceUrl: pr.url,
              evidence: [
                ...evidence,
                { label: 'Check collection complete', value: String(complete) },
              ],
            }),
          );
          continue;
        }
        const failure = matches.find((result) => result.status === 'failure');
        const pending = matches.find((result) => result.status === 'pending');
        if (failure || pending)
          output.push(
            finding(
              snapshot,
              failure ? 'pr.required-check-failed' : 'pr.required-check-pending',
              subject,
              {
                type: 'pull_request',
                severity: failure ? 'high' : 'medium',
                confidence: 'confirmed',
                title: `PR #${pr.number}: required check “${check.name}” ${failure ? 'failed' : 'is pending'}`,
                explanation: `The required check from the configured source is ${failure ? 'failing' : 'pending'} on the pull request head commit.`,
                recommendation: failure
                  ? 'Inspect the linked check, fix the underlying failure and let the required check run again.'
                  : 'Wait for the check to complete; investigate queued or stuck runners if it remains pending.',
                resourceUrl: (failure ?? pending)?.url || pr.url,
                evidence: [
                  ...evidence,
                  {
                    label: 'Observed status',
                    value: failure ? 'failure' : 'pending',
                    url: (failure ?? pending)?.url,
                  },
                ],
              },
            ),
          );
      }
    }
    return output;
  },
};

export const reviewRequirementsRule: DiagnosticRule = {
  id: 'pr.reviews',
  version: 1,
  evaluate({ snapshot }) {
    const output: FindingInput[] = [];
    for (const pr of snapshot.pullRequests) {
      if (pr.draft)
        output.push(
          finding(snapshot, 'pr.draft', String(pr.number), {
            type: 'pull_request',
            severity: 'low',
            confidence: 'confirmed',
            title: `PR #${pr.number} is a draft`,
            explanation: 'Draft pull requests cannot be merged until marked ready for review.',
            recommendation: 'Mark ready for review when the author considers the changes ready.',
            evidence: prEvidence(pr),
            resourceUrl: pr.url,
          }),
        );
      if (pr.changesRequested)
        output.push(
          finding(snapshot, 'pr.changes-requested', String(pr.number), {
            type: 'pull_request',
            severity: 'medium',
            confidence: 'probable',
            title: `PR #${pr.number} has requested changes`,
            explanation:
              'A current review requests changes. Whether it blocks merging depends on applicable review rules and reviewer permissions.',
            recommendation: 'Address the review and ask the reviewer to review again.',
            evidence: prEvidence(pr),
            resourceUrl: pr.url,
          }),
        );
      if (!pr.protectionKnown) continue;
      if (pr.requiredApprovals !== undefined && pr.approvals < pr.requiredApprovals)
        output.push(
          finding(snapshot, 'pr.missing-approvals', String(pr.number), {
            type: 'pull_request',
            severity: pr.checksComplete === false ? 'info' : 'medium',
            confidence: pr.checksComplete === false ? 'insufficient_evidence' : 'confirmed',
            title:
              pr.checksComplete === false
                ? `PR #${pr.number} approval evidence is incomplete`
                : `PR #${pr.number} needs more review approvals`,
            explanation:
              pr.checksComplete === false
                ? 'Review collection was incomplete. The observed approval count cannot establish that approvals are missing.'
                : `Observed ${pr.approvals} approval(s); the applicable policy requires ${pr.requiredApprovals}. Eligibility and stale-review rules can impose further requirements.`,
            recommendation:
              pr.checksComplete === false
                ? 'Restore review-read access or retry synchronization before evaluating the approval requirement.'
                : 'Request reviews from eligible reviewers and address their feedback.',
            evidence: [
              ...prEvidence(pr),
              { label: 'Observed approvals', value: String(pr.approvals) },
              { label: 'Required approvals', value: String(pr.requiredApprovals) },
            ],
            resourceUrl: pr.url,
          }),
        );
      if (pr.requiresCodeOwnerReview && pr.reviewDecision !== 'APPROVED')
        output.push(
          finding(snapshot, 'pr.codeowner-evidence', String(pr.number), {
            type: 'pull_request',
            severity: 'info',
            confidence: 'insufficient_evidence',
            title: `PR #${pr.number} requires code-owner review verification`,
            explanation:
              'The applicable policy requires code-owner approval, but the available data does not identify whether all affected code owners have approved. The generic review decision cannot establish which owner review is missing.',
            recommendation: 'Inspect the code-owner requirement and requested reviewers on GitHub.',
            evidence: [
              ...prEvidence(pr),
              { label: 'Code-owner reviews required', value: 'true' },
              { label: 'Review decision', value: pr.reviewDecision ?? 'not available' },
            ],
            resourceUrl: pr.url,
          }),
        );
    }
    return output;
  },
};

export const outdatedBranchRule: DiagnosticRule = {
  id: 'pr.outdated',
  version: 1,
  evaluate({ snapshot }) {
    return snapshot.pullRequests.flatMap((pr): FindingInput[] => {
      const blocked = pr.mergeableState === 'behind';
      if (!blocked && !(pr.behindBy !== undefined && pr.behindBy > 0)) return [];
      return [
        finding(snapshot, 'pr.outdated', String(pr.number), {
          type: 'pull_request',
          severity: blocked ? 'medium' : 'low',
          confidence: 'confirmed',
          title: `PR #${pr.number} is behind its base branch`,
          explanation: blocked
            ? 'GitHub reports the branch as behind under the applicable merge policy.'
            : `The source branch is ${pr.behindBy} commit(s) behind its base. This alone does not establish that merging is blocked.`,
          recommendation:
            'Review whether an update is needed, update the source branch safely and run required checks again.',
          evidence: [
            ...prEvidence(pr),
            { label: 'Merge state', value: pr.mergeableState },
            ...(pr.behindBy === undefined
              ? []
              : [{ label: 'Commits behind', value: String(pr.behindBy) }]),
          ],
          resourceUrl: pr.url,
        }),
      ];
    });
  },
};

const canonical = (value: ConfigValue): string =>
  JSON.stringify(Array.isArray(value) ? [...value].sort() : value);

export const configurationDriftRule: DiagnosticRule = {
  id: 'config.drift',
  version: 1,
  evaluate({ snapshot, baseline }) {
    if (!baseline) return [];
    const output: FindingInput[] = [];
    for (const [key, expected] of Object.entries(baseline.values)) {
      if (baseline.inaccessible.includes(key)) continue;
      if (
        snapshot.config.inaccessible.includes(key) ||
        !Object.hasOwn(snapshot.config.values, key)
      ) {
        output.push(
          finding(snapshot, 'config.unavailable', key, {
            type: 'configuration',
            severity: 'info',
            confidence: 'insufficient_evidence',
            title: `Cannot compare configuration: ${key}`,
            explanation:
              'The current setting is not accessible or was not collected. Missing permission or missing data does not establish a security regression.',
            recommendation:
              'Inspect the setting in GitHub or restore the required read permission before comparing it with the baseline.',
            evidence: [
              { label: 'Setting', value: key },
              { label: 'Baseline value', value: canonical(expected) },
            ],
            resourceUrl: `${snapshot.url}/settings`,
          }),
        );
        continue;
      }
      const current = snapshot.config.values[key]!;
      if (canonical(current) === canonical(expected)) continue;
      output.push(
        finding(snapshot, 'config.drift', key, {
          type: 'configuration',
          severity: /protection|required|security|permissions|review/i.test(key)
            ? 'high'
            : 'medium',
          confidence: 'confirmed',
          title: `Configuration changed: ${key}`,
          explanation:
            'The currently accessible value differs from the saved baseline. A difference does not itself establish that the new setting is less secure.',
          recommendation:
            'Review the intended policy with the repository owner. Acknowledge an approved change or restore the approved policy manually; never weaken protections to clear a finding.',
          evidence: [
            { label: 'Setting', value: key },
            { label: 'Previous baseline value', value: canonical(expected) },
            { label: 'Current value', value: canonical(current) },
          ],
          resourceUrl: `${snapshot.url}/settings`,
        }),
      );
    }
    return output;
  },
};

export const workflowFailuresRule: DiagnosticRule = {
  id: 'workflow.failures',
  version: 1,
  evaluate({ snapshot }) {
    const incidents = correlateFailures(snapshot.runs);
    const output = incidents.map((incident) =>
      finding(snapshot, 'workflow.failure-signature', incident.fingerprint, {
        type: 'workflow',
        severity: incident.count > 1 ? 'high' : 'medium',
        confidence: 'probable',
        title: `${incident.count} workflow failure${incident.count === 1 ? '' : 's'} with ${incident.category.replaceAll('_', ' ')} evidence`,
        explanation: `The bounded, redacted job logs share the same normalized error signature. Matching signatures suggest a shared cause; they do not prove causality. First observed ${incident.firstSeen}; latest ${incident.lastSeen}.`,
        recommendation:
          'Inspect the affected jobs and resolve the underlying error before considering a rerun.',
        safeAction: 'rerun_failed',
        evidence: [
          { label: 'Normalized signature', value: incident.signature },
          ...incident.runs.slice(0, 20).map((run) => ({
            label: `${run.name}: ${run.job}`,
            value: `Run ${run.id}`,
            url: run.url,
          })),
        ],
        resourceUrl: incident.runs[0]?.url,
      }),
    );
    const explained = new Set(incidents.flatMap((incident) => incident.runs.map((run) => run.id)));
    for (const run of snapshot.runs) {
      if (
        explained.has(run.id) ||
        !['failure', 'timed_out', 'startup_failure', 'action_required'].includes(
          run.conclusion ?? '',
        )
      )
        continue;
      output.push(
        finding(snapshot, 'workflow.failure-unclassified', String(run.id), {
          type: 'workflow',
          severity: 'medium',
          confidence: 'insufficient_evidence',
          title: `${run.name} failed; cause is not established`,
          explanation:
            'The run failed, but no recognized error signature was found in available bounded job logs. The run conclusion alone cannot establish a root cause.',
          recommendation: 'Open the workflow jobs and review the full logs in GitHub.',
          safeAction: 'rerun_failed',
          evidence: [
            { label: 'Run', value: String(run.id), url: run.url },
            { label: 'Conclusion', value: run.conclusion ?? 'unknown' },
          ],
          resourceUrl: run.url,
        }),
      );
    }
    return output;
  },
};

export const artifactRetentionRule: DiagnosticRule = {
  id: 'storage.retention',
  version: 1,
  evaluate({ snapshot, artifactAgeDays, now }) {
    const candidates = artifactRecommendations(snapshot.artifacts, artifactAgeDays, now);
    if (!candidates.length) return [];
    const bytes = candidates.reduce((total, candidate) => total + candidate.sizeBytes, 0);
    return [
      finding(snapshot, 'storage.retention', 'retained-artifacts', {
        type: 'storage',
        severity: 'low',
        confidence: 'confirmed',
        title: `${candidates.length} artifact${candidates.length === 1 ? '' : 's'} may merit retention review`,
        explanation: `Retained artifact metadata identifies ${bytes} bytes in artifacts at least ${artifactAgeDays} days old or at least 100 MiB. This is a current metadata snapshot, not historical billed usage or a guarantee of deletable bytes.`,
        recommendation:
          'Review run associations and retention needs in a cleanup preview. Delete only explicitly selected artifacts after separate authorization and confirmation.',
        safeAction: 'delete_artifacts',
        evidence: [
          { label: 'Candidate bytes', value: String(bytes) },
          ...candidates.slice(0, 20).map((candidate) => ({
            label: candidate.name,
            value: `Artifact ${candidate.artifactId}; ${candidate.sizeBytes} bytes; age ${candidate.ageDays ?? 'unknown'} days; reasons: ${candidate.reasons.join(', ')}`,
          })),
        ],
        resourceUrl: `${snapshot.url}/actions`,
      }),
    ];
  },
};

export const diagnosticRules: readonly DiagnosticRule[] = [
  mergeabilityRule,
  requiredChecksRule,
  reviewRequirementsRule,
  outdatedBranchRule,
  configurationDriftRule,
  workflowFailuresRule,
  artifactRetentionRule,
];

/** Only complete collections can resolve previously active findings of their corresponding type. */
export function authoritativeFindingTypes(snapshot: RepositorySnapshot): FindingInput['type'][] {
  const sources: [
    keyof NonNullable<RepositorySnapshot['collectionState']>,
    FindingInput['type'],
  ][] = [
    ['pullRequests', 'pull_request'],
    ['runs', 'workflow'],
    ['artifacts', 'storage'],
    ['config', 'configuration'],
  ];
  return sources
    .filter(([source]) => snapshot.collectionState?.[source] !== false)
    .map(([, type]) => type);
}

export function diagnose(
  snapshot: RepositorySnapshot,
  baseline?: RepositoryConfig,
  options: { artifactAgeDays?: number; now?: Date } = {},
): FindingInput[] {
  const context: RuleContext = {
    snapshot,
    baseline,
    now: options.now ?? new Date(),
    artifactAgeDays: options.artifactAgeDays ?? 30,
  };
  const unique = new Map<string, FindingInput>();
  for (const rule of diagnosticRules)
    for (const result of rule.evaluate(context)) unique.set(result.fingerprint, result);
  return [...unique.values()];
}
