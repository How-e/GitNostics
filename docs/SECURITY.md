# Security model and operating limits

GitNostics is designed for one trusted operator. It is not a multi-tenant service. Repository metadata, PR titles, workflow excerpts, and configuration snapshots can be private information even without credentials.

## Network and operator access

The default API bind is `127.0.0.1`. A non-loopback bind must have `AUTH_TOKEN` with at least 32 characters; startup rejects unsafe exposure. Do not publish an unauthenticated development server. For remote access, place the production server behind an HTTPS reverse proxy, set `PUBLIC_ORIGIN` to its actual origin, restrict network access, and preserve the browser Host/Origin and session cookies without logging sensitive values.

Operator authentication uses a shared login token, not individual user accounts. Anyone holding it has operator access. `POST /api/login` validates the token, rotates an opaque HttpOnly SameSite Strict session cookie, and grants an eight-hour session. The cookie is Secure for an HTTPS public origin. The token is not a bearer API credential; the UI keeps the entered value only in React state, never localStorage. Sessions are memory-held and end on logout, restart, or expiry. Rotate the operator token by updating server configuration and restarting. Avoid untrusted browser extensions and shared devices; sign out when finished.

All API mutations, including login, require the session's `X-CSRF-Token` obtained from `GET /api/session`; JSON bodies use `Content-Type: application/json`. The server validates Host/Origin and rejects cross-site fetches. HttpOnly same-site cookies, CSRF tokens, and origin validation also matter for local-only operation. Do not configure permissive CORS or trust arbitrary proxy headers. Security response headers and the production content security policy should remain enabled.

## GitHub credentials and outbound access

Use a GitHub App with selected repositories and minimal read permissions. Keep its private key in a restricted server-only file. Installation tokens are short-lived and process-held; no key or token should enter SQLite, browser payloads, fixtures, exception text, or Git. A development PAT requires explicit opt-in and must not become the default production integration.

GitHub resource identifiers are validated. The integration uses narrow official API destinations; untrusted repository content cannot choose an arbitrary outbound URL. Download redirects must stay within explicitly allowed GitHub log hosts and never forward authorization across unrelated origins. Bound downloads by bytes, redirects, time, cancellation, and retries. Redact likely credentials before keeping workflow excerpts or using them in diagnostics.

Pattern redaction and heuristic secret scanning are defense layers, not proof that arbitrary private text is safe to publish. Treat database exports, backups, sanitized reports, and issue attachments as sensitive until reviewed. Do not send private data to an AI or external notification provider without a concrete implementation and explicit consent; initial provider interfaces do not transmit anything.

## Safe actions

Supported mutation kinds are a fixed allowlist: rerun failed jobs, rerun a run, dispatch a workflow, and delete selected artifacts. Real execution requires all of:

1. `WRITE_ENABLED=true` on the server.
2. An authenticated operator using `AUTH_TOKEN`.
3. A selected live repository and a credential with currently verified Actions write permission.
4. A validated, expiring preview bound to the intended resources and an explicit confirmation.
5. Auditing of requested/succeeded/failed outcomes without credential values.

Artifact deletion is destructive and requires a clear resource/size preview. Replays and stale previews must be rejected. Denied permission cannot be converted to assumed permission. No automatic merge, repository deletion, protection weakening, generic API proxy, or arbitrary command execution is supported.

Tests and development verification must never send real GitHub mutations. Fake transports validate executor behavior; separate owner-controlled production acceptance is not an automated gate.

## Local data and dependencies

SQLite migrations are embedded, additive, and versioned. WAL and backups need protected directory permissions. Native online backup includes committed WAL state. Stop the application before restoring and never replace a running database. Do not expose `DATA_DIR` through the web server or add it to a repository.

Bound history, logs, background concurrency, request bodies, and pagination. A configured retention period applies to historical tables and resolved findings, with hard caps; it does not imply archival completeness or remove current snapshots/active findings. Backups follow a separate seven-file policy and may retain removed metadata until rotation or deliberate removal. Malicious GitHub strings must remain text in the UI, never executable HTML or commands.

CI uses read-only repository permission, no production credentials, a lockfile, dependency auditing, and heuristic secret checks. Dependabot proposes updates through reviewable PRs. Require passing checks on the final PR commit and review workflows/permissions; do not relax branch protections to publish. Audit results are time-sensitive and must be rerun for releases.

## Residual acceptance work

See [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md). Authentication, credential revocation, GitHub endpoint behavior, proxy deployment, browser accessibility, Linux container permissions, and sustained resource behavior need real-environment validation. Supplied configuration or fixture tests do not establish that acceptance.
