# Support

GitNostics currently supports local Windows operation for one trusted operator. Check [implementation status](IMPLEMENTATION_STATUS.md) and [GitHub App setup](GITHUB_APP_SETUP.md) before reporting a connection problem. Linux/Docker and remote hosting acceptance remain deferred.

Contact [GitNostics@protonmail.com](mailto:GitNostics@protonmail.com) for support. The maintainer confirmed successful email delivery to this mailbox on 2026-10-18; this is operator-reported evidence. Integration contact settings remain an open [integration readiness](INTEGRATION_READINESS.md) item. The Git commit email is not a support channel. There is no guaranteed response time or support SLA.

Use [GitHub Issues](https://github.com/How-e/GitNostics/issues) for ordinary reproducible bugs or feature requests. The source repository is public, so issue content is public too. Include the application commit/version, Node version, operating system, relevant mode (live or demo), reproduction steps, expected behavior, and sanitized error text. State whether results are fixture observations, operator reports, or real read-only GitHub observations.

Never attach `.env`, keys, tokens, runtime databases, backups, private repository names, raw workflow logs, or screenshots containing sensitive data. Do not run a real GitHub write to reproduce an automated test. For suspected vulnerabilities, follow the private [security reporting policy](../SECURITY.md).

GitHub permissions, App installation membership, and organization policy are controlled by the account or organization owner. Removing a repository or disconnecting GitNostics does not revoke access on GitHub; see [disconnect and rotate](GITHUB_APP_SETUP.md#disconnect-and-rotate). Backups and other retained local copies require separate cleanup as described in the [data handling notice](PRIVACY.md).
