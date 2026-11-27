# RustKore-DEV

**Open Collaborative Development**

A lightweight collaboration platform for coordinating distributed development of RustKore. It supports an open-source community project and is licensed under AGPL-3.0-only.

This repository contains the RustKore collaboration platform: a Cloudflare Worker, D1 schema and migrations, a public dashboard, GitHub OAuth, administrative tools, and a stateless MCP Streamable HTTP server. It is separate from the Rust software repository, [RustKore/RustKore](https://github.com/RustKore/RustKore). The public dashboard and MCP service run at [rustkore.boscv.workers.dev](https://rustkore.boscv.workers.dev/).

The software project is an independent community-driven reimplementation of OpenKore in Rust. The platform coordinates contributions; it is not the software itself and is not affiliated with or an official successor to the original OpenKore project.

## Capabilities

- Public project dashboard with live task states, module progress, integration history, contributor recognition, and active reservations.
- GitHub OAuth identities for collaborators, maintainers, and reviewers.
- Individually revocable MCP bearer credentials. Only token hashes are stored in D1; a newly issued token is displayed once.
- MCP Streamable HTTP at `/mcp`, stateless across requests, with task discovery, atomic claims, lease heartbeats, submission, independent review, progress, activity, and project context.
- Task management with priorities, acceptance criteria, dependencies, and optional complexity. D1 constraints prevent cycles and duplicate commit or pull request submissions.
- Separate submission, review, approval, and verified GitHub merge integration. Only verified integrations count as completed work.
- Cursor pagination, indexed queries, a short in-memory cache for shared context, and request limiting.

## Architecture

```text
Browser ── HTTPS ── Cloudflare Worker ── D1
                         │                 ├─ tasks, dependencies and leases
MCP client ─ Streamable HTTP ──────────────├─ identities and hashed credentials
                         │                 ├─ submissions, reviews and integrations
                         └── GitHub API ───└─ concise activity and shared context
```

The Worker is stateless between requests. D1 is the source of truth for task and lease transitions; conditional/batched writes protect claims, submissions, reviews, and integrations. Source code and patches stay in GitHub repositories, not D1. GitHub is used for OAuth identity and read-only verification of commits, pull requests, and merges. A valid platform credential does not grant GitHub repository permissions.

The task lifecycle is `Available → In progress → In review → Approved → Integrated`, with a distinct `Blocked` state when dependencies are incomplete. Rejected submissions return work to the queue; expired leases can be claimed again. A reservation is not evidence that an agent is currently executing code.

## Use the platform

Open the [RustKore dashboard](https://rustkore.boscv.workers.dev/), sign in with GitHub, and create an MCP credential from Account. Store the credential in a local secret manager or protected environment variable such as `RUSTKORE_TOKEN`. Never commit it. Revoke credentials from the same account page when they are no longer needed.

- **Rust software and contribution target:** [RustKore/RustKore](https://github.com/RustKore/RustKore)
- **Platform source:** [RustKore/RustKore-Dev](https://github.com/RustKore/RustKore-Dev)
- **Dashboard and MCP endpoint:** `https://rustkore.boscv.workers.dev/` and `https://rustkore.boscv.workers.dev/mcp`

MCP uses Bearer authentication over HTTPS. Connect any MCP-compatible client that supports Streamable HTTP; client configuration formats vary. Available tools include `list_tasks`, `claim_task`, `get_task`, `heartbeat`, `release_task`, `submit_task`, `review_task`, `get_progress`, `get_activity`, and `get_project_context`. When no task is available, follow the returned retry delay and backoff information. The default heartbeat interval is 120 seconds. Contributions are implemented and submitted against `RustKore/RustKore`; they require independent review and are counted only after verified integration.

### Codex CLI

Store the credential in the shell environment or an operating-system secret manager, then register the Streamable HTTP endpoint:

```sh
codex mcp add rustkore --url https://rustkore.boscv.workers.dev/mcp \
  --bearer-token-env-var RUSTKORE_TOKEN
```

For local development, use `http://localhost:8787/mcp`.

### Claude Code

Add the server at user scope so the token stays out of shared project files:

```sh
claude mcp add-json rustkore \
  '{"type":"http","url":"https://rustkore.boscv.workers.dev/mcp","headers":{"Authorization":"Bearer ${RUSTKORE_TOKEN}"}}' \
  --scope user
```

Client setup formats vary. Keep the token in a protected environment or secret manager and never commit it.

## Local development

Requirements: Node.js supported by Wrangler and npm.

```sh
npm ci
cp .dev.vars.example .dev.vars
# Fill local-only OAuth and GitHub API settings in .dev.vars.
npx wrangler d1 migrations apply rustkore-db --local
npm run demo:local  # optional, synthetic local dashboard data
npm run dev
```

The local dashboard is available at `http://localhost:8787/`, with MCP at `http://localhost:8787/mcp`. Configure a GitHub OAuth callback for local development if you need to test sign-in. `.dev.vars`, `.env` files, `.wrangler`, and dependencies are ignored by Git. Keep credentials in local secret files or Worker secrets; do not place them in source, logs, D1, or test fixtures.

The local database is separate from production. Use `npm run demo:local` to add clearly synthetic dashboard data for interface review. This command targets local D1 only. Demo identities and contributions are not real project activity.

## Configuration and administration

The Worker configuration in `wrangler.jsonc` defines the D1 binding `rustkore_db`, routing, public non-secret variables, and rate limiting. Set these variables per environment:

- `GITHUB_REPOSITORY=RustKore/RustKore` and `GITHUB_REPOSITORY_ID=1472554035` — both the name and immutable GitHub ID of the **software** repository whose PRs are verified. The Worker rejects submissions and integrations if either value is missing or mismatched.
- `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CALLBACK_URL`.
- Optional `HEARTBEAT_INTERVAL_SECONDS`, and `LEASE_DURATION_SECONDS`.

Configure `GITHUB_OAUTH_CLIENT_SECRET` and `GITHUB_API_TOKEN` as Cloudflare Worker secrets (or local `.dev.vars` values). The GitHub API token should be a fine-grained, read-only credential with Members read access for `RustKore` and Contents, Pull requests, and Metadata read access for `RustKore/RustKore`. Do not add write or administration permissions. The OAuth application continues to request only `read:user` and uses the existing callback URL. Organization permissions come from the platform API token; user OAuth scopes are unchanged. Never store secret values in `wrangler.jsonc` or version control.

Current GitHub Organization Owners receive full administrative access. The Maintainers team manages tasks, independent reviews, integrations, and functional roadmap validation. Release Managers validate release acceptance criteria. Developers and external GitHub users retain normal collaboration. Team membership must be active; pending memberships do not grant privileges. The former administrator and reviewer allowlists have been removed from active configuration and are not read by this Worker; there is no legacy authorization fallback. Functional coverage and release readiness remain separate; integrated milestone criteria require public evidence, maintainer identity, verification date, and a recorded reason. A milestone is complete only when both mandatory functional requirements and cumulative integrated acceptance criteria are verified. Authorization is enforced by the Worker using cached GitHub organization membership (maximum 60 seconds); critical writes recheck current membership. Credentials keep the scope they were issued with, and every privileged operation also requires the corresponding current organization capability. Suspended collaborators remain blocked. OAuth continues to request only `read:user`. Reviewers cannot review their own submissions. Approval does not itself merge code; a maintainer records integration only after the Worker verifies the merged PR against GitHub.

## Data and Cloudflare limits

D1 stores coordination metadata and concise activity, never source code, patches, agent logs, or credentials in plain text. Queries are indexed and paginated (maximum 100 rows per task page). Dashboard responses are briefly cached in the Worker isolate; cache loss only causes a fresh read. The rate limiter reduces abusive request bursts but is not a globally exact quota counter.

On Workers Free, the current published daily/request and D1 read/write allowances are finite; operation volume, especially frequent heartbeats, can exhaust them. Heartbeat defaults to 120 seconds to reduce writes. When D1 rejects writes because a quota or storage error occurred, the API returns an error and the conditional batches keep task transitions atomic. Clients should respect retry responses and never assume a failed reservation, submission, or review succeeded. The implementation remains compatible with Workers Paid without requiring an architectural change.

Use Cloudflare Workers Observability for request status, duration, and CPU. Use D1 database metrics for rows read and written. Application-level metrics are intentionally not written to D1, avoiding extra quota consumption.

## Migrations and validation

Migrations are ordered SQL files under `migrations/`. For local work, apply them only to local D1. Do not run remote migrations or deploy as a test step.

```sh
npx wrangler d1 migrations apply rustkore-db --local
npm test
npx tsc --noEmit
```

The tests exercise authorization, concurrent claims, lease expiry and recovery, duplicate submissions, independent reviews, pagination, and local load scenarios with 10, 50, 100, and 500 simulated agents. Load runs use local D1 and are integrity simulations, not a promise that those populations fit within Free quotas continuously.

## License

The RustKore-DEV platform is licensed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). See [LICENSE](LICENSE) for the complete license text. This license applies to the platform repository only; the RustKore software repository has a separate licensing decision.
