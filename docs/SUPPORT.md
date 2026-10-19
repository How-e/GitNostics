# Support

GitNostics currently supports local Windows operation for one trusted operator. Check [implementation status](IMPLEMENTATION_STATUS.md) and [GitHub App setup](GITHUB_APP_SETUP.md) before reporting a connection problem. Linux/Docker and remote hosting acceptance remain deferred.

Contact [GitNostics@protonmail.com](mailto:GitNostics@protonmail.com) for support. This is the maintainer-approved public address; external delivery and receipt have not been verified in this checkout. Confirming receipt and integration contact settings remains an open [integration readiness](INTEGRATION_READINESS.md) item. The generic Git commit email is not a support channel. There is no guaranteed response time or support SLA.

When repository issues are available, use them for ordinary reproducible bugs or feature requests. Include the application commit/version, Node version, operating system, relevant mode (live or demo), reproduction steps, expected behavior, and sanitized error text. State whether results are fixture observations, operator reports, or real read-only GitHub observations.

Never attach `.env`, keys, tokens, runtime databases, backups, private repository names, raw workflow logs, or screenshots containing sensitive data. Do not run a real GitHub write to reproduce an automated test. For suspected vulnerabilities, follow the private [security reporting policy](../SECURITY.md).

GitHub permissions, App installation membership, and organization policy are controlled by the account or organization owner. Removing a repository or disconnecting GitNostics does not revoke access on GitHub; see [disconnect and rotate](GITHUB_APP_SETUP.md#disconnect-and-rotate). Backups and other retained local copies require separate cleanup as described in the [data handling notice](PRIVACY.md).
