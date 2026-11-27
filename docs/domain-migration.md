# Platform domain migration

The canonical platform origin is `https://rustkore.dev`. The existing `https://rustkore.boscv.workers.dev` hostname remains active for compatibility during the transition. Both names invoke the same `rustkore` Worker and D1 database; no Worker, database, credential, or schema migration is involved.

## Findings and behavior

- The old hostname was embedded in the OAuth callback, dashboard MCP instructions, JSON-LD, and README. These now use `rustkore.dev` as the canonical address.
- OAuth uses host-bound state cookies and stores only a hash of the state plus its PKCE verifier in D1. OAuth begins and ends on the same exact hostname. The Worker chooses the callback from an allowlist: the configured canonical callback host or the legacy `workers.dev` hostname. Other hosts, including version/preview hosts, cannot start or complete OAuth.
- Session and CSRF cookies have no `Domain` attribute. Existing cookies on `workers.dev` are not sent to `rustkore.dev`; users sign in again on the new host. Both sessions resolve to the same collaborator by immutable GitHub user ID. Logout revokes only the session on the current host.
- Web writes compare `Origin` with the request's own origin and validate CSRF. MCP accepts requests with no `Origin` (as required by non-browser clients) and rejects a supplied origin that differs from the request host. MCP bearer credentials are host-independent and continue to work on either hostname.
- CSP `connect-src` and `form-action` are `'self'`; no CORS allowlist needs a domain entry. Browser API calls use relative paths. No webhooks, service bindings, distributed Worker calls, heartbeat/lease callbacks, or GitHub Actions deployment URLs depend on the old hostname. The only workflow is CI for tests, typechecking, and Wrangler dry-run.
- D1 stores task pull-request URLs targeting `github.com`, plus user-entered roadmap evidence and project context. It does not store a platform base URL. Those URLs and audit rows are retained as-is; no D1 migration or historical rewrite is needed.
- Wrangler now declares the existing Custom Domain `rustkore.dev`, explicitly keeps `workers.dev` enabled, and disables public Version URLs. Version URLs run an uploaded version against production resources; this repository has no branch-preview deployment workflow. If branch Previews are enabled separately in Cloudflare, confirm they use isolated bindings/secrets before enabling them.

## GitHub OAuth configuration

Keep the current OAuth application, Client ID, Client Secret, and `read:user` scope. In GitHub Developer Settings → OAuth Apps → the existing RustKore application, set:

- **Homepage URL:** `https://rustkore.dev`
- **Callback URL 1 (canonical):** `https://rustkore.dev/auth/callback`
- **Callback URL 2 (legacy transition):** `https://rustkore.boscv.workers.dev/auth/callback`

