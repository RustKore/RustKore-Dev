# GitHub organization migration

**Observation date:** 2026-11-27
**Upstream reference:** `https://github.com/OpenKore/openkore`, moving branch `master`, inspected commit `db621f04681948b8b89f34e86b84b775e7a34525`. The relevant upstream path is `src/AI/CoreLogic.pm`, symbol `processAutoSkillUse`; no upstream code was used or imported for this platform authorization change.

## Diagnosis

Before this change, repository identity defaulted to the former personal owner and validated PR references against that name. Administrative and review authority was split across `RUSTKORE_ADMIN_GITHUB_IDS`, `RUSTKORE_REVIEWER_GITHUB_IDS`, `reviewer_enabled`, stored D1 roles, MCP token roles, and separate checks in the Worker and dashboard. That made promotion and revocation inconsistent and did not model the new organization teams. PR identity also relied on a repository name rather than the immutable software repository ID.

The platform already had hashed, individually revocable MCP credentials, OAuth sessions, CSRF protection, collaborator suspension, independent review checks, and GitHub merge verification. These remain in use. The platform does not currently have a workflow to recognize integrated PRs that were never attached to a platform task and submission.

## Repository and contribution identity

The platform now pins the software repository to `RustKore/RustKore` (repository ID `1472554035`). A PR reference using either the current owner or the legacy `boscv` owner is accepted only after querying GitHub and validating the base repository ID and full name, PR head SHA, linked GitHub author, and commit author. New D1 rows store the canonical current URL. Migration `0014` makes duplicate detection compare the old and new owner URL forms without rewriting submissions or audit history. The platform repository is `RustKore/RustKore-Dev` (ID `1472413946`) and is not a contribution target.

Organization membership is resolved from GitHub, by immutable organization ID `361817169`, current numeric user ID, and current login. Maintainers is pinned to team ID `20908865`; Release Managers is pinned to team ID `20908882`. The Worker also verifies that the current team directory maps those IDs to the exact names and discovers the current slugs, so recreating either team under the same name cannot restore its privileges. Developers has collaboration-only authority; its current ID is discovered but does not grant extra capabilities. All listed teams must be Visible (GitHub API `privacy: closed`) and have no parent. The implementation rejects duplicate/missing required names and any `Administrators` or `Contributors` team. Organization Owners are resolved before loading the team directory, so missing teams or a failed team-list request do not remove Owner access.

The IDs were supplied from Ruleset bypass lists, but this environment did not have a PAT capable of reading the organization's actual team directory. Unauthenticated requests to GitHub's team endpoints returned `401`, and the public team page returned `404`; therefore the live name-to-ID mapping could not be independently confirmed here. The Worker will compare live team objects against the pinned IDs on every privileged refresh and deny team-derived privileges if a mapping differs. Confirm the mapping with the configured read-only PAT during the live validation step below before completing rollout.

## Effective permission matrix

Capabilities are cumulative. OAuth sessions use the current GitHub grant; MCP credentials additionally intersect that grant with the immutable scope recorded when the credential was issued.

| Identity / active membership | Collaborate | Review | Maintain tasks, integrations, roadmap | Release acceptance | Full administration |
| --- | ---: | ---: | ---: | ---: | ---: |
| Organization Owner (`membership.role=admin`) | Yes | Yes | Yes | Yes | Yes |
| Maintainers | Yes | Yes | Yes | — | — |
| Release Managers | Yes | — | — | Yes | — |
| Developers | Yes | — | — | — | — |
| External authenticated user | Yes | — | — | — | — |
| Suspended platform user | No | No | No | No | No |

An active team membership is required; pending memberships grant no team capability. A user's permissions combine all active team memberships. Organization Owners are recognized by GitHub's native organization membership role, not repository access or team membership. Stored D1 roles and `reviewer_enabled` do not grant authority. Legacy token roles are mapped to a credential scope during migration; a collaborator-scoped token does not become privileged after its owner is promoted. Privileged MCP operations require both the current GitHub capability and the original token scope.

## Runtime and Cloudflare configuration

Ordinary MCP operations, including claims, reads, and heartbeats, authenticate locally against token hashes and D1 suspension/revocation state. They do not call GitHub's organization API. Privileged dashboard reads use a per-isolate cache with a maximum 60-second lifetime. Mutating privileged actions, review decisions, and privileged token issuance force a fresh GitHub check. If privilege cannot be confirmed, the privileged operation fails closed with a temporary response; normal collaboration remains available.

The Cloudflare secret used for GitHub API calls is the existing `GITHUB_API_TOKEN`, with organization Members read access and the existing repository Contents, Pull requests, and Metadata read access. Do not add write, administration, or OAuth user scopes. Preserve the existing `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_OAUTH_CALLBACK_URL`. The Worker name/domain and OAuth callback remain unchanged by design. Set `GITHUB_REPOSITORY=RustKore/RustKore` and `GITHUB_REPOSITORY_ID=1472554035` as non-secret Worker variables.

