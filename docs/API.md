# HTTP API

The Fastify API is served under `/api`; production serves the frontend on the same origin. Development uses the Vite `/api` proxy. Contracts are defined in `packages/shared/src/index.ts`; source routes in `apps/server/src/app.ts` and `security.ts` are authoritative. There is no generic GitHub proxy or arbitrary URL/command execution endpoint.

## Session and request security

1. `GET /api/session` establishes an opaque `gn_session` cookie and returns `{csrfToken, authenticated, requiresLogin}`. Preserve the cookie.
2. If login is required, `POST /api/login` with JSON `{token: "<operator login token>"}` and the session's `X-CSRF-Token`. Successful login rotates both cookie and CSRF token; use the returned token thereafter.
3. All subsequent non-GET/HEAD/OPTIONS API requests need the session cookie, current `X-CSRF-Token`, permitted Host/Origin, and JSON content type for JSON bodies.
4. `POST /api/logout` clears the session. Login grants an eight-hour memory-held session; restarting the process also invalidates it.

Cookies are HttpOnly, SameSite Strict, and Secure for an HTTPS public origin. The API does **not** accept `AUTH_TOKEN` as bearer authorization. Without a configured operator token, local sessions are automatically authenticated but still require CSRF protection. Only health/session/login are accessible without authentication when an operator token is configured. Do not send the login token in a URL.

API responses use `Cache-Control: no-store`. Errors return `{error: string}` with sanitized details. Typical statuses: `400` invalid input, `401` sign-in required, `403` origin/CSRF/authorization denial, `404` unknown resource, `409` conflicting state/stale preview, `429` rate limit, `502` upstream failure. Request bodies are capped at 64 KiB. Global rate limiting and stricter login/session limits apply.

## Data modes

Domain endpoints accept `?mode=live` or `?mode=demo`; omission selects `live`. The database, settings, findings, histories, and previews keep these modes separate. Demo reset and demo actions never contact GitHub. Connection discovery/disconnection and backup are server operations rather than per-mode GitHub credentials.

## Routes

