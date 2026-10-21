# Releasing

Releases are published from GitHub Actions only: never from a laptop, and never with a long-lived
npm token. npm authenticates the release workflow with **trusted publishing** (OIDC), and every
package gets a **provenance** attestation that links it to the commit and the workflow run that
built it.

The three published packages (`@rungsjs/core`, `@rungsjs/store-memory`, `@rungsjs/store-postgres`)
always share one version (Changesets `fixed` group).

## How a release works

1. Pull requests that change a published package add a changeset (`pnpm changeset`).
2. On every push to `main`, the **Release** workflow (`.github/workflows/release.yml`) opens or
   updates a pull request titled **"chore: version packages"**. It bumps the versions, writes the
   changelogs and deletes the changesets.
3. Merging that pull request runs the workflow again. With no changesets left and versions that
   are not on npm yet, the **Publish to npm** job starts and **waits for approval** in the
   `npm-publish` environment.
4. After approval, the job runs every CI check again, then:
   - publishes each package with `npm publish` (dependencies first; `scripts/publish.mjs`);
   - tags `<package>@<version>` for each package and `v<version>`;
   - creates one GitHub Release, "Rungs `<version>`", from the changelogs
     (`scripts/github-release.mjs`).
5. **Verify** installs the release from npm in an empty folder on Node 22 and 24, checks the
   registry signatures and provenance, runs the quick start, the subpath entry points and the
   PostgreSQL store on PGlite, and type-checks it all in strict mode (`scripts/verify-release.mjs`).

Re-running a failed job is safe: versions already on npm, existing tags and an existing release
are skipped.

## One-time setup

Already done: two-factor authentication with a passkey on the npm account, and the npm
organization `rungsjs`, owned by that account.

### On GitHub (before the first release)

1. **Let the workflow open the version pull request.** Repository **Settings → Actions → General
   → Workflow permissions**: tick **Allow GitHub Actions to create and approve pull requests**, and
   click **Save**. Leave the default permission at "Read repository contents and packages
   permissions"; the workflow asks for what it needs per job.
2. **Create the approval gate.** **Settings → Environments → New environment**, name
   `npm-publish` (exactly), **Configure environment**:
   - **Required reviewers**: tick it and add your own account. Leave "Prevent self-review" off:
     you approve your own releases.
   - **Deployment branches and tags**: choose **Selected branches and tags**, **Add deployment
     branch or tag rule**, and enter `main`.
   - Click **Save protection rules**.
3. **Turn the workflow on.** **Settings → Secrets and variables → Actions → Variables** tab →
   **New repository variable**: name `RELEASES`, value `enabled`. Until then the Release workflow
   skips everything. Set it to anything else to pause releases.

The next push to `main` (or **Actions → Release → Run workflow**) opens the version pull request.

### The first release (0.1.0)

npm can only attach a trusted publisher to a package that already exists, so the first publish
uses a token that lives for one day. It is still published by the workflow, with provenance.

4. **Create the token.** On npmjs.com: your avatar → **Access Tokens** → **Generate New Token**
   → **Granular Access Token**:
   - **Token name**: `rungs-bootstrap-0.1.0`.
   - **Expiration**: the shortest option (1 day).
   - **Packages and scopes**: permission **Read and write**, and select the scope or
     organization `@rungsjs` (if the form only offers "All packages", choose that; the token
     expires tomorrow).
   - **Organizations**: no access.
   - If the form offers **Bypass two-factor authentication** for this token, turn it on: the
     workflow cannot answer a 2FA prompt.
   - **Generate token**, and copy it. It is shown once. Do not save it anywhere else.
5. **Give it to the environment only.** GitHub **Settings → Environments → npm-publish →
   Environment secrets → Add environment secret**: name `NPM_BOOTSTRAP_TOKEN`, paste the token,
   **Add secret**. An environment secret is only readable by the job that has been approved.
6. **Merge** the "chore: version packages" pull request. Read its changelogs first: they become
   the release notes.
7. **Approve.** Open **Actions → Release** and the run of that merge. The **Publish to npm** job
   shows **Review deployments**: tick `npm-publish`, then **Approve and deploy**.
8. **Watch it finish.** Publish, the tags, the GitHub Release and both Verify jobs must be green.
   The packages appear on npmjs.com with a **Provenance** badge.
9. **Remove the token right away**, even though it expires:
   - GitHub: **Environments → npm-publish → `NPM_BOOTSTRAP_TOKEN` → Remove**.
   - npmjs.com: **Access Tokens** → `rungs-bootstrap-0.1.0` → **Delete**.
10. **Announce it in the repository.** The release notices go in a separate pull request after
    Verify is green: `released = true` in `site/src/release.ts` (removes the site banner and the
    "after the 0.1 release" labels), and the pre-release notices at the top of `README.md` and in
    the FAQ.

### Before the second release: trusted publishing

A new trusted publisher configuration expires if it is not used for a successful publish within
**2 days**. So set it up right before merging the next version pull request, not just after 0.1.0.

11. **For each of the three packages** (`npmjs.com/package/@rungsjs/core`, then
    `@rungsjs/store-memory`, then `@rungsjs/store-postgres`): **Settings** → **Trusted
    Publisher** → **GitHub Actions**, and enter exactly (the fields are case-sensitive):

    | Field | Value |
    | --- | --- |
    | Organization or user | `Sodastech` |
    | Repository | `rungs` |
    | Workflow filename | `release.yml` (the file name only, no path) |
    | Environment name | `npm-publish` |
    | Allowed actions | tick **npm publish** |

    Save.
12. **Refuse tokens from now on.** On the same Settings page of each package: **Publishing
    access** → **Require two-factor authentication and disallow tokens** → **Update Package
    Settings**. Trusted publishing keeps working; tokens no longer can publish.
13. **Merge the version pull request and approve it within 2 days** of step 11. That publish
    validates the configurations. If one expired, delete it, create it again, and publish within
    2 days.

From then on a release is: merge the version pull request, approve the deployment.

## Checking before a release

```bash
pnpm build
pnpm check:pack                          # files, LICENSE, size budget, publint, attw
node scripts/publish.mjs --dry-run       # what npm would publish (publishing itself is CI only)
node scripts/github-release.mjs --dry-run   # tags and release notes, after `pnpm changeset version`
```

CI packs the packages and runs the clean-install verification on every push
(`node scripts/verify-release.mjs --tarballs <dir>`). After a release it can be run again against
npm: `pnpm verify:release <version>`.

## When something goes wrong

- **Publish fails with an authentication error (E401, E403, ENEEDAUTH).** For the first release:
  check that `NPM_BOOTSTRAP_TOKEN` is an environment secret of `npm-publish` and the token has
  read and write access to `@rungsjs`. Later: compare the trusted publisher fields with step 11,
  character by character, and check that it has not expired (step 13).
- **Only some packages were published.** Re-run the failed job. Packages already on npm are
  skipped.
- **Verify fails after a publish.** A version on npm cannot be replaced. Fix the problem and
  release a patch version. If the broken version must not be installed, deprecate it
  (`npm deprecate @rungsjs/core@<version> "<why, and which version to use>"`, which asks for your
  passkey). Do not unpublish: other projects may already depend on it.
- **The workflow did not open a version pull request.** Check step 1 and that the `RELEASES`
  variable is `enabled`.