The Owner completed authenticated production validation: `/api/me` returned all five capabilities and `teams: ["Organization Owners"]`, and `GET /api/admin/collaborators?limit=1` returned collaborator data. After that confirmation, this cleanup removes `RUSTKORE_ADMIN_GITHUB_IDS` and `RUSTKORE_REVIEWER_GITHUB_IDS` from active Cloudflare/project configuration. The Worker has no legacy allowlist or `reviewer_enabled` authorization fallback. Prior configuration remains available in the earlier Worker deployment and repository history for rollback.

## Migration and rollback

The initial migration and Worker deployment are complete. Before this cleanup, the active Worker version was `cc1efa2f-9429-4e04-b3a8-455ecf223fb5`; the previous pre-migration Worker version is `d2b09e39-9e80-4ae1-9dab-bb3d6bb516cd`. The Owner confirmed the production capabilities before the legacy configuration was removed. The cleanup deployment is `7bf42478-d41b-474d-b447-f204cb04bb9e`.

1. Back up the D1 database to a private path outside the repository. Wrangler's remote export is read-only. For example:

   ```sh
   umask 077
   mkdir -p /private/tmp/rustkore-deploy-backup
   npx wrangler d1 export rustkore-db --remote --output=/private/tmp/rustkore-deploy-backup/rustkore-db-pre-0014.sql
   ```

   Also save the current `wrangler.jsonc` and record the active Worker deployment version. Keep the current OAuth settings and old allowlist values available for rollback. Treat the SQL export as sensitive data; retain it only in approved protected storage.

2. Confirm the existing **secret** `GITHUB_API_TOKEN` has Members read access for `RustKore` and the existing repository Contents, Pull requests, and Metadata read permissions. Do not broaden permissions. Use the read-only check below to confirm effective endpoint access and the organization/team identity before deployment.

