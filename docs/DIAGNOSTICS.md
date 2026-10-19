# Diagnostic calculations and evidence limits

GitNostics has no synthetic health score. The command center counts cached repositories, open PRs in the retrieved sample, failed runs in the retained sample, and non-resolved/non-suppressed findings. Severity orders findings; an empty findings list does not establish that a repository is secure or mergeable. Each repository shows its synchronization timestamp, errors and coverage warnings.

## Pull request rules

| Observation                                         | Finding and confidence                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub reports mergeable=false/dirty                | High, confirmed conflict. Unknown mergeability yields informational insufficient evidence.                                                                                                   |
| Required check fails or remains pending             | Confirmed observed outcome, high/medium severity. App-specific requirements match the originating App. All matching check/status results must pass; success cannot hide a same-name failure. |
| Required check has no report                        | Probable when collection is complete, insufficient evidence when incomplete. A missing report never proves a path-filter cause.                                                              |
| Fewer observed approvals than the known requirement | Confirmed numerical deficit with complete reviews; incomplete review data produces insufficient evidence. This does not decide reviewer eligibility or stale-review policy.                  |
| Changes requested                                   | Probable blocker; administrator bypass and review eligibility can differ.                                                                                                                    |
| Code-owner review required                          | Insufficient evidence unless an authoritative aggregate decision is available. Individual code-owner eligibility is not implemented.                                                         |
| Branch behind base                                  | Confirmed comparison; only a behind merge state is described as blocking. Being behind alone does not prove a merge restriction.                                                             |
| Protection inaccessible or unsupported              | Informational insufficient evidence. Never a security-regression assertion.                                                                                                                  |

See GitHub's [required-check troubleshooting](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks) for skipped/neutral results and same-name check/status requirements. Complete ruleset interpretation, merge queues and workflow-YAML filter attribution remain outside the supported rules.

Checks/statuses and reviews carry independent completeness flags. A failed review read does not invalidate completely collected check evidence, and a failed check read does not invalidate completely collected reviews. Incomplete review history cannot establish whether a later review superseded an observed request for changes. Incomplete PR evidence or an unknown mergeability calculation conservatively prevents automatic resolution of prior PR findings.

## Workflow calculations

The server uses the independently tested `workflowAnalytics` implementation. Success rate is successful completed runs divided by successful plus failed completed runs. Failure includes failure, timed_out, startup_failure and action_required. Cancelled, skipped, neutral and unfinished runs are excluded from that denominator. Average/median duration uses valid nonnegative durations of completed runs. GitHub elapsed run duration is approximated from run_started_at (or created_at) to updated_at; it is not individual step CPU time.

A recent regression means the latest decisive run failed after a success among the previous five decisive runs. Repeated failing jobs count distinct run IDs per job name. Rerun count sums attempt minus one over cached runs; it is not a full rerun audit history.

The deterministic log classifier supports test assertions, compilation, missing dependencies, dependency installation, authentication/permissions, timeout, network, out-of-memory and configuration errors. Classifications are probable interpretations of redacted log evidence. Unknown output stays insufficient and is not grouped into an asserted shared cause. Normalization replaces timestamps, selected hash/path forms, durations and execution identifiers before SHA-256 fingerprinting. Incidents count distinct runs and link supporting jobs; a shared signature suggests correlation rather than proof of a single root cause.

## Storage and drift

Artifact size is current retained metadata. A retention recommendation is an unexpired artifact at least the configured age or at least 100 MiB. Candidates are review opportunities, never automatic deletion or exact savings/billing claims. Storage charts show locally observed samples and do not reconstruct missing GitHub history. API payloads that are unavailable/truncated do not create a false zero storage snapshot.

Drift compares an explicitly saved baseline with accessible current values. It displays previous/current values and records detection time. A confirmed difference is not automatically a confirmed security regression. Inaccessible values generate uncertainty and cannot resolve an earlier finding merely by disappearing.

## Bounds and lifecycle

- Collections: at most five pages/500 entries; PR details: 25; workflow history: 30; jobs: latest 10 runs; failed-job excerpts: three per refresh. Issues/branches/commits are samples of 20/50/20 respectively.
- Transport: four concurrent requests, two bounded read retries, 15-second request timeout; retry headers longer than the local wait budget return an actionable limit error rather than retrying early. ETag validation uses a memory cache capped at 300 entries/16 MiB.
- Log downloads: 128 KiB cap, 16 KiB UTF-8 persisted tail excerpt, selected after redacting the entire bounded download. The three-log budget follows retrieved run/job order regardless of request completion order; omitted failed-job logs produce an explicit coverage warning. Classification additionally limits input to 64 KiB, 500 lines and 2,000 characters per line. Large/inaccessible logs have visible warnings.
- Synchronization: two repository tasks concurrently, one queued/running task per repository/mode. Background polling defaults off; configurable minimum is five minutes.
- Automatic polling waits the configured interval after the latest durable attempt, including failure and restart. Explicit operator retries remain immediate.
- Findings use stable rule/repository/fingerprint IDs. Re-observation updates evidence and preserves acknowledgment/manual suppression. Removed rule suppression reactivates still-observed findings. Only authoritative covered collection types can resolve absent findings. Recurrence reopens the same identity.
- Temporary rule suppression remembers an acknowledged finding across restart and restores its acknowledgment when observed again after unsuppression. Explicit manual lifecycle changes and resolution clear that remembered state.
- History retention is per mode. Active evidence is retained; resolved findings and historical records are pruned by age and hard limits. Backups have a separate seven-file rotation and publish a completed file only after a successful copy.

Fixtures verify these rules and failure boundaries. Real GitHub App, repository policy and private-log acceptance remain separately recorded in [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
