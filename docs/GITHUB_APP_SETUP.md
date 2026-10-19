# GitHub App setup

The preferred integration authenticates as a **GitHub App installation**. GitNostics does not implement a user OAuth flow or registration callback. Create/install the App on GitHub, configure its identifiers and key on the server, restart, then use Settings to validate the connection and discover/select repositories. Credentials never belong in the browser.

## 1. Register an App

In your personal or organization GitHub settings, open **Developer settings → GitHub Apps → New GitHub App**. Choose a unique name and a homepage URL appropriate for your deployment (the local application URL is sufficient for private local use).

- Leave callback/setup URLs unset; no GitNostics callback endpoint exists.
- Do not request user authorization during installation.
- Disable the **Active** webhook option. This implementation polls; do not point GitHub at an unimplemented webhook route.
- Prefer installation only on the account you manage. Wider sharing needs a separate operational/security review.

GitHub's [registration instructions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app) describe these fields.

## 2. Choose least-privilege permissions

Start with **read-only** repository permissions:

| Permission      | Used for                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Metadata        | Basic repository identity; GitHub Apps receive this automatically.                                  |
| Contents        | Branches and recent commits.                                                                        |
| Issues          | Sampled recent open issues, excluding pull requests.                                                |
| Pull requests   | PR metadata and reviews.                                                                            |
| Checks          | Check runs attached to PR heads.                                                                    |
| Commit statuses | Combined commit-status evidence.                                                                    |
| Actions         | Workflow/run/job/artifact/cache metadata and supported logs.                                        |
| Administration  | Optional protected-branch/ruleset/configuration visibility. Add only if you want those diagnostics. |

No organization permissions, webhook events, repository write settings, or workflow-file modification permission are required for the default reader. Some security/configuration information may remain inaccessible because GitHub endpoint, repository plan, and App permissions differ. GitNostics must show that uncertainty.

For the optional rerun/dispatch/artifact-deletion actions only, upgrade **Actions** to **read and write** and approve the changed permissions on the installation. This permission alone does not enable GitNostics writes. Keep Administration read-only. Refer to [GitHub's permission guidance](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) before adding capabilities.

## 3. Generate a private key and install

After creating the App, record its **App ID** (not Client ID). Generate a private key and store the downloaded PEM outside the repository with access restricted to the server account. Never paste it into Settings, a fixture, chat, issue, or image.

Select **Install App**, install on your intended account, and choose **Only select repositories**. Grant only repositories you intend to monitor. Record the installation ID from the installation settings URL, for example the final numeric component of `https://github.com/settings/installations/123456`. Organization installations use an organization settings URL. The App ID and installation ID are different values.

GitHub documents [App installation](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app) and [installation authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation).

## 4. Configure the server

In the ignored `.env`, set your actual values:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=C:/private/gitnostics-app.pem
GITHUB_INSTALLATION_ID=789012
WRITE_ENABLED=false
```

On Linux use a private absolute file path such as `/run/secrets/gitnostics-app.pem`. For Docker, mount that file read-only and use its container path. The three identifiers/path fields must be configured together. The server creates short-lived installation tokens using the key; the key and installation tokens must stay server-side. The database stores metadata, not those credentials.

Restart the server after changing credentials. Open Settings in live mode, validate the connection, discover the installation's allowed repositories, select the desired repositories, then refresh. Compare visible timestamps and warnings with GitHub before trusting diagnostics. App setup and real authorized reads remain release acceptance steps until actually executed.

## 5. Optional write opt-in

Only enable this after reviewing the [security model](SECURITY.md): configure a random operator `AUTH_TOKEN` of at least 32 characters, set `WRITE_ENABLED=true`, and grant Actions write on the App installation. The browser must authenticate as the operator. Each supported action still needs a current permission check and explicit confirmation of an expiring preview. Do not use live writes as automated tests or development verification.

The actor is the installation; GitNostics does not claim it is a GitHub user-authorized OAuth action. Its local audit records the authenticated operator's request and resulting outcome, not a verified human GitHub identity.

## Public access and development PAT

Without App credentials, live mode can read supported public repository APIs. Enter `owner/repository`; private access and authenticated-only endpoints are unavailable, and anonymous rate limits are restrictive.

For isolated local development only, run `pnpm dev` and enable both `ALLOW_DEVELOPMENT_PAT=true` and `GITHUB_TOKEN` server-side. The client requires `NODE_ENV=development` and a fine-grained token; the development launcher selects that environment. Production defaults reject PATs. Grant only selected repositories and needed read permissions; use a short expiration. PAT writes are disabled. Do not configure both App and PAT credentials.

## Disconnect and rotate

Local removal/disconnection does not revoke permissions on GitHub. Stop using the integration, remove the server variables/key, restart, and uninstall the App in GitHub installation settings if access is no longer intended. Rotate/revoke compromised keys in the App settings; revoke a PAT separately. Remove unwanted cached repository metadata/backups according to your local retention needs. Backups may contain private data even though they contain no integration credentials.