| Method and path                                | Input / behavior                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`                              | Minimal `{status, version, database}` liveness response. Does not validate GitHub.                                                                                                                                                 |
| `GET /api/session`                             | Establish/read session and obtain CSRF token.                                                                                                                                                                                      |
| `POST /api/login`                              | `{token}`; authenticate operator, rotate session.                                                                                                                                                                                  |
| `POST /api/logout`                             | End current session.                                                                                                                                                                                                               |
| `GET /api/dashboard?mode=…`                    | Repositories, findings, activity, incidents, notifications, settings, connection, and local storage history. Snapshot timestamps/warnings describe freshness/coverage.                                                             |
| `GET /api/settings?mode=…`                     | Read mode-specific settings.                                                                                                                                                                                                       |
| `PUT /api/settings?mode=…`                     | Complete validated settings object. Reevaluate stored diagnostics using new rule/preferences.                                                                                                                                      |
| `POST /api/demo/reset`                         | Replace fictional demo repositories/findings; refuses while demo sync is queued/running. Live data remains separate.                                                                                                               |
| `POST /api/repositories?mode=live`             | `{fullName: "owner/repo"}`; select and queue a repository. Maximum 100 monitored repositories; demo repository set is fixed.                                                                                                       |
| `PATCH /api/repositories/:owner/:repo?mode=…`  | `{favorite?: boolean, selected?: boolean}`; update monitoring preferences.                                                                                                                                                         |
| `DELETE /api/repositories/:owner/:repo?mode=…` | Remove local monitored repository and related data; never deletes the GitHub repository. Cancel queued/running sync first.                                                                                                         |
| `POST /api/sync?mode=…`                        | `{repository?: "owner/repo"}`; queue selected repository/all selected repositories. Returns queued count.                                                                                                                          |
| `POST /api/sync/cancel?mode=…`                 | Cancel pending/supported running synchronization for that mode.                                                                                                                                                                    |
| `PATCH /api/findings/:id?mode=…`               | `{status: "acknowledged" \| "suppressed" \| "active"}`; manual lifecycle change. Findings resolve through supported observation, not arbitrary client assertion.                                                                   |
| `POST /api/baselines?mode=…`                   | `{repository: "owner/repo"}`; save accessible current snapshot values as expected configuration and reevaluate drift.                                                                                                              |
| `POST /api/notifications/:id/read?mode=…`      | Mark an in-app notification read.                                                                                                                                                                                                  |
| `GET /api/connection/discovery`                | Return `{repositories: {fullName, private}[], complete: boolean}` for the configured installation/development identity; capped at five pages / 500 repositories. Upstream errors remain explicit.                                  |
| `POST /api/connection/disconnect`              | Stop integration use and clear in-memory credentials/tokens/previews. Remove environment/key configuration before restart to stay disconnected. Does not revoke GitHub installation permissions or erase local repository history. |
| `POST /api/backup`                             | Create a consistent local SQLite backup under a fixed server-owned `DATA_DIR/backups` name. Returns filename/message; does not export file contents or credentials.                                                                |
| `POST /api/actions/preview?mode=…`             | A validated action request; returns impact, authorization, confirmation text, and five-minute expiry.                                                                                                                              |
| `POST /api/actions/execute?mode=…`             | `{previewId, confirmation}`; execute or simulate only a current authorized preview.                                                                                                                                                |

## Discovery and disconnect

Discovery reports `complete: false` when the five-page limit is reached and additional repositories remain. Preserve the returned choices and show the incomplete-coverage warning; never interpret an omitted repository as proof that it is inaccessible or removed. The discovery cap is separate from the 100 monitored-repository limit. A manually disconnected connection returns `409` for discovery, live repository addition, and live sync, before adding records or queueing work. Restart after configuring access to reconnect; demo mode and cached live data remain separate.

## Settings contract

The complete object contains `theme` (`dark`, `light`, `system`), `syncIntervalMinutes` (0 disables; otherwise 5–1440), `retentionDays` (7–365), `artifactAgeDays` (1–365), `notificationsEnabled`, `minimumSeverity` (`critical`, `high`, `medium`, `low`, `info`), and `suppressedRules` (up to 100 rule IDs). Do not send partial settings to `PUT`; fetch/modify the current object.

## Action requests and confirmation

Every request contains `repository` and one supported `kind`:

| Kind               | Additional fields   | Preview impact                                                                                         |
| ------------------ | ------------------- | ------------------------------------------------------------------------------------------------------ |
| `rerun_failed`     | `runId`             | Eligible failed completed run; rerunning can execute code and consume minutes.                         |
| `rerun`            | `runId`             | Completed synchronized workflow run; can execute code and consume minutes.                             |
| `delete_artifacts` | `artifactIds`       | 1–100 distinct artifact IDs from the synchronized snapshot; names/sizes and permanent-deletion impact. |
| `dispatch`         | `workflowId`, `ref` | Known workflow and branch from the synchronized history; GitHub must allow `workflow_dispatch`.        |

A preview is allowed only after required server/credential/repository gates pass; otherwise it explains the denied capability. Live action data must be less than 15 minutes old. Execute uses the exact returned confirmation string (`EXECUTE`, `DELETE N ARTIFACTS`, or demo `SIMULATE`), consumes the preview, and rejects replay, mode mismatch, changed snapshot/monitoring state, expired data, or lost authorization. A fresh GitHub permission check still occurs in the integration executor.

Success returns `{ok, simulated, message}` and queues a live refresh. Upstream acceptance does not mean a workflow has completed. Multi-artifact deletion may partially complete before an upstream failure; audit outcomes explicitly instruct the operator to inspect GitHub before retrying. Demo success states `simulated: true` and sends no request to GitHub.

No webhook, OAuth callback, arbitrary file download, AI invocation, automatic merge, or branch-protection mutation endpoint is implemented.