The Worker sends the matching callback URL for the hostname where sign-in started and redeems the code with that same URL. Keep both callback entries while the legacy hostname remains supported. Do not enable wildcard callback matching; the two exact URLs are sufficient. GitHub's current OAuth App settings support multiple callback URLs; see [GitHub's OAuth app redirect URI announcement](https://github.blog/changelog/2026-08-14-multiple-redirect-uris-and-token-refresh-for-oauth-apps/) and [OAuth authorization documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

## Cloudflare rollout

No new secret or secret value is required. `GITHUB_OAUTH_CALLBACK_URL` is a non-secret Worker variable and is now set in `wrangler.jsonc` to `https://rustkore.dev/auth/callback`. The existing `GITHUB_API_TOKEN`, `GITHUB_OAUTH_CLIENT_SECRET`, D1 binding, rate limiter, Worker name, and account subdomain stay unchanged.

1. In GitHub, update the existing OAuth app Homepage URL and register both exact callback URLs above. Leave the old callback registered while the old hostname is supported.
2. Review Cloudflare Workers & Pages → `rustkore` → Settings → Domains & Routes. Confirm `rustkore.dev` is an active Custom Domain and the existing `rustkore.boscv.workers.dev` route is enabled. Do not remove or recreate either domain or edit DNS/nameservers.
3. Run `npx wrangler deploy --dry-run` and inspect that the configuration keeps `workers_dev: true`, declares `rustkore.dev` with `custom_domain: true`, sets `preview_urls: false`, and uses the canonical callback.
4. Deploy the existing Worker with `npx wrangler deploy`. Wrangler should reconcile the already-associated Custom Domain from configuration; it does not create another Worker or D1 database. No migration command is needed.
5. Smoke-check `https://rustkore.dev/health`, `/api/me`, `/mcp`, and `https://rustkore.boscv.workers.dev/health`. Test OAuth on both hosts and confirm the OAuth redirect's `redirect_uri` matches its starting host. Use an existing MCP token against `/mcp` on each host; do not create or rotate credentials for this test.
6. Confirm a browser login on `rustkore.dev` resolves to the existing GitHub identity and capabilities, and that logout ends that host's session. Do not expect a `workers.dev` cookie to appear on the new domain.
7. Keep the legacy hostname, callback, and OAuth configuration in place until clients and users have moved. Update integrations to `https://rustkore.dev/mcp`; existing clients using the old endpoint remain supported during this transition.

Cloudflare documents that adding `routes` can infer `workers_dev` as disabled unless it is explicitly true, so the explicit setting is required to preserve the legacy hostname. It also documents that Version URLs otherwise inherit the `workers.dev` setting and run against production bindings. See [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/), [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/), and [Version URLs](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/).

## Deployment record — 2026-11-27

- Previous production version recorded before deployment: `7bf42478-d41b-474d-b447-f204cb04bb9e` (100% traffic).
- Domain migration version: `3e2ce8ea-fe53-42d8-9642-109a34b73bd5`.
- Cloudflare's read-only Worker subdomain settings endpoint returned `enabled: true` and `previews_enabled: false` after deployment. Probes against the prior version URL patterns returned Cloudflare 404 for each tested version, including `7bf42478`.
- `rustkore.dev` and `rustkore.boscv.workers.dev` returned HTTP 200 for `/health` and the home page. Both pages advertise `https://rustkore.dev/` and the canonical MCP URL.
- Unauthenticated `/api/me` returned HTTP 200 with `authenticated: false`; the unauthenticated collaborators endpoint returned 401. OAuth start returned HTTP 302 on both domains with the matching callback URI and a Secure state cookie.
- An existing MCP bearer credential returned HTTP 200 for `tools/list` (10 tools) and `get_progress` on both domains. The token value was not logged or changed.
- `npm test` passed all 59 tests; TypeScript, Wrangler dry-run, and JavaScript syntax checks passed before deployment. No D1 migration was run. `wrangler versions view` confirmed the existing D1 binding ID and secret names remain on the deployed version.
- The post-deploy record initially awaited an interactive Owner session because the prior host's cookies are host-only; the completed Owner check is recorded below.

## Owner validation — 2026-11-27

The Owner completed the canonical-domain login and authenticated production checks. `/api/me` returned `authenticated: true`, `unavailable: false`, `teams: ["Organization Owners"]`, capabilities `collaborate`, `review`, `maintain`, `release`, and `admin`, with `isAdmin: true` and `reviewerEnabled: true`. `/api/admin/collaborators` returned the expected collaborator data with consistent identity and no suspension. This confirms the Owner's organization-based administrative access on `rustkore.dev` after deployment.

## MCP work-cycle validation

The existing production MCP credential returned HTTP 200 for `tools/list` and the read-only `get_progress` call on both `rustkore.dev` and the legacy host. No production task was claimed, heartbeated, submitted, or released: those calls would change real task state or add contribution history.

The full mutation sequence was exercised locally through the canonical `/mcp` request URL with an isolated Vitest D1 database, a test-only credential, and mocked GitHub PR verification. One synthetic local task exercised claim → heartbeat → release; a second exercised claim → heartbeat → submission. The submitted row existed only in the isolated test database. Release and submission are alternative terminal paths for a task, so the test does not try to release a task after it has been submitted. The production MCP token and D1 were not changed by this validation.

## Rollback

Rollback is a code/configuration deployment, not a database restore:

1. Keep both domain bindings and both OAuth callback entries in place.
2. Set `GITHUB_OAUTH_CALLBACK_URL` in `wrangler.jsonc` and the active Worker configuration back to `https://rustkore.boscv.workers.dev/auth/callback`, then deploy the previous known-good Worker version or the reverted code.
3. If reverting code through Git, retain `routes: [{ "pattern": "rustkore.dev", "custom_domain": true }]`, `workers_dev: true`, and `preview_urls: false` so rollback does not detach the canonical domain, disable the legacy host, or reopen public Version URLs.
4. Verify `/health` on both hostnames and start one OAuth login on the legacy hostname. Keep both callback URLs registered until the migration is intentionally retired.

Do not restore or rewrite D1. This migration does not change D1 rows, sessions, token hashes/scopes, task leases, submissions, or contribution history.