3. In Cloudflare Workers & Pages → `rustkore` → Settings → Variables and Secrets, set or confirm `GITHUB_REPOSITORY=RustKore/RustKore` and `GITHUB_REPOSITORY_ID=1472554035`. Leave `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `GITHUB_OAUTH_CALLBACK_URL` unchanged. Keep `RUSTKORE_ADMIN_GITHUB_IDS` and any configured `RUSTKORE_REVIEWER_GITHUB_IDS` through initial deployment; the new Worker ignores both.

4. Confirm the migration is pending, then apply it before deploying code that reads `credential_scope`:

   ```sh
   npx wrangler d1 migrations list rustkore-db --remote
   npx wrangler d1 migrations apply rustkore-db --remote
   ```

   The migration is additive and compatible with the previous Worker. It leaves hashes, sessions, submissions, and audit records untouched. The post-insert compatibility trigger also maps `admin`/`reviewer` rows created by the previous Worker during the migration-to-deploy window to their bounded credential scopes.

5. Review the deployment diff and run `npx wrangler deploy --dry-run`. After the backup, PAT, identity checks, and dry-run are confirmed, deploy with `npx wrangler deploy`. The organization migration deployed as `cc1efa2f-9429-4e04-b3a8-455ecf223fb5`; the post-validation configuration cleanup deployed as `7bf42478-d41b-474d-b447-f204cb04bb9e`.

6. Sign in through the existing OAuth app as a real Organization Owner. Confirm `/api/me` returns `admin`, `maintain`, `release`, and `review`, then request `GET /api/admin/collaborators?limit=1` and confirm HTTP 200. Confirm live Maintainers ID `20908865` and Release Managers ID `20908882`, their names/slugs, and the exact visible, independent team directory. Stop rollout if these do not match. Validate Maintainers, Release Managers, Developers, external users, and a suspended user against the matrix.

7. After the Owner checks and team-ID mapping pass, remove `RUSTKORE_ADMIN_GITHUB_IDS` and any configured `RUSTKORE_REVIEWER_GITHUB_IDS` from Cloudflare and all active project configuration; then deploy that cleanup configuration. **Completed:** version `7bf42478-d41b-474d-b447-f204cb04bb9e` has no allowlists in its active configuration. The code has no fallback to these values. Do not restore them as an authorization bypass if GitHub is unavailable.

Rollback: use Cloudflare's deployment history to restore the pre-cleanup Worker version `cc1efa2f-9429-4e04-b3a8-455ecf223fb5`. It contains the verified organization authorization code and the previous configuration snapshot; keep the active OAuth settings, PAT, D1, sessions, and token rows intact. To return to the pre-migration implementation instead, the recorded previous version is `d2b09e39-9e80-4ae1-9dab-bb3d6bb516cd`, whose historical configuration included the old repository owner and allowlist. Leave migration `0014` and D1 data in place: the old Worker ignores `credential_scope`, and the canonicalizing trigger is backward-compatible. The compatibility trigger maps legacy `admin` and `reviewer` inserts during a rollback window. Do not import the full backup over the live database for a code rollback, because that would discard newer writes. Restore a database backup only as a separately approved disaster-recovery action after assessing intervening writes.

### Non-destructive PAT verification

The script `scripts/verify-github-organization.mjs` performs only GitHub `GET` requests. It checks the organization ID, an Owner's stable user ID plus active `admin` membership, all team names/IDs/slugs/visibility/parent fields, the software repository ID, and effective read access to metadata, contents, and pull requests. It prints only identity and authorization metadata, never the PAT. GitHub's `X-Accepted-GitHub-Permissions` header describes the permission required by an endpoint; successful read requests confirm effective read access but do not prove the token lacks unrelated write grants. Confirm the token's configured grant list in GitHub's PAT settings and leave it read-only.

To make the PAT available locally without putting it in chat, logs, or tracked files, create the ignored `.dev.vars` file with restrictive permissions and edit it locally:

```sh
cd /Users/juanbosca/Documents/GitHub/RustKore-DEV
umask 077
touch .dev.vars
chmod 600 .dev.vars
nano .dev.vars
```

Add `GITHUB_API_TOKEN=<PAT>` and, if the token belongs to a different account than the Owner being checked, `RUSTKORE_OWNER_GITHUB_LOGIN=<owner-login>`. Do not paste the PAT into a command line, chat, or issue. Run `node scripts/verify-github-organization.mjs`; it reads the secret locally without echoing it. Remove the PAT line and delete `.dev.vars` after verification if the file is no longer needed. The PAT must remain the existing read-only token; no write or admin permission is required by this script.

## External contributions

Direct GitHub contributions and platform-task contributions must remain distinct. The current platform contribution record requires a task, active lease, submission, independent review, and verified merge; it is not suitable for retroactively attaching an untracked PR without inventing platform activity. A separate external-contribution design should record a verified official-repository PR/merge identity, contributor GitHub user ID, merge commit, and the source as `direct_github`, with deduplication by repository ID and PR number. It should have its own verification/recognition workflow and must never complete a platform task without an explicit, verifiable association and appropriate review. This requires new data and workflow design, so it is intentionally proposed separately rather than added to this authorization migration.

## Validation evidence

The implementation adds controlled GitHub API mocks and D1-local regression coverage for immutable repo identity, legacy URL normalization, unrelated-repository rejection, current team membership and fixed team IDs, credential-scope intersection and legacy token-scope preservation, pending memberships, multiple teams, team removal, Owner demotion, Owner access while the team directory is unavailable, PAT expiry/missing configuration, rate limiting, outages, suspension, and heartbeat request counts.

Local validation on 2026-11-27:

- `npx wrangler types` — passed; refreshed `worker-configuration.d.ts` from the updated Wrangler configuration.
- `npx wrangler d1 migrations apply rustkore-db --local --persist-to=/private/tmp/rustkore-d1-review` — applied all 14 migrations, including `0014_github_organization_authorization.sql`, successfully to an isolated local D1 store.
- `npm test` — passed, 3 files and 58 tests.
- `npx tsc --noEmit` — passed.
- `node --check public/app.js && node --check public/roadmap.js` — passed.
- `npx wrangler deploy --dry-run` — passed and exited with `--dry-run` before the separately authorized production deployments.
- `node --check scripts/verify-github-organization.mjs` — passed; the read-only PAT-backed run returned `passed` before the PAT line was removed from `.dev.vars`.
- Authenticated production Owner validation — passed before cleanup: `/api/me` returned `authenticated: true`, `admin`, `maintain`, `release`, `review`, `teams: ["Organization Owners"]`, and `unavailable: false`; `GET /api/admin/collaborators?limit=1` returned collaborator data.
- Cleanup deployment — version `7bf42478-d41b-474d-b447-f204cb04bb9e`; active binding list no longer contains either legacy allowlist. `wrangler secret list` still contains `GITHUB_API_TOKEN` and `GITHUB_OAUTH_CLIENT_SECRET`.
- Post-cleanup smoke requests — `/health` 200, unauthenticated `/api/me` 200, and unauthenticated `/api/admin/collaborators?limit=1` 401. Authenticated Owner smoke validation after cleanup remains requested.
- Remote migration check — no migrations pending after deployment.
- Local PAT cleanup — removed only `GITHUB_API_TOKEN` from ignored `.dev.vars`; retained `RUSTKORE_OWNER_GITHUB_LOGIN` and its mode `0600`.
- `git diff --check` — passed.

Production migration `0014` and both deployments were authorized and executed. No OAuth, PAT, D1 content, session, or MCP credential was modified during the cleanup deployment. The final authenticated Owner check against the post-cleanup version is still requested; the preceding authenticated validation was before removal of the allowlists.
