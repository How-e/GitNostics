# Deployment and data operations

The current deployment scope is local Windows use. Linux and Docker configurations are supplied but their deployment acceptance is deferred; remote hosting is also outside the current scope. Actual executed coverage is recorded in [implementation status](IMPLEMENTATION_STATUS.md); configuration is not deployment acceptance. Use Node.js 24.13+ in a supported LTS line and the pinned pnpm version for source deployment.

## Source deployment

Install dependencies from the lockfile, copy/configure `.env.example`, run `pnpm build`, then `pnpm start` from the repository root. The production server serves `apps/web/dist` and `/api` on port 4311. Default binding is loopback. Use a service account with write permission to `DATA_DIR` and read permission to the optional GitHub App key. Do not run as administrator/root.

For remote access set a random `AUTH_TOKEN` of at least 32 characters, bind deliberately, configure HTTPS at a reverse proxy, and set `PUBLIC_ORIGIN`. Keep the server off the public network until access control is validated. Do not expose Vite as a production service. Logs must not include authorization headers or credential-bearing environment values.

## Docker Compose

The image uses Node 24 on Debian bookworm-slim, builds from `pnpm-lock.yaml`, and runs the compiled app as UID/GID 1000. The image contains production dependencies and frontend assets. Embedded migrations are part of the server bundle; no migration sidecar is needed.

1. Copy `.env.example` to `.env`.
2. Set `AUTH_TOKEN` to a cryptographically random value of at least 32 characters. Compose rejects an empty value; the server validates length.
3. Run `docker compose up --build -d`.
4. Check `docker compose ps` and `docker compose logs --tail 100`.
5. Open `http://127.0.0.1:4311`, authenticate, and validate health and persistence before relying on it.

Compose publishes `127.0.0.1:4311:4311`. The process binds `0.0.0.0` inside the container and therefore still requires authentication. A named `gitnostics-data` volume persists `/app/data`. Container health probes the unauthenticated minimal `/api/health` endpoint. The volume must remain writable by UID 1000. For bind mounts, set ownership appropriately rather than using broad write permissions.

The default Compose configuration is public-repository/read-only. To use a GitHub App, create a local `compose.override.yaml` (keep the private path outside Git):

```yaml
services:
  gitnostics:
    environment:
      GITHUB_APP_PRIVATE_KEY_PATH: /run/secrets/gitnostics-app.pem
    volumes:
      - /absolute/private/gitnostics-app.pem:/run/secrets/gitnostics-app.pem:ro
```

Set the App and installation IDs in `.env`. Ensure UID 1000 can read the mounted key; Windows Docker Desktop file sharing differs from Linux permissions. Never COPY a key or `.env` into the image. Do not enable write actions until both GitHub and operator permissions are reviewed.

`docker compose down` retains the named data volume. `docker compose down --volumes` deletes that persistent data and must only be used when you deliberately want to discard it. Image updates do not automatically publish, replace local configuration, or delete old volumes.

## Backup, restore, and upgrade

The API's local backup operation writes a server-generated name inside `DATA_DIR/backups`. Automated backups default to every 24 hours (`BACKUP_INTERVAL_HOURS`; 0 disables). Both paths retain the latest seven generated backup files. Backups include private repository metadata and history; protect them like the active database. They do not contain environment-held GitHub credentials. Removed repository records can remain in older backups until rotation or deliberate local removal. Move encrypted/off-host backup copies through your own approved storage process; GitNostics does not upload them.

Before upgrading, take a consistent backup, record the version/commit and lockfile, stop the service, install/build the reviewed version, then restart. Migrations apply automatically and append versioned schema changes. Keep the pre-upgrade backup because downgrading code does not undo migrations.

To restore: stop the server; preserve the current database plus any `-wal`/`-shm` files in a protected recovery directory; replace the main database with the selected consistent backup; ensure stale WAL/shared-memory files are not reused; verify ownership; restart the matching compatible application version; confirm repository/finding timestamps and integrity. Do not restore over a running connection. Perform a restore drill before treating backups as an accepted recovery plan.

## Health and shutdown

`GET /api/health` is a minimal liveness/version check, not evidence that GitHub credentials, every repository, or every diagnostic is healthy. Inspect connection/sync status separately. Service shutdown handles termination signals; give it time to cancel network work and close SQLite before forcing termination. Container Compose configuration allows a 120-second stop grace period.
