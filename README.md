# GitNostics

**Diagnose. Understand. Resolve.**

GitNostics is a self-hosted GitHub diagnostics tool for maintainers who need to understand blocked pull requests, recurring Actions failures, retained artifacts, and configuration changes. Its deterministic rules attach evidence and confidence to each finding. It runs locally without AI or a hosted GitNostics account.

This is a working initial implementation, **not a release-ready claim**. Read [implementation status](docs/IMPLEMENTATION_STATUS.md) for the supported scope, executed checks, and outstanding acceptance work.

M0 foundation acceptance is complete and operator-verified. The current deployment scope is local Windows use, with operator-confirmed GitHub App access to public and private repositories in production mode. Linux/Docker deployment acceptance is deferred.

## What you can explore

- A repository command center with cached-data timestamps and explicit synchronization errors.
- Pull request diagnostics for supported checks, reviews, and mergeability conditions.
- Workflow history, bounded failure analysis, normalized signatures, and repeated incidents.
- Artifact inventory, storage snapshots, retention recommendations, and cleanup previews.
- Configuration baselines and evidence-backed drift findings.
- A findings inbox with acknowledgment, suppression, lifecycle tracking, and in-app notifications.
- A Safe Action Center with expiring previews, explicit confirmation, permission checks, and audit events. GitHub writes are disabled by default.
- A separate, labeled demo workspace requiring no GitHub credentials, with dark/light themes and responsive navigation.

## Start locally

Requirements: Node.js **24.13 or later in a supported LTS line**, pnpm **11.25.0**, and Git. SQLite is embedded; no database server is needed.

```sh
corepack enable
corepack prepare pnpm@11.25.0 --activate
pnpm install --frozen-lockfile
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` on Linux), then run:

```sh
pnpm dev
```

Open [http://localhost:4310](http://localhost:4310). The API listens on `127.0.0.1:4311`; Vite proxies `/api`. Choose the labeled demo workspace to explore fixture data, or add a public `owner/repository` in live mode. Public access has stricter GitHub rate limits and incomplete private/configuration data.

For a production build:

```sh
pnpm build
pnpm start
```

Open [http://localhost:4311](http://localhost:4311). The server serves the compiled frontend and API together. Keep `data/` outside version control; it contains local repository metadata and history.

## Connect a GitHub App

Follow [GitHub App setup](docs/GITHUB_APP_SETUP.md) to create an App, install it on selected repositories, and configure its App ID, installation ID, and private-key file **on the server**. Registration and installation happen on GitHub; this implementation does not provide a browser OAuth callback or a multi-user GitHub sign-in service.

Default permissions are read-only. Optional supported writes require Actions write permission, `WRITE_ENABLED=true`, and an operator `AUTH_TOKEN`. Installation permissions and operator authorization are separate gates. A PAT is an explicitly enabled development fallback, not the production authentication path.

## Docker

Docker configuration is supplied; consult [deployment](docs/DEPLOYMENT.md) and implementation status for verification limits. Set a random `AUTH_TOKEN` of at least 32 characters in `.env` before starting:

```sh
docker compose up --build -d
docker compose logs --tail 100
```

Open [http://127.0.0.1:4311](http://127.0.0.1:4311) and sign in with the operator token. Compose publishes only on loopback and persists `/app/data` in a named volume. Container binding uses `0.0.0.0`, so authentication is required even with loopback host publishing. For a GitHub App, mount the private key as described in the deployment guide.

## Security and permissions

The default local bind is loopback. Non-loopback binding requires operator authentication; use HTTPS through a correctly configured reverse proxy for remote access. Credentials stay on the server and are not stored in the SQLite database or frontend bundle. Private repository metadata remains sensitive even without credentials. Read the [security model](docs/SECURITY.md) and [reporting policy](SECURITY.md).

GitNostics does not weaken branch protection, merge PRs, delete repositories, execute arbitrary shell commands, or expose an unrestricted GitHub API proxy. Tests use isolated demo data and fake GitHub transports; never point mutation verification at real repositories.

## Development and roadmap

```sh
pnpm check
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:production
node scripts/check-secrets.mjs
pnpm audit --prod --audit-level high
```

See [development](docs/DEVELOPMENT.md), [architecture](docs/ARCHITECTURE.md), [API](docs/API.md), and the dependency-ordered [roadmap](docs/ROADMAP.md). Contributions should include evidence for diagnostic claims and preserve safe defaults. See [CONTRIBUTING.md](CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

The source is public at [How-e/GitNostics](https://github.com/How-e/GitNostics). Before pushing contributions, follow the [publication privacy checklist](docs/PUBLICATION_PRIVACY.md). Ignore rules do not remove committed files, and Git history includes author/committer identities.

Read the [data handling notice](docs/PRIVACY.md), [support guidance](docs/SUPPORT.md), and [integration readiness checklist](docs/INTEGRATION_READINESS.md) before sharing or operating an installation. Contact [GitNostics@protonmail.com](mailto:GitNostics@protonmail.com) for support; the maintainer confirmed successful email delivery to this mailbox on 2026-10-18. Report reproducible bugs or request features through [GitHub Issues](https://github.com/How-e/GitNostics/issues). App homepage and integration contact settings remain unverified; hosted verification evidence is recorded in implementation status.

Licensed under the [MIT License](LICENSE).
