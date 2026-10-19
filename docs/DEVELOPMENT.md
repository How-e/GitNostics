# Development

Use Windows 11 or Linux with Node.js 24.13+ in a supported LTS line, Git, and pnpm 11.25.0. Node's built-in SQLite support is part of the runtime requirement. Dependency versions and scripts live at the workspace root.

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env`, then `pnpm dev`. The web development server uses port 4310 and proxies `/api` to port 4311. Both start on localhost. `.env` is server configuration; never place secrets in `VITE_` variables. Production serves both web and API from port 4311 after `pnpm build && pnpm start`.

## Configuration

| Variable                      | Default     | Meaning                                                                                                          |
| ----------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `HOST`                        | `127.0.0.1` | API bind. Non-loopback requires `AUTH_TOKEN`.                                                                    |
| `PORT`                        | `4311`      | HTTP port.                                                                                                       |
| `DATA_DIR`                    | `./data`    | SQLite, backups, and local state location. Relative to working directory.                                        |
| `BACKUP_INTERVAL_HOURS`       | `24`        | Automated consistent-backup interval; 0 disables, maximum 168; latest 7 backup files retained.                   |
| `AUTH_TOKEN`                  | Empty       | Operator login token, required for remote binding and real writes; use at least 32 random characters.            |
| `PUBLIC_ORIGIN`               | Empty       | Explicit browser origin when deployed behind a reverse proxy. Configure the actual HTTPS origin, without a path. |
| `WRITE_ENABLED`               | `false`     | Additional server-side gate for supported GitHub mutations.                                                      |
| `GITHUB_APP_ID`               | Empty       | Registered App ID; all three App variables must be configured together.                                          |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Empty       | Absolute/private server path to GitHub App PEM key.                                                              |
| `GITHUB_INSTALLATION_ID`      | Empty       | Installation whose selected repositories may be discovered.                                                      |
| `ALLOW_DEVELOPMENT_PAT`       | `false`     | Explicitly permits the development PAT fallback.                                                                 |
| `GITHUB_TOKEN`                | Empty       | Development-only fine-grained PAT, never a browser credential.                                                   |

The operator token controls access to GitNostics; it is separate from GitHub credentials. Enter it in the login form once per session. The server sets an HttpOnly, SameSite Strict opaque cookie; mutations additionally require a CSRF token. The UI keeps the entered login value only in React state, never localStorage. Prefer a generated random value (`node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`) and keep it in ignored local configuration. Do not put tokens in URLs, shell history shared with others, issue reports, or screenshots.

## Commands and checks

| Command                                 | Purpose                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                              | Start API and Vite together.                                                                                    |
| `pnpm dev:server` / `pnpm dev:web`      | Start one development process.                                                                                  |
| `pnpm typecheck`                        | Strict project TypeScript validation.                                                                           |
| `pnpm lint`                             | ESLint.                                                                                                         |
| `pnpm format:check`                     | Verify formatting without editing.                                                                              |
| `pnpm format`                           | Format tracked source/configuration.                                                                            |
| `pnpm test`                             | Unit and API/database/GitHub fixture integration suites.                                                        |
| `pnpm build` / `pnpm start`             | Compile and start the production server/frontend.                                                               |
| `pnpm exec playwright install chromium` | Install browser required for local E2E. Linux CI uses `--with-deps`.                                            |
| `pnpm test:e2e`                         | Isolated browser workflow suite.                                                                                |
| `pnpm test:production`                  | Built-server static routes, restart persistence, backups and mode isolation with no GitHub requests.            |
| `pnpm check`                            | Formatting, lint, typecheck, unit/integration, and build. E2E/security checks are separate.                     |
| `node scripts/check-secrets.mjs`        | Heuristic credential checks over non-ignored repository files; prints paths/rules, never matched secret values. |
| `pnpm audit --prod --audit-level high`  | Check production dependency advisories; requires registry network access.                                       |

No test may use real GitHub write credentials. Network integration uses injected fake transports; browser tests use isolated fixture mode/data. Add deterministic tests for both denied and allowed action paths without invoking GitHub. Do not interpret a demo confirmation dialog as a real mutation.

## Persistence, backup, and troubleshooting

Data is created under `DATA_DIR` and excluded from Git. Migrations apply at startup in version order. Back up before upgrading, retain a copy of the exact release/lockfile, and restore only while the server is stopped. Use the API backup operation for consistent online backups rather than copying the main SQLite file while WAL writes are active. More in [deployment](DEPLOYMENT.md).

For an empty live workspace, add an authorized public repository or configure a GitHub App. A missing-permission warning is expected when an App lacks a read capability. For rate limiting, wait for the reported reset/retry time; do not repeatedly refresh. If startup rejects the bind/token configuration, keep localhost binding or configure an operator token of sufficient length. If App credentials are incomplete or invalid, correct the server environment/key path and restart.

When reporting a bug, include commit/runtime, sanitized configuration names, reproducible steps, and exact failed checks. Do not attach an unsanitized database, `.env`, key, or private log excerpt.
