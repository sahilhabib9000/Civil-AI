# Run the CIVIL AI D1 migration safely

This repository includes `migrations/0001_auth_entitlements.sql`. The workflow is manual-only and will not run on pushes.

## One-time GitHub setup

In **Settings → Secrets and variables → Actions**, add these repository secrets:

- `CLOUDFLARE_API_TOKEN`: a dedicated, temporary Cloudflare API token with the minimum permissions needed to run remote D1 migrations for this account. Do not use the Global API Key.
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare Account ID (not a password or API token).

Use the correct account scope and restrict resources to the CIVIL AI account where Cloudflare permits. Do not paste either value into chat, source files, workflow logs, or commit history.

## Run once

After the PR is merged and both secrets are present:

1. Open **Actions → Apply CIVIL AI D1 migrations**.
2. Choose **Run workflow** on `main`.
3. Type exactly `APPLY` in the confirmation field.
4. Run it and inspect the log. A successful Wrangler migration should report migration `0001_auth_entitlements.sql` applied.

The workflow is manual-only, serialized, and targets the remote database named `civil-ai_db` from `wrangler.toml`. It does not create accounts, grant Premium access, or deploy the Worker.

## After success

Revoke/delete the temporary Cloudflare API token. Keep the GitHub secret only if needed for future controlled migrations; otherwise delete it too.

## Important

Do not run this until the PR is merged and the secrets are configured. Authentication still must not be launched: email verification, account recovery, frontend session handling, and cross-site cookie compatibility remain unfinished.