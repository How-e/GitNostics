# Data handling notice

GitNostics is self-hosted. The operator controls the server, configured GitHub installation, local data directory, backups, and browser access. There is no hosted GitNostics account, built-in telemetry, or implemented AI/external notification delivery. This notice describes the current application, not a separately operated hosting service.

## Information used

Live synchronization requests supported GitHub metadata for selected repositories: repository identity, pull requests and reviews, checks/statuses, workflow/run/job/artifact/cache metadata, sampled issues/branches/commits, and supported configuration. Supported workflow log retrieval uses bounded downloads and redacted excerpts. Metadata and excerpts can still disclose private names, activity, or content; redaction is heuristic.

SQLite under `DATA_DIR` stores snapshots, diagnostic evidence/findings, settings, histories, audit events, and local notifications. Backups under that directory contain repository data. Demo fixtures are synthetic and stored separately by mode; they are not evidence that an installation or live repository was accessed.

GitHub private keys and integration credentials remain server-side, outside the client bundle and database. Short-lived installation tokens are process-held. Operator login establishes an HttpOnly session cookie; sessions expire after eight hours or end on logout/restart. The application does not create individual user accounts. The browser may retain non-secret display preferences; do not use a shared browser profile for private repository work.

## Transfers and access

Live reads communicate with GitHub APIs and permitted GitHub log-download hosts. Optional GitHub writes require the safeguards described in the [security model](SECURITY.md). The browser receives repository evidence from the operator's server. Anyone with operator access can view that data. Protect the server, local files, backups, and reverse proxy; configure HTTPS before remote use. GitHub and any hosting/proxy provider have their own data handling policies.

GitNostics does not automatically send repository data to a maintainer for support. Review every report or attachment before sharing it. Local logs, screenshots, and exports may contain sensitive metadata even when credentials are absent.

## Retention, deletion, and revocation

Configured retention limits historical records and resolved findings; it does not remove current snapshots or active findings. Backups have separate seven-file rotation and may retain previously removed metadata. Disconnection and pausing repository monitoring do not erase local history or revoke GitHub permissions. Removing a repository deletes its associated local records in that mode, but does not erase existing backup copies.

For complete local removal, stop the server, identify the configured `DATA_DIR`, and remove its database, WAL/SHM files, backups, and any separately retained reports/logs. Keep unrelated files intact. Remove server credentials and the private key if no longer needed, then revoke/uninstall the App or rotate its key on GitHub as appropriate. Delete browser site data on shared devices. The operator must handle any additional machine, proxy, backup, or hosting copies under their control; the application does not promise secure erasure from storage media.

For questions, follow [support guidance](SUPPORT.md); use the private [security policy](../SECURITY.md) for vulnerabilities or suspected credential exposure.
