type Role = "admin" | "collaborator" | "reviewer";
type Env = { rustkore_db: D1Database; ASSETS?: { fetch(request: Request): Promise<Response> }; API_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }; GITHUB_REPOSITORY?: string; GITHUB_REPOSITORY_ID?: string; GITHUB_API_TOKEN?: string; GITHUB_OAUTH_CLIENT_ID?: string; GITHUB_OAUTH_CLIENT_SECRET?: string; GITHUB_OAUTH_CALLBACK_URL?: string; RUSTKORE_ADMIN_GITHUB_IDS?: string; RUSTKORE_REVIEWER_GITHUB_IDS?: string; github_api?: { fetch(request: Request): Promise<Response> }; HEARTBEAT_INTERVAL_SECONDS?: string; LEASE_DURATION_SECONDS?: string };
type Identity = { id: string; role: Role; collaboratorId: string; agentId: string | null; name: string; githubUserId: number | null; githubLogin: string | null };
type WebIdentity = { collaboratorId: string; githubUserId: number; githubLogin: string; name: string; avatarUrl: string | null; reviewerEnabled: boolean; isAdmin: boolean };

const DEFAULT_HEARTBEAT_SECONDS = 120;
const DEFAULT_LEASE_SECONDS = 600;
const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MODERN_PROTOCOL = "2026-07-28";
const rateWindows = new Map<string, { start: number; count: number }>();
let cachedContext: { content: string; updatedAt: number; expires: number } | null = null;
let cachedDashboard: { content: any; expires: number } | null = null;
let cachedRoadmap: { content: any; expires: number } | null = null;

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...Object.fromEntries(new Headers(extraHeaders).entries()) } });
const id = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
const text = (v: unknown, name: string, max = 10_000): string => {
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} must be a non-empty string (max ${max} characters)`);
	return v.trim();
};
const optText = (v: unknown, max = 2000): string | null => v == null || v === "" ? null : text(v, "value", max);
const authHeader = (r: Request) => r.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
const taskCanBeClaimedSql = (alias: string) => `(${alias}.status='open' OR (${alias}.status='claimed' AND ${alias}.lease_until<=unixepoch()))`;
const taskDependenciesSatisfiedSql = (alias: string) => `NOT EXISTS (
	SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on_id
	WHERE d.task_id=${alias}.id AND parent.status!='accepted'
)`;
const taskClaimEligibleSql = (alias: string) => `(${taskCanBeClaimedSql(alias)} AND ${taskDependenciesSatisfiedSql(alias)})`;
const taskDashboardStateSql = (alias: string) => `CASE
	WHEN EXISTS (SELECT 1 FROM integrations i WHERE i.task_id=${alias}.id) THEN 'integrated'
	WHEN ${alias}.status='accepted' THEN 'approved'
	WHEN ${alias}.status='submitted' THEN 'in_review'
	WHEN ${alias}.status='claimed' AND ${alias}.lease_until>unixepoch() THEN 'reserved'
	WHEN ${taskClaimEligibleSql(alias)} THEN 'available'
	ELSE 'blocked'
END`;
const invalidateDashboard = () => { cachedDashboard = null; };

async function sha256(value: string) {
	const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function authenticate(request: Request, env: Env): Promise<Identity | null> {
	const token = authHeader(request);
	if (!token) return null;
	const hash = await sha256(token);
	const identity = await env.rustkore_db.prepare(`SELECT t.id, t.role, t.collaborator_id AS collaboratorId, t.agent_id AS agentId,
		COALESCE(a.name, c.name) AS name,c.github_user_id AS githubUserId,c.github_login AS githubLogin,c.reviewer_enabled AS reviewerEnabled FROM tokens t JOIN collaborators c ON c.id=t.collaborator_id
		LEFT JOIN agents a ON a.id=t.agent_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND c.suspended_at IS NULL`)
		.bind(hash).first<Identity & { reviewerEnabled: number }>();
	if (!identity) return null;
	const githubUserId = Number(identity.githubUserId);
	if (identity.role === "admin" && !githubAllowlist(env.RUSTKORE_ADMIN_GITHUB_IDS).has(githubUserId)) return null;
	if (identity.role === "reviewer" && !Boolean(identity.reviewerEnabled) && !githubAllowlist(env.RUSTKORE_REVIEWER_GITHUB_IDS).has(githubUserId)) return null;
	return identity;
}

async function issueAgentCredential(db: D1Database, collaboratorId: string, name: string, role: Role) {
	const agentId = role === "collaborator" ? id() : null, tokenId = id();
	const token = `rk_${randomSecret(48)}`;
	const statements: D1PreparedStatement[] = [];
	if (agentId) statements.push(db.prepare("INSERT INTO agents (id,collaborator_id,name,created_at) VALUES (?,?,?,unixepoch())").bind(agentId, collaboratorId, name));
	statements.push(db.prepare("INSERT INTO tokens (id,token_hash,role,collaborator_id,agent_id,created_at) VALUES (?,?,?,?,?,unixepoch())")
		.bind(tokenId, await sha256(token), role, collaboratorId, agentId));
	await db.batch(statements);
	return { token, tokenId, role, agentId, name };
}

function base64url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomSecret(bytes = 32) {
	const value = new Uint8Array(bytes);
	crypto.getRandomValues(value);
	return base64url(value);
}

function parseCookies(request: Request) {
	return Object.fromEntries((request.headers.get("cookie") ?? "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
		const index = part.indexOf("=");
		return index < 0 ? [part, ""] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
	}));
}

function cookie(name: string, value: string, request: Request, maxAge: number, path = "/") {
	return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}

function githubAllowlist(value: string | undefined) {
	return new Set((value ?? "").split(",").map((item) => Number(item.trim())).filter((item) => Number.isSafeInteger(item) && item > 0));
}

async function githubFetch(request: Request, env: Env) {
	try { return env.github_api ? await env.github_api.fetch(request) : await fetch(request); }
	catch { throw new Error("GitHub authentication or validation is temporarily unavailable"); }
}

async function getWebIdentity(request: Request, db: D1Database, env: Env): Promise<WebIdentity | null> {
	const session = parseCookies(request).rk_session;
	if (!session) return null;
	const row = await db.prepare(`SELECT s.csrf_hash AS csrfHash,c.id AS collaboratorId,c.github_user_id AS githubUserId,
		c.github_login AS githubLogin,c.name,c.avatar_url AS avatarUrl,c.reviewer_enabled AS reviewerEnabled
		FROM web_sessions s JOIN collaborators c ON c.id=s.collaborator_id
		WHERE s.session_hash=? AND s.expires_at>unixepoch() AND c.suspended_at IS NULL`)
		.bind(await sha256(session)).first<any>();
	if (!row || !row.githubUserId) return null;
	const githubUserId = Number(row.githubUserId);
	return { ...row, csrfHash: row.csrfHash, githubUserId, reviewerEnabled: Boolean(row.reviewerEnabled) || githubAllowlist(env.RUSTKORE_REVIEWER_GITHUB_IDS).has(githubUserId), isAdmin: githubAllowlist(env.RUSTKORE_ADMIN_GITHUB_IDS).has(githubUserId) } as WebIdentity & { csrfHash: string };
}

async function requireWebWrite(request: Request, identity: WebIdentity, db: D1Database) {
	if (request.headers.get("origin") !== new URL(request.url).origin) throw new Error("Forbidden: same-origin requests are required");
	const cookies = parseCookies(request), csrf = request.headers.get("x-csrf-token");
	if (!csrf || csrf !== cookies.rk_csrf || (await sha256(csrf)) !== (identity as WebIdentity & { csrfHash: string }).csrfHash) throw new Error("Forbidden: CSRF validation failed");
}

async function startGitHubLogin(request: Request, env: Env) {
	if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CALLBACK_URL) return json({ error: "GitHub OAuth is not configured" }, 503);
	if (await anonymousRateLimited(request, env, "oauth")) return json({ error: "Rate limit exceeded" }, 429);
	const callback = new URL(env.GITHUB_OAUTH_CALLBACK_URL);
	if (callback.protocol !== "https:" && callback.hostname !== "localhost" && callback.hostname !== "127.0.0.1") return json({ error: "OAuth callback must use HTTPS" }, 500);
	const state = randomSecret(), verifier = randomSecret(48), challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	await env.rustkore_db.batch([
		env.rustkore_db.prepare("DELETE FROM oauth_states WHERE expires_at<=unixepoch()"),
		env.rustkore_db.prepare("INSERT INTO oauth_states (state_hash,code_verifier,expires_at,created_at) VALUES (?,?,unixepoch()+600,unixepoch())").bind(await sha256(state), verifier),
	]);
	const authorize = new URL("https://github.com/login/oauth/authorize");
	authorize.searchParams.set("client_id", env.GITHUB_OAUTH_CLIENT_ID);
	authorize.searchParams.set("redirect_uri", callback.toString());
	authorize.searchParams.set("scope", "read:user");
	authorize.searchParams.set("state", state);
	authorize.searchParams.set("code_challenge", challenge);
	authorize.searchParams.set("code_challenge_method", "S256");
	return new Response(null, { status: 302, headers: { location: authorize.toString(), "cache-control": "no-store", "set-cookie": cookie("rk_oauth_state", state, request, 600, "/auth/callback") } });
}

async function completeGitHubLogin(request: Request, env: Env) {
	if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET || !env.GITHUB_OAUTH_CALLBACK_URL) return json({ error: "GitHub OAuth is not configured" }, 503);
	if (await anonymousRateLimited(request, env, "oauth-callback")) return json({ error: "Rate limit exceeded" }, 429);
	const url = new URL(request.url), cookies = parseCookies(request), state = url.searchParams.get("state"), code = url.searchParams.get("code");
	if (url.searchParams.has("error") || !state || !code || !cookies.rk_oauth_state || state !== cookies.rk_oauth_state) return json({ error: "GitHub authorization was denied or its state is invalid" }, 400);
	const stateRow = await env.rustkore_db.prepare("SELECT code_verifier AS codeVerifier FROM oauth_states WHERE state_hash=? AND expires_at>unixepoch()")
		.bind(await sha256(state)).first<{ codeVerifier: string }>();
	if (!stateRow) return json({ error: "GitHub authorization expired; start again" }, 400);
	const tokenRequest = new URLSearchParams({ client_id: env.GITHUB_OAUTH_CLIENT_ID, client_secret: env.GITHUB_OAUTH_CLIENT_SECRET, code, redirect_uri: env.GITHUB_OAUTH_CALLBACK_URL, code_verifier: stateRow.codeVerifier });
	const tokenResponse = await githubFetch(new Request("https://github.com/login/oauth/access_token", { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: tokenRequest }), env);
	if (!tokenResponse.ok) return json({ error: "GitHub authorization could not be completed" }, 502);
	const token = await tokenResponse.json<any>();
	if (typeof token.access_token !== "string") return json({ error: "GitHub did not return an access token" }, 502);
	const userResponse = await githubFetch(new Request("https://api.github.com/user", { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json", "user-agent": "RustKore/0.1" } }), env);
	if (!userResponse.ok) return json({ error: "GitHub identity could not be verified" }, 502);
	const user = await userResponse.json<any>();
	if (!Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.login !== "string") return json({ error: "GitHub returned an invalid identity" }, 502);
	const suspended = await env.rustkore_db.prepare("SELECT suspended_at FROM collaborators WHERE github_user_id=?").bind(user.id).first<any>();
	if (suspended?.suspended_at) return json({ error: "This collaborator account is suspended" }, 403);
	const collaboratorId = id(), sessionToken = `rks_${randomSecret(32)}`, csrfToken = randomSecret(24), expiresIn = 60 * 60 * 24 * 7;
	const results = await env.rustkore_db.batch([
		env.rustkore_db.prepare("DELETE FROM oauth_states WHERE state_hash=? AND expires_at>unixepoch()").bind(await sha256(state)),
		env.rustkore_db.prepare(`INSERT INTO collaborators (id,name,created_at,github_user_id,github_login,avatar_url)
			SELECT ?,?,?,?, ?,? WHERE changes()=1
			ON CONFLICT(github_user_id) WHERE github_user_id IS NOT NULL DO UPDATE SET name=excluded.name,github_login=excluded.github_login,avatar_url=excluded.avatar_url`)
			.bind(collaboratorId, text(user.name || user.login, "GitHub name", 120), now(), user.id, text(user.login, "GitHub login", 80), optText(user.avatar_url, 500)),
		env.rustkore_db.prepare(`INSERT INTO web_sessions (session_hash,csrf_hash,collaborator_id,expires_at,created_at)
			SELECT ?,?,id,unixepoch()+?,unixepoch() FROM collaborators WHERE github_user_id=? AND suspended_at IS NULL AND changes()=1`)
			.bind(await sha256(sessionToken), await sha256(csrfToken), expiresIn, user.id),
	]);
	if ((results[2].meta.changes ?? 0) !== 1) return json({ error: "GitHub login state was already used; start again" }, 400);
	const headers = new Headers({ location: "/", "cache-control": "no-store" });
	headers.append("set-cookie", cookie("rk_session", sessionToken, request, expiresIn));
	headers.append("set-cookie", cookie("rk_csrf", csrfToken, request, expiresIn));
	headers.append("set-cookie", cookie("rk_oauth_state", "", request, 0, "/auth/callback"));
	return new Response(null, { status: 303, headers });
}

function setting(value: string | undefined, fallback: number, minimum: number, maximum: number) {
	const parsed = Number(value);
	return Number.isInteger(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

async function rateLimited(identity: Identity, method: string, env: Env) {
	if (env.API_RATE_LIMITER && !(await env.API_RATE_LIMITER.limit({ key: identity.id })).success) return true;
	const mutating = new Set(["claim_task", "heartbeat", "release_task", "submit_task", "review_task"]);
	const key = `${identity.id}:${method}`, ts = now(), max = mutating.has(method) ? 30 : 120;
	let state = rateWindows.get(key);
	if (!state || ts - state.start >= 60) { state = { start: ts, count: 0 }; rateWindows.set(key, state); }
	state.count++;
	if (rateWindows.size > 10_000) for (const [k, v] of rateWindows) if (ts - v.start >= 120) rateWindows.delete(k);
	return state.count > max;
}

async function anonymousRateLimited(request: Request, env: Env, bucket: string) {
	const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
	return Boolean(env.API_RATE_LIMITER && !(await env.API_RATE_LIMITER.limit({ key: `${bucket}:${ip}` })).success);
}

function configuredGitHubRepository(env: Env) {
	const repository = env.GITHUB_REPOSITORY, repositoryId = env.GITHUB_REPOSITORY_ID;
	if (!repository || !repositoryId) throw new Error("GitHub repository identity is not configured (GITHUB_REPOSITORY and GITHUB_REPOSITORY_ID are required)");
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository is misconfigured");
	if (!/^\d+$/.test(repositoryId)) throw new Error("GitHub repository ID is misconfigured; expected a numeric repository ID");
	if (repository.toLowerCase() !== "boscv/rustkore" || repositoryId !== "1472554035") throw new Error("GitHub repository identity is misconfigured; expected boscv/RustKore (1472554035)");
	return { repository, repositoryId };
}

function assertPullRequestRepository(pull: any, identity: { repository: string; repositoryId: string }, commitSha: string) {
	if (String(pull.base?.repo?.id ?? "") !== identity.repositoryId || String(pull.base?.repo?.full_name ?? "").toLowerCase() !== identity.repository.toLowerCase()) throw new Error("Pull request base repository identity does not match the configured software repository");
	if (String(pull.head?.sha ?? "").toLowerCase() !== commitSha.toLowerCase()) throw new Error("Pull request head SHA does not match the submitted commit SHA");
}

async function githubRepositoryPath(path: string, env: Env) {
	const { repository } = configuredGitHubRepository(env);
	const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "RustKore/0.1", "x-github-api-version": "2022-11-28" });
	if (env.GITHUB_API_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_API_TOKEN}`);
	const request = new Request(`https://api.github.com/repos/${repository}${path}`, { headers, signal: AbortSignal.timeout(5000) });
	const response = await githubFetch(request, env);
	if (!response.ok) throw new Error(response.status === 404 ? "Commit or pull request does not exist in the configured repository" : "GitHub validation is unavailable; submission was not saved");
	return response.json<any>();
}

async function verifyGitHubSubmission(commitSha: string, pullRequestUrl: string | null, githubUserId: number | null, env: Env) {
	const identity = configuredGitHubRepository(env), repository = identity.repository;
	if (!githubUserId) throw new Error("Link this MCP credential to a GitHub account before submitting work");
	if (!pullRequestUrl) throw new Error("A pull request in the configured repository is required");
	const commit = await githubRepositoryPath(`/commits/${commitSha}`, env);
	if (String(commit.sha).toLowerCase() !== commitSha.toLowerCase()) throw new Error("GitHub commit SHA does not match the submitted commit");
	let parsed: URL;
	try { parsed = new URL(pullRequestUrl); } catch { throw new Error("pullRequestUrl must be a GitHub pull request URL"); }
	const match = parsed.hostname === "github.com" && parsed.protocol === "https:" && parsed.pathname.match(new RegExp(`^/${repository.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/pull/(\\d+)/?$`, "i"));
	if (!match || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("pullRequestUrl must point to a pull request in the configured repository");
	const pull = await githubRepositoryPath(`/pulls/${match[1]}`, env);
	assertPullRequestRepository(pull, identity, commitSha);
	if (Number(pull.user?.id) !== githubUserId) throw new Error("The pull request must be opened by the GitHub account linked to this MCP credential");
	if (Number(commit.author?.id) !== githubUserId) throw new Error("The submitted commit must be authored by the GitHub account linked to this MCP credential");
	return { pullRequestUrl: `https://github.com/${repository}/pull/${Number(match[1])}`, commitAuthorId: Number(commit.author.id) };
}

async function createTask(db: D1Database, input: any, actor: Identity | string) {
	const taskId = id();
	const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(100, input.priority)) : 50;
	const module = input.module == null ? "General" : text(input.module, "module", 100);
	const complexity = input.complexity == null || input.complexity === "" ? null : text(input.complexity, "complexity", 20);
	if (complexity !== null && !["small", "medium", "large", "extra_large"].includes(complexity)) throw new Error("complexity must be small, medium, large, or extra_large");
	const dependencies: string[] = Array.isArray(input.dependencies) ? input.dependencies.map((x: unknown) => text(x, "dependency id", 80)) : [];
	if (dependencies.length > 100) throw new Error("A task can have at most 100 dependencies");
	const stmts = [db.prepare(`INSERT INTO tasks (id, title, description, acceptance_criteria, priority, status, created_by, created_at, updated_at, module, complexity)
		VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)`)
		.bind(taskId, text(input.title, "title", 200), text(input.description, "description", 4000), text(input.acceptanceCriteria, "acceptanceCriteria", 4000), priority, typeof actor === "string" ? actor : actor.collaboratorId, now(), now(), module, complexity)];
	for (const dep of dependencies) stmts.push(db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)").bind(taskId, dep));
	stmts.push(db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
		SELECT ?,id,?,'task.created',?,? FROM tasks WHERE id=?`).bind(id(), typeof actor === "string" ? actor : actor.collaboratorId, JSON.stringify({ title: text(input.title, "title", 200), priority, dependencies }), now(), taskId));
	await db.batch(stmts);
	invalidateDashboard();
	return { id: taskId, title: text(input.title, "title", 200), module, description: text(input.description, "description", 4000), acceptance_criteria: text(input.acceptanceCriteria, "acceptanceCriteria", 4000), priority, complexity, status: "open", dependencies, submissions: [] };
}

async function getTask(db: D1Database, taskId: string) {
	const task = await db.prepare(`SELECT t.*, CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END AS effective_status,
		${taskDashboardStateSql("t")} AS state,
		c.name AS assignee_name FROM tasks t LEFT JOIN agents a ON a.id=t.assignee_agent_id LEFT JOIN collaborators c ON c.id=a.collaborator_id WHERE t.id=?`).bind(now(), taskId).first<any>();
	if (!task) throw new Error("Task not found");
	const dependencies = await db.prepare("SELECT depends_on_id FROM task_dependencies WHERE task_id=?").bind(taskId).all<{ depends_on_id: string }>();
	const submissionRows = await db.prepare(`SELECT s.id,s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,s.summary,s.created_at AS createdAt,s.status,
		r.decision AS reviewDecision,r.comment AS reviewComment,r.created_at AS reviewedAt FROM submissions s
		LEFT JOIN reviews r ON r.submission_id=s.id WHERE s.task_id=? ORDER BY s.created_at DESC LIMIT 51`).bind(taskId).all();
	const reclaimed = task.status === "claimed" && task.effective_status === "open";
		return { ...task, status: task.effective_status, assignee_agent_id: reclaimed ? null : task.assignee_agent_id, assignee_name: reclaimed ? null : task.assignee_name,
		lease_id: reclaimed ? null : task.lease_id, lease_until: reclaimed ? null : task.lease_until,
		dependencies: dependencies.results.map((r) => r.depends_on_id), submissions: submissionRows.results.slice(0, 50), submissionHistoryTruncated: submissionRows.results.length > 50 };
}

function requireRole(identity: Identity, ...roles: Role[]) {
	if (!roles.includes(identity.role)) throw new Error("Forbidden: this operation is not allowed for your role");
}
function requireAgent(identity: Identity) {
	if (!identity.agentId) throw new Error("This token is not bound to an agent");
}
function obj(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}; }

async function callTool(name: string, args: Record<string, any>, identity: Identity, db: D1Database, env: Env) {
	switch (name) {
		case "list_tasks": {
			requireRole(identity, "admin", "collaborator", "reviewer");
			const status = optText(args.status, 32);
			const limit = Math.max(1, Math.min(100, Number.isInteger(args.limit) ? args.limit : 50));
			let cursor: any = null;
			if (args.cursor) {
				try { cursor = JSON.parse(atob(String(args.cursor))); } catch { throw new Error("cursor is invalid"); }
				if (!Number.isInteger(cursor.priority) || !Number.isInteger(cursor.createdAt) || typeof cursor.id !== "string") throw new Error("cursor is invalid");
			}
			const rows = await db.prepare(`SELECT t.id,t.title,t.module,t.description,t.acceptance_criteria AS acceptanceCriteria,t.priority,
				CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END AS status,
				${taskDashboardStateSql("t")} AS state,
				CASE WHEN t.status='claimed' AND t.lease_until<=? THEN NULL ELSE t.assignee_agent_id END AS assigneeAgentId,
				CASE WHEN t.status='claimed' AND t.lease_until<=? THEN NULL ELSE t.lease_until END AS leaseUntil,t.created_at AS createdAt
				FROM tasks t WHERE (? IS NULL OR (CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END)=?)
				AND (? IS NULL OR t.priority<? OR (t.priority=? AND (t.created_at>? OR (t.created_at=? AND t.id>?))))
				ORDER BY t.priority DESC,t.created_at ASC,t.id ASC LIMIT ?`).bind(now(), now(), now(), status, now(), status,
				cursor ? 1 : null, cursor?.priority ?? 0, cursor?.priority ?? 0, cursor?.createdAt ?? 0, cursor?.createdAt ?? 0, cursor?.id ?? "", limit + 1).all<any>();
			const hasMore = rows.results.length > limit, page = rows.results.slice(0, limit), last = page.at(-1);
			return { tasks: page, nextCursor: hasMore && last ? btoa(JSON.stringify({ priority: last.priority, createdAt: last.createdAt, id: last.id })) : null };
		}
		case "claim_task": {
			requireRole(identity, "collaborator"); requireAgent(identity);
			const leaseId = id(), heartbeatIntervalSeconds = setting(env.HEARTBEAT_INTERVAL_SECONDS, DEFAULT_HEARTBEAT_SECONDS, 30, 600), leaseDurationSeconds = setting(env.LEASE_DURATION_SECONDS, Math.max(DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds + 30), heartbeatIntervalSeconds + 30, 3600);
			const claimed = await db.batch([
				db.prepare(`UPDATE tasks SET status='claimed', assignee_agent_id=?, lease_id=?, lease_until=unixepoch()+?, updated_at=unixepoch()
				WHERE id=(SELECT t.id FROM tasks t WHERE ${taskClaimEligibleSql("t")}
				ORDER BY t.priority DESC,t.created_at ASC LIMIT 1)
				AND (status='open' OR (status='claimed' AND lease_until<=unixepoch())) RETURNING id,title,description,acceptance_criteria AS acceptanceCriteria,priority,lease_id AS leaseId,lease_until AS leaseUntil`)
					.bind(identity.agentId, leaseId, leaseDurationSeconds),
				db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
					SELECT ?,id,?,'task.claimed',?,unixepoch() FROM tasks WHERE lease_id=? AND status='claimed'`).bind(id(), identity.collaboratorId, JSON.stringify({ agentId: identity.agentId }), leaseId),
			]);
			const row = claimed[0].results?.[0] as any;
			if (!row) {
				const attempt = Math.max(0, Math.min(10, Number.isInteger(args.backoffAttempt) ? args.backoffAttempt : 0));
				const base = Math.min(60, 2 ** attempt), jitter = Math.floor(Math.random() * Math.max(1, Math.ceil(base * 0.25)));
				return { task: null, message: "No eligible task is currently available", retryAfterSeconds: Math.min(60, base + jitter), nextBackoffAttempt: Math.min(10, attempt + 1) };
			}
			invalidateDashboard();
			return { task: { ...row, heartbeatIntervalSeconds } };
		}
		case "get_task": requireRole(identity, "admin", "collaborator", "reviewer"); return getTask(db, text(args.taskId, "taskId", 80));
		case "heartbeat": {
			requireRole(identity, "collaborator"); requireAgent(identity);
			const heartbeatIntervalSeconds = setting(env.HEARTBEAT_INTERVAL_SECONDS, DEFAULT_HEARTBEAT_SECONDS, 30, 600);
			const ts = now(), until = ts + setting(env.LEASE_DURATION_SECONDS, Math.max(DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds + 30), heartbeatIntervalSeconds + 30, 3600), taskId = text(args.taskId, "taskId", 80), leaseId = text(args.leaseId, "leaseId", 80);
			const duration = setting(env.LEASE_DURATION_SECONDS, Math.max(DEFAULT_LEASE_SECONDS, heartbeatIntervalSeconds + 30), heartbeatIntervalSeconds + 30, 3600);
			const row = await db.prepare("UPDATE tasks SET lease_until=unixepoch()+?,updated_at=unixepoch() WHERE id=? AND status='claimed' AND assignee_agent_id=? AND lease_id=? AND lease_until>unixepoch() RETURNING id,lease_until AS leaseUntil")
				.bind(duration, taskId, identity.agentId, leaseId).first();
			if (row) { invalidateDashboard(); return row; }
			const current = await db.prepare("SELECT id,lease_until AS leaseUntil FROM tasks WHERE id=? AND status='claimed' AND assignee_agent_id=? AND lease_id=? AND lease_until>unixepoch() AND lease_until>=unixepoch()+?")
				.bind(taskId, identity.agentId, leaseId, duration).first();
			if (!current) throw new Error("Lease is missing, expired, or belongs to another agent");
			return current;
		}
		case "release_task": {
			requireRole(identity, "collaborator"); requireAgent(identity);
			const ts = now();
			const taskId = text(args.taskId, "taskId", 80), leaseId = text(args.leaseId, "leaseId", 80), releaseMarker = `released:${id()}`;
			const released = await db.batch([
				db.prepare("UPDATE tasks SET status='open',assignee_agent_id=NULL,lease_id=?,lease_until=NULL,updated_at=unixepoch() WHERE id=? AND status='claimed' AND assignee_agent_id=? AND lease_id=? AND lease_until>unixepoch() RETURNING id")
					.bind(releaseMarker, taskId, identity.agentId, leaseId),
				db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
					SELECT ?,id,?,'task.released','{}',? FROM tasks WHERE id=? AND status='open' AND lease_id=?`)
					.bind(id(), identity.collaboratorId, ts, taskId, releaseMarker),
				db.prepare("UPDATE tasks SET lease_id=NULL WHERE id=? AND status='open' AND lease_id=?").bind(taskId, releaseMarker),
			]);
			const row = released[0].results?.[0];
			if (!row) throw new Error("Lease is missing, expired, or belongs to another agent");
			invalidateDashboard();
			return { released: true };
		}
		case "submit_task": {
			requireRole(identity, "collaborator"); requireAgent(identity);
			const taskId = text(args.taskId, "taskId", 80), leaseId = text(args.leaseId, "leaseId", 80);
			const commitSha = text(args.commitSha, "commitSha", 40);
			if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error("commitSha must be a full 40-character Git commit SHA");
			const pullRequestUrl = optText(args.pullRequestUrl, 1000);
			const lease = await db.prepare("SELECT 1 FROM tasks WHERE id=? AND status='claimed' AND assignee_agent_id=? AND lease_id=? AND lease_until>unixepoch()")
				.bind(taskId, identity.agentId, leaseId).first();
			if (!lease) throw new Error("A current, unexpired lease is required to submit");
			const githubProof = await verifyGitHubSubmission(commitSha, pullRequestUrl, identity.githubUserId, env);
			const submissionId = id();
			const submitted = await db.prepare(`INSERT INTO submissions (id,task_id,agent_id,commit_sha,pull_request_url,summary,status,created_at,submitted_github_user_id,submitted_github_login)
				SELECT ?,t.id,?,?,?,?,'pending',unixepoch(),?,? FROM tasks t WHERE t.id=? AND t.status='claimed' AND t.assignee_agent_id=? AND t.lease_id=? AND t.lease_until>unixepoch() RETURNING id`)
				.bind(submissionId, identity.agentId, commitSha.toLowerCase(), githubProof.pullRequestUrl, text(args.summary, "summary", 2000), identity.githubUserId, identity.githubLogin, taskId, identity.agentId, leaseId).first();
			if (!submitted) throw new Error("A current, unexpired lease is required to submit");
			invalidateDashboard();
			return { submissionId, status: "pending" };
		}
		case "review_task": {
			requireRole(identity, "reviewer", "admin");
			const decision = args.decision;
			if (decision !== "accepted" && decision !== "rejected") throw new Error("decision must be accepted or rejected");
			const submissionId = text(args.submissionId, "submissionId", 80), ts = now();
			const submission = await db.prepare("SELECT s.id,s.task_id AS taskId,s.agent_id AS agentId,a.collaborator_id AS collaboratorId FROM submissions s JOIN agents a ON a.id=s.agent_id WHERE s.id=? AND s.status='pending'").bind(submissionId).first<any>();
			if (!submission) throw new Error("Pending submission not found");
			if (submission.collaboratorId === identity.collaboratorId) throw new Error("Independent review required: submitters cannot review their own work");
			const reviewId = id();
			await db.batch([
				db.prepare("INSERT INTO reviews (id,submission_id,reviewer_id,decision,comment,created_at) VALUES (?,?,?,?,?,?)")
					.bind(reviewId, submissionId, identity.collaboratorId, decision, optText(args.comment, 4000), ts),
				db.prepare("UPDATE submissions SET status=? WHERE id=? AND status='pending'").bind(decision, submissionId),
				db.prepare("UPDATE tasks SET status=?,assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='submitted'")
					.bind(decision === "accepted" ? "accepted" : "open", ts, submission.taskId),
				db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
					SELECT ?,s.task_id,?,?,?,? FROM reviews r JOIN submissions s ON s.id=r.submission_id WHERE r.id=?`).bind(id(), identity.collaboratorId, `submission.${decision}`, JSON.stringify({ submissionId, comment: args.comment ?? null }), ts, reviewId),
			]);
			invalidateDashboard();
			return { reviewId, decision };
		}
		case "get_progress": {
			requireRole(identity, "admin", "collaborator", "reviewer");
			const state = taskDashboardStateSql("t");
			const rows = await db.prepare(`SELECT CASE state WHEN 'available' THEN 'open' WHEN 'blocked' THEN 'open'
				WHEN 'reserved' THEN 'claimed' WHEN 'in_review' THEN 'submitted' WHEN 'approved' THEN 'accepted' ELSE state END AS status,
				state,COUNT(*) AS count FROM (SELECT ${state} AS state FROM tasks t) GROUP BY state`).all();
			const activity = await db.prepare("SELECT action,COUNT(*) AS count FROM (SELECT action FROM activity ORDER BY created_at DESC,id DESC LIMIT 500) GROUP BY action ORDER BY count DESC LIMIT 20").all();
			return { tasks: rows.results, recentActivitySummary: activity.results };
		}
		case "get_activity": {
			requireRole(identity, "admin", "collaborator", "reviewer");
			const taskId = optText(args.taskId, 80), limit = Math.max(1, Math.min(100, Number.isInteger(args.limit) ? args.limit : 50));
			let cursor: any = null;
			if (args.cursor) { try { cursor = JSON.parse(atob(String(args.cursor))); } catch { throw new Error("cursor is invalid"); } }
			if (cursor && (!Number.isInteger(cursor.createdAt) || typeof cursor.id !== "string")) throw new Error("cursor is invalid");
			const rows = await db.prepare(`SELECT a.id,a.task_id AS taskId,c.name AS actor,a.action,a.details_json AS details,a.created_at AS createdAt
				FROM activity a JOIN collaborators c ON c.id=a.actor_id WHERE (? IS NULL OR a.task_id=?)
				AND (? IS NULL OR a.created_at<? OR (a.created_at=? AND a.id<?))
				ORDER BY a.created_at DESC,a.id DESC LIMIT ?`).bind(taskId, taskId, cursor ? 1 : null, cursor?.createdAt ?? 0, cursor?.createdAt ?? 0, cursor?.id ?? "", limit + 1).all<any>();
			const hasMore = rows.results.length > limit, activities = rows.results.slice(0, limit).map((row) => ({ ...row, details: JSON.parse(row.details) })), last = activities.at(-1);
			return { activities, nextCursor: hasMore && last ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id })) : null };
		}
		case "get_project_context": {
			requireRole(identity, "admin", "collaborator", "reviewer");
			if (cachedContext && cachedContext.expires > Date.now()) return { content: cachedContext.content, updatedAt: cachedContext.updatedAt };
			const row = await db.prepare("SELECT content,updated_at AS updatedAt FROM project_context WHERE id='default'").first<any>();
			const value = row ?? { content: "", updatedAt: null };
			cachedContext = { content: value.content, updatedAt: value.updatedAt, expires: Date.now() + 15_000 };
			return value;
		}
		default: throw new Error(`Unknown tool: ${name}`);
	}
}

const toolDefinitions = [
	{ name: "list_tasks", description: "List tasks ordered by priority. Use nextCursor for the next page.", inputSchema: { type: "object", properties: { status: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } } } },
	{ name: "claim_task", description: "Atomically reserve the highest-priority eligible task. Heartbeat every 120 seconds by default. On empty results, pass backoffAttempt and wait retryAfterSeconds.", inputSchema: { type: "object", properties: { backoffAttempt: { type: "integer", minimum: 0, maximum: 10 } }, additionalProperties: false } },
	{ name: "get_task", description: "Get task details, dependencies, and submissions.", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
	{ name: "heartbeat", description: "Extend a current task lease. Lease duration is 10 minutes by default.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, leaseId: { type: "string" } }, required: ["taskId", "leaseId"] } },
	{ name: "release_task", description: "Release a task held by your current lease.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, leaseId: { type: "string" } }, required: ["taskId", "leaseId"] } },
	{ name: "submit_task", description: "Submit a commit and optional pull request for independent review.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, leaseId: { type: "string" }, commitSha: { type: "string" }, pullRequestUrl: { type: "string" }, summary: { type: "string" } }, required: ["taskId", "leaseId", "commitSha", "summary"] } },
	{ name: "review_task", description: "Independently accept or reject a pending submission.", inputSchema: { type: "object", properties: { submissionId: { type: "string" }, decision: { type: "string", enum: ["accepted", "rejected"] }, comment: { type: "string" } }, required: ["submissionId", "decision"] } },
	{ name: "get_progress", description: "Summarize task states and activity.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
	{ name: "get_activity", description: "Read paginated task or project activity history.", inputSchema: { type: "object", properties: { taskId: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } } } },
	{ name: "get_project_context", description: "Read the shared project context.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
];

async function mcp(request: Request, env: Env) {
	const db = env.rustkore_db;
	if (request.method !== "POST") return new Response("Streamable HTTP MCP accepts POST requests", { status: 405, headers: { Allow: "POST" } });
	const origin = request.headers.get("origin");
	if (origin && origin !== new URL(request.url).origin) return json({ error: "Origin is not allowed" }, 403);
	const accept = request.headers.get("accept") ?? "";
	if (!accept.includes("application/json") || !accept.includes("text/event-stream")) return json({ error: "Accept must include application/json and text/event-stream" }, 406);
	if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) return json({ error: "Content-Type: application/json is required" }, 415);
	let body: any;
	try { body = await request.json<any>(); }
	catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
	const { id: requestId, method, params = {} } = body ?? {};
	if (typeof method !== "string") return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32600, message: "Invalid request" } }, 400);
	if (method.startsWith("notifications/")) {
		if (await anonymousRateLimited(request, env, "anonymous")) return json({ error: "Rate limit exceeded" }, 429);
		return new Response(null, { status: 202 });
	}
	const protocolVersion = body?._meta?.["io.modelcontextprotocol/protocolVersion"];
	const modern = protocolVersion === MODERN_PROTOCOL;
	const headerVersion = request.headers.get("mcp-protocol-version");
	if (modern && headerVersion !== protocolVersion) return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32600, message: "Protocol version metadata mismatch" } }, 400);
	if (protocolVersion && !modern && !LEGACY_PROTOCOLS.includes(protocolVersion)) {
		return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [MODERN_PROTOCOL, ...LEGACY_PROTOCOLS], requested: protocolVersion } } }, 400);
	}
	if (modern && !body?._meta?.["io.modelcontextprotocol/clientCapabilities"]) return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32600, message: "Modern MCP requests require clientCapabilities metadata" } }, 400);
	let result: unknown;
	try {
		if (method === "server/discover" && modern) result = { supportedVersions: [MODERN_PROTOCOL], capabilities: { tools: {} }, ttlMs: 300_000, cacheScope: "public" };
		else if (method === "initialize") {
			const requested = params.protocolVersion;
			if (requested && !LEGACY_PROTOCOLS.includes(requested)) return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32022, message: "Unsupported protocol version", data: { supported: LEGACY_PROTOCOLS, requested } } }, 400);
			result = { protocolVersion: requested ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "rustkore", version: "0.1.0" } };
		}
		else if (method === "ping") result = {};
		else {
			if (modern && !protocolVersion) throw new Error("Modern MCP request is missing protocol version metadata");
			if (!modern && method !== "tools/list" && method !== "tools/call" && method !== "notifications/initialized") throw new Error(`Method not found: ${method}`);
			const identity = await authenticate(request, env);
			if (!identity) {
				if (await anonymousRateLimited(request, env, "unauthorized")) return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32029, message: "Rate limit exceeded" } }, 429);
				return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32001, message: "Unauthorized" } }, 401, { "www-authenticate": 'Bearer realm="RustKore"' });
			}
			if (method === "tools/list") {
				if (await rateLimited(identity, method, env)) return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32029, message: "Rate limit exceeded; retry after 60 seconds" } }, 429);
				result = { ...(modern ? { resultType: "complete", ttlMs: 300_000, cacheScope: "private" } : {}), tools: toolDefinitions };
			}
			else if (method === "tools/call") {
				const paramsObj = obj(params), name = text(paramsObj.name, "tool name", 80);
				if (await rateLimited(identity, name, env)) { result = { content: [{ type: "text", text: "Rate limit exceeded; retry after 60 seconds" }], isError: true }; }
				else try { const output = await callTool(name, obj(paramsObj.arguments), identity, db, env); result = { ...(modern ? { resultType: "complete" } : {}), content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output }; }
				catch (e) { result = { ...(modern ? { resultType: "complete" } : {}), content: [{ type: "text", text: e instanceof Error ? e.message : "Operation failed" }], isError: true }; }
			} else throw new Error(`Method not found: ${method}`);
		}
		if (requestId === undefined) return new Response(null, { status: 202 });
		return json({ jsonrpc: "2.0", id: requestId, result, ...(modern ? { _meta: { "io.modelcontextprotocol/serverInfo": { name: "rustkore", version: "0.1.0" } } } : {}) });
	} catch (e) {
		return json({ jsonrpc: "2.0", id: requestId ?? null, error: { code: -32601, message: e instanceof Error ? e.message : "Request failed" } }, 400);
	}
}

async function publicTaskPage(db: D1Database, url: URL) {
	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 100) || 100));
	let cursor: { createdAt: number; id: string } | null = null;
	if (url.searchParams.has("cursor")) {
		try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { throw new Error("Invalid task cursor"); }
		if (!cursor || !Number.isInteger(cursor.createdAt) || typeof cursor.id !== "string") throw new Error("Invalid task cursor");
	}
	const validStates = new Set(["available", "blocked", "reserved", "in_review", "approved", "integrated"]);
	const stateFilter = url.searchParams.get("state");
	if (stateFilter && !validStates.has(stateFilter)) throw new Error("Invalid task state");
	const complexity = url.searchParams.get("complexity");
	if (complexity && complexity !== "unassessed" && !["small", "medium", "large", "extra_large"].includes(complexity)) throw new Error("Invalid task complexity");
	const priority = url.searchParams.get("priority");
	if (priority && !["low", "medium", "high"].includes(priority)) throw new Error("Invalid task priority");
	const dependencyFilter = url.searchParams.get("dependencies");
	if (dependencyFilter && !["any", "none", "waiting"].includes(dependencyFilter)) throw new Error("Invalid dependency filter");
	const availability = url.searchParams.get("availability");
	if (availability && !["all", "eligible", "blocked"].includes(availability)) throw new Error("Invalid availability filter");
	const module = optText(url.searchParams.get("module"), 100), assignee = optText(url.searchParams.get("assignee"), 80), q = optText(url.searchParams.get("q"), 100);
	const state = taskDashboardStateSql("t"), where = ["(? IS NULL OR t.module=?)", "(? IS NULL OR state=?)", "(? IS NULL OR (?='unassessed' AND t.complexity IS NULL) OR t.complexity=?)",
		"(? IS NULL OR (?='low' AND t.priority<40) OR (?='medium' AND t.priority BETWEEN 40 AND 69) OR (?='high' AND t.priority>=70))",
		"(? IS NULL OR (?='all') OR (?='eligible' AND state='available') OR (?='blocked' AND state='blocked'))",
		"(? IS NULL OR (?='any' AND EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id)) OR (?='none' AND NOT EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id)) OR (?='waiting' AND state='blocked'))",
		"(? IS NULL OR (?='unassigned' AND c.github_login IS NULL) OR c.github_login=?)", "(? IS NULL OR t.id LIKE ? OR t.title LIKE ? OR t.module LIKE ?)", "(? IS NULL OR t.created_at>? OR (t.created_at=? AND t.id>?))"];
	const values: unknown[] = [module, module, stateFilter, stateFilter, complexity, complexity, complexity, priority, priority, priority, priority,
		availability, availability, availability, availability, dependencyFilter, dependencyFilter, dependencyFilter, dependencyFilter,
		assignee, assignee, assignee, q, q ? `%${q}%` : null, q ? `%${q}%` : null, q ? `%${q}%` : null,
		cursor ? 1 : null, cursor?.createdAt ?? 0, cursor?.createdAt ?? 0, cursor?.id ?? ""];
	const rows = await db.prepare(`SELECT t.id,t.title,t.module,t.description,t.acceptance_criteria AS acceptanceCriteria,t.priority,t.complexity,t.created_at AS createdAt,
		CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=unixepoch() THEN 'open' ELSE t.status END AS status,
		${state} AS state,CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN a.name END AS agentName,
		CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN c.github_login END AS assignee,
		EXISTS(SELECT 1 FROM task_dependencies d WHERE d.task_id=t.id) AS hasDependencies,
		(SELECT COUNT(*) FROM task_dependencies d WHERE d.task_id=t.id) AS dependencyCount
		FROM tasks t LEFT JOIN agents a ON a.id=t.assignee_agent_id LEFT JOIN collaborators c ON c.id=a.collaborator_id
		WHERE ${where.join(" AND ")} ORDER BY t.created_at ASC,t.id ASC LIMIT ?`).bind(...values, limit + 1).all<any>();
	const hasMore = rows.results.length > limit, tasks = rows.results.slice(0, limit), last = tasks.at(-1);
	return { tasks, nextCursor: hasMore && last ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id })) : null };
}

async function publicTaskDetail(db: D1Database, taskId: string) {
	const state = taskDashboardStateSql("t");
	const task = await db.prepare(`SELECT t.id,t.title,t.module,t.description,t.acceptance_criteria AS acceptanceCriteria,t.priority,t.complexity,t.created_at AS createdAt,
		CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=unixepoch() THEN 'open' ELSE t.status END AS status,
		${state} AS state,CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN a.name END AS agentName,
		CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN c.github_login END AS assignee,
		CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN t.lease_until END AS leaseUntil
		FROM tasks t LEFT JOIN agents a ON a.id=t.assignee_agent_id LEFT JOIN collaborators c ON c.id=a.collaborator_id WHERE t.id=?`).bind(taskId).first<any>();
	if (!task) return null;
	const [dependencies, dependents, submissions, activity] = await Promise.all([
		db.prepare(`SELECT parent.id,parent.title,${taskDashboardStateSql("parent")} AS state FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on_id WHERE d.task_id=? ORDER BY parent.created_at,parent.id LIMIT 100`).bind(taskId).all<any>(),
		db.prepare(`SELECT child.id,child.title,${taskDashboardStateSql("child")} AS state FROM task_dependencies d JOIN tasks child ON child.id=d.task_id WHERE d.depends_on_id=? ORDER BY child.created_at,child.id LIMIT 100`).bind(taskId).all<any>(),
		db.prepare(`SELECT s.id,s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,s.summary,s.created_at AS createdAt,
			CASE WHEN i.id IS NOT NULL THEN 'integrated' ELSE s.status END AS status,r.decision AS reviewDecision,r.created_at AS reviewedAt,
			rc.github_login AS reviewer,i.merge_commit_sha AS mergeCommitSha,i.integrated_at AS integratedAt
			FROM submissions s LEFT JOIN reviews r ON r.submission_id=s.id LEFT JOIN collaborators rc ON rc.id=r.reviewer_id LEFT JOIN integrations i ON i.submission_id=s.id
			WHERE s.task_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 25`).bind(taskId).all<any>(),
		db.prepare(`SELECT a.id,a.action,a.created_at AS createdAt,c.github_login AS actor,
			s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl
			FROM activity a JOIN collaborators c ON c.id=a.actor_id
			LEFT JOIN submissions s ON s.id=json_extract(a.details_json,'$.submissionId')
			WHERE a.task_id=? AND a.action IN ('task.created','task.claimed','task.released','task.submitted','submission.accepted','submission.rejected','task.integrated','task.updated')
			ORDER BY a.created_at DESC,a.id DESC LIMIT 50`).bind(taskId).all<any>(),
	]);
	return { ...task, dependencies: dependencies.results, dependents: dependents.results, submissions: submissions.results, activity: activity.results };
}

async function publicContributorProfile(db: D1Database, login: string) {
	const person = await db.prepare(`SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,c.created_at AS joinedAt,
		(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id) AS integratedCount,
		(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id) AS reviewCount,
		(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id AND r.created_at>=unixepoch()-604800) AS review7d,
		(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id AND r.created_at>=unixepoch()-2592000) AS review30d,
		(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id AND r.created_at>=unixepoch()-7776000) AS review90d,
		(SELECT json_group_array(json_object('id',r.id,'code',r.code,'rationale',r.rationale,'awardedAt',r.awarded_at)) FROM collaborator_recognitions r WHERE r.collaborator_id=c.id ORDER BY r.awarded_at DESC) AS recognitionsJson
		FROM collaborators c WHERE c.github_login=? COLLATE NOCASE AND c.github_user_id IS NOT NULL AND c.suspended_at IS NULL`).bind(login).first<any>();
	if (!person) return null;
	const collaboratorId = person.id, { id: _internalId, recognitionsJson, ...publicPerson } = person;
	const [modules, contributions, reviews] = await Promise.all([
		db.prepare(`SELECT t.module,COUNT(*) AS integratedCount FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=? GROUP BY t.module ORDER BY integratedCount DESC,t.module ASC`).bind(collaboratorId).all<any>(),
		db.prepare(`SELECT t.id AS taskId,t.title,t.module,s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,i.merge_commit_sha AS mergeCommitSha,i.integrated_at AS integratedAt FROM integrations i JOIN tasks t ON t.id=i.task_id JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=? ORDER BY i.integrated_at DESC,i.id DESC LIMIT 50`).bind(collaboratorId).all<any>(),
		db.prepare(`SELECT r.decision,r.created_at AS reviewedAt,t.id AS taskId,t.title,t.module,s.pull_request_url AS pullRequestUrl FROM reviews r JOIN submissions s ON s.id=r.submission_id JOIN tasks t ON t.id=s.task_id WHERE r.reviewer_id=? ORDER BY r.created_at DESC,r.id DESC LIMIT 50`).bind(collaboratorId).all<any>(),
	]);
	let recognitions: unknown[] = []; try { recognitions = JSON.parse(recognitionsJson ?? "[]"); } catch { /* malformed legacy data stays hidden */ }
	return { ...publicPerson, recognitions, modules: modules.results, contributions: contributions.results, reviews: reviews.results };
}

function pageCursor<T extends Record<string, unknown>>(url: URL): T | null {
	if (!url.searchParams.has("cursor")) return null;
	try {
		const cursor = JSON.parse(atob(url.searchParams.get("cursor")!));
		if (!cursor || typeof cursor !== "object" || !Number.isInteger(cursor.createdAt) || typeof cursor.id !== "string") throw new Error();
		return cursor as T;
	} catch { throw new Error("Invalid history cursor"); }
}
function encodeCursor(value: unknown) { return btoa(JSON.stringify(value)); }
function periodStart(value: string | null) {
	if (!value || value === "all") return null;
	if (!["7", "30", "90"].includes(value)) throw new Error("Invalid period filter");
	return Math.floor(Date.now() / 1000) - Number(value) * 86400;
}
async function publicActivityPage(db: D1Database, url: URL) {
	const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? 25) || 25));
	const cursor = pageCursor<{ createdAt: number; id: string }>(url);
	const allowed = ["task.claimed", "task.submitted", "submission.accepted", "submission.rejected", "task.integrated"];
	const eventType = optText(url.searchParams.get("type"), 40);
	if (eventType && !allowed.includes(eventType)) throw new Error("Invalid activity type");
	const contributor = optText(url.searchParams.get("contributor"), 80), module = optText(url.searchParams.get("module"), 100), start = periodStart(url.searchParams.get("period"));
	const predicates = [`a.action IN (${allowed.map(() => "?").join(",")})`], bindings: unknown[] = [...allowed];
	if (eventType) { predicates.push("a.action=?"); bindings.push(eventType); }
	if (contributor) { predicates.push("a.actor_id=(SELECT id FROM collaborators WHERE github_login=? COLLATE NOCASE)"); bindings.push(contributor); }
	if (module) { predicates.push("t.module=?"); bindings.push(module); }
	if (start !== null) { predicates.push("a.created_at>=?"); bindings.push(start); }
	if (cursor) { predicates.push("(a.created_at<? OR (a.created_at=? AND a.id<?))"); bindings.push(cursor.createdAt,cursor.createdAt,cursor.id); }
	const activityIndex = eventType ? "activity_public_page" : contributor ? "activity_public_actor_page" : "activity_public_timeline";
	const rows = await db.prepare(`SELECT a.id,a.action,a.created_at AS createdAt,t.id AS taskId,t.title,t.module,c.github_login AS actor,
		COALESCE(json_extract(a.details_json,'$.agentName'),agent.name) AS agentName,s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl
		FROM activity a INDEXED BY ${activityIndex} JOIN tasks t ON t.id=a.task_id JOIN collaborators c ON c.id=a.actor_id
		LEFT JOIN submissions s ON s.id=json_extract(a.details_json,'$.submissionId') LEFT JOIN agents agent ON agent.id=json_extract(a.details_json,'$.agentId')
		WHERE ${predicates.join(" AND ")}
		ORDER BY a.created_at DESC,a.id DESC LIMIT ?`).bind(...bindings,limit+1).all<any>();
	const hasMore = rows.results.length > limit, items = rows.results.slice(0, limit), last = items.at(-1);
	return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null, limit };
}
async function publicContributionPage(db: D1Database, url: URL) {
	const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? 25) || 25));
	const cursor = pageCursor<{ createdAt: number; id: string }>(url), module = optText(url.searchParams.get("module"), 100);
	const contributor = optText(url.searchParams.get("contributor"), 80), status = optText(url.searchParams.get("status"), 20), start = periodStart(url.searchParams.get("period"));
	if (status && !["pending", "accepted", "rejected", "integrated"].includes(status)) throw new Error("Invalid contribution status");
	const rows = await db.prepare(`SELECT s.id,s.task_id AS taskId,t.title,t.module,c.github_login AS login,s.status,
		CASE WHEN i.id IS NOT NULL THEN 'integrated' ELSE s.status END AS effectiveStatus,
		s.created_at AS submittedAt,i.integrated_at AS integratedAt,s.pull_request_url AS pullRequestUrl,s.commit_sha AS commitSha
		FROM submissions s JOIN tasks t ON t.id=s.task_id JOIN agents a ON a.id=s.agent_id JOIN collaborators c ON c.id=a.collaborator_id
		LEFT JOIN integrations i ON i.submission_id=s.id
		WHERE (? IS NULL OR t.module=?) AND (? IS NULL OR c.github_login=? COLLATE NOCASE)
		AND (? IS NULL OR (CASE WHEN i.id IS NOT NULL THEN 'integrated' ELSE s.status END)=?)
		AND (? IS NULL OR s.created_at>=?) AND (? IS NULL OR s.created_at<? OR (s.created_at=? AND s.id<?))
		ORDER BY s.created_at DESC,s.id DESC LIMIT ?`).bind(module,module,contributor,contributor,status,status,start,start,cursor?1:null,cursor?.createdAt??0,cursor?.createdAt??0,cursor?.id??"",limit+1).all<any>();
	const hasMore = rows.results.length > limit, items = rows.results.slice(0, limit), last = items.at(-1);
	return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.submittedAt, id: last.id }) : null, limit };
}
async function publicReservationPage(db: D1Database, url: URL) {
	const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") ?? 10) || 10));
	let cursor: { leaseUntil: number; taskId: string } | null = null;
	if (url.searchParams.has("cursor")) {
		try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { throw new Error("Invalid reservation cursor"); }
		if (!cursor || !Number.isInteger(cursor.leaseUntil) || typeof cursor.taskId !== "string") throw new Error("Invalid reservation cursor");
	}
	const rows = await db.prepare(`SELECT a.name AS agentName,c.name AS contributorName,c.github_login AS login,c.avatar_url AS avatarUrl,
		t.id AS taskId,t.title,t.module,t.lease_until AS leaseUntil,t.updated_at AS reservedAt
		FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id JOIN collaborators c ON c.id=a.collaborator_id
		WHERE t.status='claimed' AND t.lease_until>unixepoch() AND c.suspended_at IS NULL
		AND (? IS NULL OR t.lease_until>? OR (t.lease_until=? AND t.id>?))
		ORDER BY t.lease_until ASC,t.id ASC LIMIT ?`).bind(cursor?1:null,cursor?.leaseUntil??0,cursor?.leaseUntil??0,cursor?.taskId??"",limit+1).all<any>();
	const hasMore = rows.results.length > limit, items = rows.results.slice(0, limit), last = items.at(-1);
	return { items, nextCursor: hasMore && last ? encodeCursor({ leaseUntil: last.leaseUntil, taskId: last.taskId }) : null, limit };
}
async function publicRankingPage(db: D1Database, url: URL) {
	const limit = Math.max(1, Math.min(10, Number(url.searchParams.get("limit") ?? 10) || 10));
	const measure = url.searchParams.get("measure") ?? "integrated";
	if (!["integrated", "reviews"].includes(measure)) throw new Error("Invalid ranking measure");
	const module = optText(url.searchParams.get("module"), 100), start = periodStart(url.searchParams.get("period"));
	let cursor: { metric: number; login: string } | null = null;
	if (url.searchParams.has("cursor")) {
		try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { throw new Error("Invalid ranking cursor"); }
		if (!cursor || !Number.isInteger(cursor.metric) || typeof cursor.login !== "string") throw new Error("Invalid ranking cursor");
	}
	const score = measure === "integrated"
		? `(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id JOIN tasks t ON t.id=i.task_id WHERE a.collaborator_id=c.id AND (? IS NULL OR t.module=?) AND (? IS NULL OR i.integrated_at>=?))`
		: `(SELECT COUNT(*) FROM reviews r JOIN submissions s ON s.id=r.submission_id JOIN tasks t ON t.id=s.task_id WHERE r.reviewer_id=c.id AND (? IS NULL OR t.module=?) AND (? IS NULL OR r.created_at>=?))`;
	const values = [module,module,start,start];
	const rows = await db.prepare(`WITH ranked AS (
		SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,c.created_at AS joinedAt,${score} AS metric,
		(SELECT json_group_array(json_object('id',r.id,'code',r.code,'rationale',r.rationale,'awardedAt',r.awarded_at)) FROM collaborator_recognitions r WHERE r.collaborator_id=c.id ORDER BY r.awarded_at DESC) AS recognitionsJson
		FROM collaborators c WHERE c.github_user_id IS NOT NULL AND c.suspended_at IS NULL)
		SELECT * FROM ranked WHERE metric>0 AND (? IS NULL OR metric<? OR (metric=? AND login>? COLLATE NOCASE))
		ORDER BY metric DESC,login COLLATE NOCASE ASC LIMIT ?`).bind(...values,cursor?1:null,cursor?.metric??0,cursor?.metric??0,cursor?.login??"",limit+1).all<any>();
	const hasMore = rows.results.length > limit, items = rows.results.slice(0, limit), last = items.at(-1);
	return { items: items.map((item: any) => { let recognitions = []; try { recognitions = JSON.parse(item.recognitionsJson ?? "[]"); } catch {} const { recognitionsJson: _hidden, ...person } = item; return { ...person, recognitions }; }),
		nextCursor: hasMore && last ? encodeCursor({ metric: last.metric, login: last.login }) : null, limit, measure, module, period: url.searchParams.get("period") ?? "all" };
}

async function publicDashboard(db: D1Database) {
	if (cachedDashboard && cachedDashboard.expires > Date.now()) return cachedDashboard.content;
	const state = taskDashboardStateSql("t"), page = await publicTaskPage(db, new URL("https://rustkore.local/api/tasks?limit=100"));
	const [summary, modules, moduleDependencies, contributors, agents, history, integrationRows, activity] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS total,
			SUM(state='integrated') AS integrated,SUM(state='available') AS available,SUM(state='blocked') AS blocked,
			SUM(state='reserved') AS reserved,SUM(state='in_review') AS inReview,SUM(state='approved') AS approved,
			(SELECT COUNT(*) FROM collaborators c WHERE c.github_user_id IS NOT NULL AND c.suspended_at IS NULL) AS contributors,
			(SELECT COUNT(*) FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id JOIN collaborators c ON c.id=a.collaborator_id WHERE t.status='claimed' AND t.lease_until>unixepoch() AND c.suspended_at IS NULL) AS activeAgents
			FROM (SELECT ${state} AS state FROM tasks t)`).first<any>(),
		db.prepare(`SELECT module,COUNT(*) AS total,SUM(state='integrated') AS integrated,SUM(state='available') AS available,
			SUM(state='blocked') AS blocked,SUM(state='reserved') AS reserved,SUM(state='in_review') AS inReview,SUM(state='approved') AS approved
			FROM (SELECT t.module,${state} AS state FROM tasks t) GROUP BY module ORDER BY integrated DESC,total DESC,module ASC LIMIT 50`).all<any>(),
		db.prepare(`SELECT child.module AS module,parent.module AS dependsOnModule,COUNT(*) AS taskDependencies
			FROM task_dependencies d JOIN tasks child ON child.id=d.task_id JOIN tasks parent ON parent.id=d.depends_on_id
			WHERE child.module<>parent.module GROUP BY child.module,parent.module ORDER BY child.module,parent.module LIMIT 2500`).all<any>(),
		db.prepare(`SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,c.created_at AS joinedAt,
			(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id) AS integratedCount,
			(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id) AS reviewCount,
			(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id AND i.integrated_at>=unixepoch()-604800) AS integrated7d,
			(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id AND i.integrated_at>=unixepoch()-2592000) AS integrated30d,
			(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id AND i.integrated_at>=unixepoch()-7776000) AS integrated90d,
			(SELECT MAX(i.integrated_at) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=c.id) AS lastIntegratedAt,
			(SELECT json_group_array(json_object('module',module,'count',count)) FROM (SELECT t.module,COUNT(*) AS count FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id JOIN tasks t ON t.id=i.task_id WHERE a.collaborator_id=c.id GROUP BY t.module ORDER BY count DESC,t.module LIMIT 20)) AS moduleCountsJson,
			(SELECT json_group_array(json_object('module',module,'count',count)) FROM (SELECT t.module,COUNT(*) AS count FROM reviews r JOIN submissions s ON s.id=r.submission_id JOIN tasks t ON t.id=s.task_id WHERE r.reviewer_id=c.id GROUP BY t.module ORDER BY count DESC,t.module LIMIT 20)) AS moduleReviewCountsJson,
			(SELECT json_group_array(json_object('id',r.id,'code',r.code,'rationale',r.rationale,'awardedAt',r.awarded_at)) FROM collaborator_recognitions r WHERE r.collaborator_id=c.id ORDER BY r.awarded_at DESC) AS recognitionsJson
			FROM collaborators c WHERE c.github_user_id IS NOT NULL AND c.suspended_at IS NULL
			AND (EXISTS (SELECT 1 FROM agents a JOIN submissions s ON s.agent_id=a.id JOIN integrations i ON i.submission_id=s.id WHERE a.collaborator_id=c.id)
				OR EXISTS (SELECT 1 FROM reviews r WHERE r.reviewer_id=c.id))
		ORDER BY integratedCount DESC,reviewCount DESC,lastIntegratedAt DESC,c.github_login ASC LIMIT 10`).all<any>(),
		db.prepare(`SELECT a.name AS agentName,c.name AS contributorName,c.github_login AS login,c.avatar_url AS avatarUrl,
			t.id AS taskId,t.title,t.module,t.lease_until AS leaseUntil,t.updated_at AS reservedAt FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id
			JOIN collaborators c ON c.id=a.collaborator_id WHERE t.status='claimed' AND t.lease_until>unixepoch()
			AND c.suspended_at IS NULL ORDER BY t.lease_until ASC,t.id ASC LIMIT 11`).all<any>(),
		db.prepare(`SELECT t.id AS taskId,t.title,t.module,a.name AS agentName,c.github_login AS login,
			s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,s.summary,s.created_at AS createdAt,
			CASE WHEN i.id IS NOT NULL THEN 'integrated' ELSE s.status END AS status,
			i.merge_commit_sha AS mergeCommitSha,i.integrated_at AS integratedAt FROM submissions s JOIN tasks t ON t.id=s.task_id
			JOIN agents a ON a.id=s.agent_id JOIN collaborators c ON c.id=a.collaborator_id LEFT JOIN integrations i ON i.submission_id=s.id
			ORDER BY s.created_at DESC,s.id DESC LIMIT 10`).all<any>(),
		db.prepare(`SELECT CAST((integrated_at/86400)*86400 AS INTEGER) AS day,COUNT(*) AS count
			FROM integrations GROUP BY integrated_at/86400 ORDER BY day DESC LIMIT 1500`).all<any>(),
		db.prepare(`SELECT x.id,x.taskId,x.title,x.module,x.action,x.actor,x.createdAt,x.agentName,x.pullRequestUrl,x.commitSha FROM (
			SELECT a.id,a.task_id AS taskId,t.title,t.module,a.action,c.github_login AS actor,a.created_at AS createdAt,
				s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,
				COALESCE(json_extract(a.details_json,'$.agentName'),agent.name) AS agentName
			FROM activity a JOIN tasks t ON t.id=a.task_id JOIN collaborators c ON c.id=a.actor_id
			LEFT JOIN submissions s ON s.id=json_extract(a.details_json,'$.submissionId') LEFT JOIN agents agent ON agent.id=json_extract(a.details_json,'$.agentId')
			WHERE a.action IN ('task.claimed','task.submitted','submission.accepted','submission.rejected','task.integrated')) x
			ORDER BY createdAt DESC,id DESC LIMIT 10`).all<any>(),
	]);
	const parseJson = (value: unknown) => { try { return JSON.parse(String(value ?? "[]")); } catch { return []; } };
	const value = { summary: summary ?? { total: 0, integrated: 0, available: 0, blocked: 0, reserved: 0, inReview: 0, approved: 0, contributors: 0, activeAgents: 0 },
		modules: modules.results, moduleDependencies: moduleDependencies.results, tasks: page.tasks, nextCursor: page.nextCursor,
		contributors: contributors.results.map((person: any) => { const { id: _internalId, moduleCountsJson, moduleReviewCountsJson, recognitionsJson, ...publicPerson } = person; return { ...publicPerson, moduleCounts: parseJson(moduleCountsJson), moduleReviewCounts: parseJson(moduleReviewCountsJson), recognitions: parseJson(recognitionsJson) }; }),
		activeAgents: agents.results.slice(0, 10), activeReservationsNextCursor: agents.results.length > 10 ? encodeCursor({ leaseUntil: agents.results[9].leaseUntil, taskId: agents.results[9].taskId }) : null,
		recentIntegrations: history.results.filter((row: any) => row.status === "integrated"), recentContributions: history.results.slice(0, 10), integrationHistory: { daily: integrationRows.results.reverse(), monthly: Object.entries(integrationRows.results.reduce((groups: Record<string, number>, row: any) => { const month = new Date(Number(row.day) * 1000).toISOString().slice(0,7); groups[month] = (groups[month] || 0) + Number(row.count); return groups; }, {})).map(([month, count]) => ({ month: `${month}-01`, count })) },
		recentActivity: activity.results.map(({ id: _internalId, ...event }: any) => event), lastUpdatedAt: now() };
	cachedDashboard = { content: value, expires: Date.now() + 5_000 };
	return value;
}

async function publicRoadmap(db: D1Database, scenario: "actual" | "demo" = "actual") {
	if (scenario === "actual" && cachedRoadmap && cachedRoadmap.expires > Date.now()) return cachedRoadmap.content;
	const [milestones, categories, coverage, acceptance] = await Promise.all([
		db.prepare("SELECT id,name,target_version AS targetVersion,objective,release_acceptance_json AS acceptanceJson,status,position FROM roadmap_milestones ORDER BY position").all<any>(),
		db.prepare("SELECT id,name,position FROM roadmap_categories ORDER BY position").all<any>(),
		db.prepare(`SELECT f.category_id AS categoryId,f.milestone_id AS milestoneId,COUNT(*) AS total,
			SUM(CASE WHEN s.state='verified' THEN 1 ELSE 0 END) AS verified,
			SUM(CASE WHEN s.state='planned' OR s.state IS NULL THEN 1 ELSE 0 END) AS planned,
			SUM(CASE WHEN s.state='developing' THEN 1 ELSE 0 END) AS developing,
			SUM(CASE WHEN s.state='testing' THEN 1 ELSE 0 END) AS testing,
			SUM(CASE WHEN f.is_required=1 THEN 1 ELSE 0 END) AS requiredTotal,
			SUM(CASE WHEN f.is_required=1 AND s.state='verified' THEN 1 ELSE 0 END) AS requiredVerified
			FROM roadmap_features f LEFT JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario=?
			WHERE f.active=1 GROUP BY f.category_id,f.milestone_id`).bind(scenario).all<any>(),
		db.prepare(`SELECT c.id,c.milestone_id AS milestoneId,c.description,c.state,c.evidence_url AS evidenceUrl,
			c.verified_at AS verifiedAt,c.updated_at AS updatedAt,verified.github_login AS verifiedBy
			FROM release_acceptance_criteria c LEFT JOIN collaborators verified ON verified.id=c.verified_by
			ORDER BY c.milestone_id,c.id`).all<any>(),
	]);
	const sums = coverage.results.reduce((acc: any, cell: any) => {
		acc.total += Number(cell.total); acc.verified += Number(cell.verified); acc.requiredTotal += Number(cell.requiredTotal); acc.requiredVerified += Number(cell.requiredVerified); return acc;
	}, { total: 0, verified: 0, requiredTotal: 0, requiredVerified: 0 });
	const orderedMilestones = milestones.results.map((m: any) => { const { acceptanceJson: _acceptanceJson, ...milestone } = m; return { ...milestone, acceptanceCriteria: acceptance.results.filter((item: any) => item.milestoneId === m.id), readiness: { verified: 0, total: 0 }, acceptanceReadiness: { verified: 0, total: 0 } }; });
	for (let i = 0; i < orderedMilestones.length; i++) {
		const accepted = new Set(orderedMilestones.slice(0, i + 1).map((m: any) => m.id));
		for (const cell of coverage.results) if (accepted.has(cell.milestoneId)) {
			orderedMilestones[i].readiness.verified += Number(cell.requiredVerified);
			orderedMilestones[i].readiness.total += Number(cell.requiredTotal);
		}
		for (const criterion of acceptance.results) if (accepted.has(criterion.milestoneId)) {
			orderedMilestones[i].acceptanceReadiness.total++;
			if (criterion.state === "verified") orderedMilestones[i].acceptanceReadiness.verified++;
		}
		orderedMilestones[i].complete = orderedMilestones[i].readiness.total > 0 && orderedMilestones[i].readiness.verified >= orderedMilestones[i].readiness.total && orderedMilestones[i].acceptanceReadiness.verified >= orderedMilestones[i].acceptanceReadiness.total;
	}
	const plannedMilestones = orderedMilestones.filter((m: any) => m.status === "planned");
	const next = plannedMilestones.find((m: any) => m.readiness.verified < m.readiness.total) || plannedMilestones[0] || orderedMilestones.at(-1);
	const value = { milestones: orderedMilestones, categories: categories.results, coverage: coverage.results, summary: { ...sums, nextRelease: next ? { milestoneId: next.id, ...next.readiness } : { milestoneId: null, verified: 0, total: 0 } }, scenario };
	if (scenario === "actual") cachedRoadmap = { content: value, expires: Date.now() + 15_000 };
	return value;
}

function parseRoadmapCursor(value: string | null): string | null {
	if (!value) return null;
	try { const cursor = JSON.parse(atob(value)); return cursor && typeof cursor.id === "string" && cursor.id.length <= 120 ? cursor.id : null; } catch { return null; }
}

async function publicRoadmapFeatures(db: D1Database, url: URL, scenario: "actual" | "demo") {
	const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? 25) || 25));
	const category = url.searchParams.get("category"), milestone = url.searchParams.get("milestone"), state = url.searchParams.get("state");
	const allowedStates = new Set(["planned", "developing", "testing", "verified"]);
	if (category && !/^[a-z][a-z0-9-]{0,60}$/.test(category)) return { error: "Invalid category filter" };
	if (milestone && !/^[a-z][a-z0-9-]{0,60}$/.test(milestone)) return { error: "Invalid milestone filter" };
	if (state && !allowedStates.has(state)) return { error: "Invalid feature state filter" };
	const cursor = parseRoadmapCursor(url.searchParams.get("cursor"));
	if (url.searchParams.has("cursor") && !cursor) return { error: "Invalid feature cursor" };
	const clauses = ["f.active=1", "(? IS NULL OR f.category_id=?)", "(? IS NULL OR f.milestone_id=?)", "(? IS NULL OR COALESCE(s.state,'planned')=?)", "(? IS NULL OR f.id>?)"];
	const values: unknown[] = [scenario, category, category, milestone, milestone, state, state, cursor, cursor, limit + 1];
	const rows = await db.prepare(`SELECT f.id,f.category_id AS categoryId,c.name AS category,f.title,f.description,f.milestone_id AS milestoneId,m.name AS milestone,
		f.is_required AS required,f.acceptance_criteria_json AS acceptanceCriteriaJson,f.upstream_references_json AS upstreamReferencesJson,
		COALESCE(s.state,'planned') AS state,s.updated_at AS updatedAt,s.verified_at AS verifiedAt,verified.github_login AS verifiedBy,
		(SELECT json_group_array(json_object('id',t.id,'title',t.title,'module',t.module)) FROM roadmap_feature_tasks ft JOIN tasks t ON t.id=ft.task_id WHERE ft.feature_id=f.id AND ft.scenario=? AND ft.active=1) AS tasksJson,
		(SELECT json_group_array(json_object('id',e.id,'url',e.url,'label',e.label,'description',e.description,'createdAt',e.created_at,'createdBy',creator.github_login)) FROM roadmap_feature_evidence e JOIN collaborators creator ON creator.id=e.created_by WHERE e.feature_id=f.id AND e.scenario=? AND e.is_valid=1 ORDER BY e.created_at DESC LIMIT 10) AS evidenceJson
		FROM roadmap_features f JOIN roadmap_categories c ON c.id=f.category_id JOIN roadmap_milestones m ON m.id=f.milestone_id
		LEFT JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario=? LEFT JOIN collaborators verified ON verified.id=s.verified_by
		WHERE ${clauses.join(" AND ")} ORDER BY f.id ASC LIMIT ?`).bind(scenario, scenario, scenario, ...values.slice(1)).all<any>();
	const hasMore = rows.results.length > limit, page = rows.results.slice(0, limit), last = page.at(-1);
	const parse = (value: unknown) => { try { return JSON.parse(String(value ?? "[]")); } catch { return []; } };
	return { features: page.map((f: any) => { const { acceptanceCriteriaJson, upstreamReferencesJson, tasksJson, evidenceJson, ...feature } = f; return { ...feature, required: Boolean(f.required), acceptanceCriteria: parse(acceptanceCriteriaJson), upstreamReferences: parse(upstreamReferencesJson), tasks: parse(tasksJson), evidence: parse(evidenceJson) }; }), nextCursor: hasMore && last ? btoa(JSON.stringify({ id: last.id })) : null };
}

function canonicalRoadmapJSON(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonicalRoadmapJSON).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalRoadmapJSON(value[key])}`).join(",")}}`;
	return JSON.stringify(value);
}

async function importRoadmapCatalog(db: D1Database, catalog: any, identity: WebIdentity) {
	if (!catalog || catalog.schemaVersion !== 1 || typeof catalog.catalogVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(catalog.catalogVersion)) throw new Error("Roadmap catalog has an unsupported schema or version");
	if (!catalog.source || catalog.source.repository !== "https://github.com/OpenKore/openkore" || catalog.source.branch !== "master" || !/^[0-9a-f]{40}$/i.test(catalog.source.initialResearchRevision ?? "")) throw new Error("Roadmap catalog source metadata is invalid");
	if (!Array.isArray(catalog.milestones) || catalog.milestones.length !== 6 || !Array.isArray(catalog.categories) || catalog.categories.length !== 18 || !Array.isArray(catalog.features) || catalog.features.length < 1 || catalog.features.length > 1000) throw new Error("Roadmap catalog must contain the six milestones, eighteen categories, and at most 1000 features");
	if (!catalog.releaseAcceptanceCriteria || Object.keys(catalog.releaseAcceptanceCriteria).some((key) => !catalog.milestones.some((milestone: any) => milestone.id === key)) || catalog.milestones.some((milestone: any) => !Array.isArray(catalog.releaseAcceptanceCriteria[milestone.id]) || catalog.releaseAcceptanceCriteria[milestone.id].length > 20 || catalog.releaseAcceptanceCriteria[milestone.id].some((criterion: any) => typeof criterion !== "string" || !criterion.trim() || criterion.length > 1000))) throw new Error("Release acceptance criteria must be valid arrays for known milestones");
	const [storedMilestones, storedCategories] = await Promise.all([
		db.prepare("SELECT id,name,position FROM roadmap_milestones ORDER BY position").all<any>(),
		db.prepare("SELECT id,name,position FROM roadmap_categories ORDER BY position").all<any>(),
	]);
	const sameSequence = (input: any[], stored: any[]) => input.length === stored.length && input.every((item, index) => item?.id === stored[index]?.id && item?.order === stored[index]?.position && item?.name === stored[index]?.name);
	if (!sameSequence(catalog.milestones, storedMilestones.results) || !sameSequence(catalog.categories, storedCategories.results)) throw new Error("Roadmap categories and milestone IDs and order cannot be changed by import");
	const milestoneIds = new Set(catalog.milestones.map((item: any) => item.id)), categoryIds = new Set(catalog.categories.map((item: any) => item.id)), featureIds = new Set<string>();
	for (const feature of catalog.features) {
		if (!feature || typeof feature.id !== "string" || !/^[a-z][a-z0-9-]{0,60}\.[a-z0-9][a-z0-9-]{0,100}$/.test(feature.id) || featureIds.has(feature.id)) throw new Error("Roadmap feature IDs must be unique and permanently namespaced");
		featureIds.add(feature.id);
		if (!categoryIds.has(feature.categoryId) || !milestoneIds.has(feature.milestoneId)) throw new Error(`Roadmap feature ${feature.id} references an unknown category or milestone`);
		if (typeof feature.title !== "string" || !feature.title.trim() || feature.title.length > 180 || typeof feature.description !== "string" || !feature.description.trim() || feature.description.length > 2000) throw new Error(`Roadmap feature ${feature.id} has invalid text fields`);
		if (typeof feature.required !== "boolean" || !Array.isArray(feature.acceptanceCriteria) || feature.acceptanceCriteria.length < 1 || feature.acceptanceCriteria.length > 12 || feature.acceptanceCriteria.some((item: any) => typeof item !== "string" || !item.trim() || item.length > 1000)) throw new Error(`Roadmap feature ${feature.id} has invalid acceptance criteria or required flag`);
		if (!Array.isArray(feature.upstreamReferences) || feature.upstreamReferences.length > 12 || feature.upstreamReferences.some((item: any) => typeof item !== "string" || item.length > 300 || !/^https:\/\//.test(item))) throw new Error(`Roadmap feature ${feature.id} has invalid upstream references`);
	}
	const canonical = canonicalRoadmapJSON(catalog), catalogHash = await sha256(canonical);
	if (await db.prepare("SELECT 1 AS present FROM roadmap_catalog_imports WHERE catalog_hash=?").bind(catalogHash).first()) return { imported: false, unchanged: true, catalogHash };
	const current = await db.prepare(`SELECT f.id,f.title,f.category_id AS categoryId,f.milestone_id AS milestoneId,f.is_required AS required,
		f.description,f.acceptance_criteria_json AS acceptanceCriteriaJson,COALESCE(s.state,'planned') AS state
		FROM roadmap_features f LEFT JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario='actual' WHERE f.active=1`).all<any>();
	const currentById = new Map(current.results.map((feature: any) => [feature.id, feature]));
	const scopeChanged: string[] = [], changed: string[] = [], added: string[] = [];
	for (const feature of catalog.features) {
		const old: any = currentById.get(feature.id);
		if (!old) { added.push(feature.id); continue; }
		const acceptance = JSON.stringify(feature.acceptanceCriteria);
		const incompatible = old.title !== feature.title || old.description !== feature.description || old.categoryId !== feature.categoryId || old.milestoneId !== feature.milestoneId || Boolean(old.required) !== feature.required || old.acceptanceCriteriaJson !== acceptance;
		if (old.state === "verified" && incompatible) scopeChanged.push(feature.id);
		if (old.description !== feature.description || incompatible) changed.push(feature.id);
	}
	if (scopeChanged.length) throw new Error(`Invalidate verified requirements before changing their scope: ${scopeChanged.slice(0,5).join(", ")}`);
	const removed = current.results.filter((feature: any) => !featureIds.has(feature.id)).map((feature: any) => feature.id);
	const milestonesJson = JSON.stringify(catalog.milestones.map((m: any) => ({ ...m, acceptanceCriteria: catalog.releaseAcceptanceCriteria?.[m.id] ?? [] }))), categoriesJson = JSON.stringify(catalog.categories), featureIdsJson = JSON.stringify([...featureIds]), featureChunks = Array.from({ length: Math.ceil(catalog.features.length / 35) }, (_, index) => JSON.stringify(catalog.features.slice(index * 35, index * 35 + 35)));
	const statements: D1PreparedStatement[] = [
		db.prepare(`INSERT INTO roadmap_milestones (id,name,target_version,objective,release_acceptance_json,status,position)
			SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.version'),json_extract(value,'$.objective'),json_extract(value,'$.acceptanceCriteria'),json_extract(value,'$.status'),json_extract(value,'$.order') FROM json_each(?) WHERE true
			ON CONFLICT(id) DO UPDATE SET name=excluded.name,target_version=excluded.target_version,objective=excluded.objective,release_acceptance_json=excluded.release_acceptance_json,status=excluded.status,position=excluded.position`).bind(milestonesJson),
		db.prepare(`INSERT INTO roadmap_categories (id,name,position) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.order') FROM json_each(?) WHERE true
			ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position`).bind(categoriesJson),
		db.prepare("UPDATE roadmap_features SET active=0,updated_at=unixepoch() WHERE active=1 AND id NOT IN (SELECT value FROM json_each(?))").bind(featureIdsJson),
		...featureChunks.map((chunk) => db.prepare(`INSERT INTO roadmap_features (id,category_id,title,description,milestone_id,is_required,acceptance_criteria_json,upstream_references_json,created_at,updated_at)
			SELECT json_extract(value,'$.id'),json_extract(value,'$.categoryId'),json_extract(value,'$.title'),json_extract(value,'$.description'),json_extract(value,'$.milestoneId'),json_extract(value,'$.required'),json_extract(value,'$.acceptanceCriteria'),json_extract(value,'$.upstreamReferences'),unixepoch(),unixepoch() FROM json_each(?) WHERE true
			ON CONFLICT(id) DO UPDATE SET category_id=excluded.category_id,title=excluded.title,description=excluded.description,milestone_id=excluded.milestone_id,is_required=excluded.is_required,acceptance_criteria_json=excluded.acceptance_criteria_json,upstream_references_json=excluded.upstream_references_json,active=1,updated_at=unixepoch()`).bind(chunk)),
		db.prepare("INSERT OR IGNORE INTO roadmap_feature_status (feature_id,scenario,state,updated_at) SELECT id,'actual','planned',unixepoch() FROM roadmap_features WHERE active=1"),
		db.prepare("INSERT INTO roadmap_catalog_imports (catalog_hash,catalog_version,source_revision,feature_count,imported_by,imported_at) VALUES (?,?,?,?,?,unixepoch())").bind(catalogHash, catalog.catalogVersion, catalog.source.reviewedMasterRevision ?? catalog.source.initialResearchRevision, catalog.features.length, identity.collaboratorId),
		db.prepare("INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at) VALUES (?,NULL,?,'catalog.imported',?,unixepoch())")
			.bind(id(), identity.collaboratorId, JSON.stringify({ catalogVersion: catalog.catalogVersion, catalogHash, added, changed, removed })),
	];
	await db.batch(statements);
	cachedRoadmap = null;
	return { imported: true, catalogHash, featureCount: catalog.features.length, changes: { added: added.length, changed: changed.length, retired: removed.length } };
}

async function dashboardApi(request: Request, env: Env) {
	const db = env.rustkore_db, url = new URL(request.url), path = url.pathname;
	if (await anonymousRateLimited(request, env, "web-api")) return json({ error: "Rate limit exceeded" }, 429, { "retry-after": "60" });
	const scenario: "actual" | "demo" = url.searchParams.get("scenario") === "demo" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname) ? "demo" : "actual";
	if (path === "/api/roadmap" && request.method === "GET") {
		if (url.searchParams.get("scenario") === "demo" && scenario !== "demo") return json({ error: "The demonstration scenario is available only in local development" }, 403);
		const data = await publicRoadmap(db, scenario);
		return json(data, 200, { "cache-control": scenario === "demo" ? "no-store" : "public, max-age=15, stale-while-revalidate=15" });
	}
	if (path === "/api/roadmap/features" && request.method === "GET") {
		if (url.searchParams.get("scenario") === "demo" && scenario !== "demo") return json({ error: "The demonstration scenario is available only in local development" }, 403);
		const page = await publicRoadmapFeatures(db, url, scenario);
		return "error" in page ? json(page, 400) : json(page, 200, { "cache-control": scenario === "demo" ? "no-store" : "public, max-age=15, stale-while-revalidate=15" });
	}
	if (path === "/api/dashboard" && request.method === "GET") return json(await publicDashboard(db), 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" });
	if (path === "/api/activity" && request.method === "GET") return json(await publicActivityPage(db, url), 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" });
	if (path === "/api/contributions" && request.method === "GET") return json(await publicContributionPage(db, url), 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" });
	if (path === "/api/reservations" && request.method === "GET") return json(await publicReservationPage(db, url), 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" });
	if (path === "/api/ranking" && request.method === "GET") return json(await publicRankingPage(db, url), 200, { "cache-control": "public, max-age=30, stale-while-revalidate=30" });
	if (path === "/api/tasks" && request.method === "GET") return json(await publicTaskPage(db, url), 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" });
	const publicTaskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
	if (publicTaskMatch && request.method === "GET") {
		const task = await publicTaskDetail(db, decodeURIComponent(publicTaskMatch[1]));
		return task ? json(task, 200, { "cache-control": "public, max-age=5, stale-while-revalidate=5" }) : json({ error: "Task not found" }, 404);
	}
	const publicContributorMatch = path.match(/^\/api\/contributors\/([^/]+)$/);
	if (publicContributorMatch && request.method === "GET") {
		const profile = await publicContributorProfile(db, decodeURIComponent(publicContributorMatch[1]));
		return profile ? json(profile, 200, { "cache-control": "public, max-age=30, stale-while-revalidate=60" }) : json({ error: "Contributor not found" }, 404);
	}
	if (path === "/api/me" && request.method === "GET") {
		const identity = await getWebIdentity(request, db, env);
		if (!identity) return json({ authenticated: false });
		const personal = await db.prepare(`SELECT
			(SELECT COUNT(*) FROM agents WHERE collaborator_id=?) AS agents,
			(SELECT COUNT(*) FROM tokens WHERE collaborator_id=? AND revoked_at IS NULL) AS activeCredentials,
			(SELECT COUNT(*) FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id WHERE a.collaborator_id=? AND t.status='claimed' AND t.lease_until>unixepoch()) AS reservations,
			(SELECT COUNT(*) FROM submissions s JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=?) AS submissions,
			(SELECT COUNT(*) FROM integrations i JOIN submissions s ON s.id=i.submission_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=?) AS integrated,
			(SELECT COUNT(*) FROM reviews WHERE reviewer_id=?) AS reviews,
			(SELECT json_group_array(json_object('id',t.id,'title',t.title,'module',t.module,'leaseUntil',t.lease_until)) FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id WHERE a.collaborator_id=? AND t.status='claimed' AND t.lease_until>unixepoch()) AS reservationJson,
			(SELECT json_group_array(json_object('id',s.id,'taskId',t.id,'title',t.title,'module',t.module,'status',s.status,'createdAt',s.created_at,'pullRequestUrl',s.pull_request_url)) FROM submissions s JOIN tasks t ON t.id=s.task_id JOIN agents a ON a.id=s.agent_id WHERE a.collaborator_id=? ORDER BY s.created_at DESC LIMIT 25) AS submissionJson,
			(SELECT json_group_array(json_object('id',r.id,'code',r.code,'rationale',r.rationale,'awardedAt',r.awarded_at)) FROM collaborator_recognitions r WHERE r.collaborator_id=? ORDER BY r.awarded_at DESC) AS recognitionJson`)
			.bind(identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId, identity.collaboratorId).first<any>();
		const parseJson = (value: unknown) => { try { return JSON.parse(String(value ?? "[]")); } catch { return []; } };
		return json({ authenticated: true, collaboratorId: identity.collaboratorId, githubLogin: identity.githubLogin, name: identity.name,
			avatarUrl: identity.avatarUrl, isAdmin: identity.isAdmin, reviewerEnabled: identity.reviewerEnabled, csrfToken: parseCookies(request).rk_csrf ?? "",
			personal: { agents: personal?.agents ?? 0, activeCredentials: personal?.activeCredentials ?? 0, reservations: personal?.reservations ?? 0, submissions: personal?.submissions ?? 0, integrated: personal?.integrated ?? 0, reviews: personal?.reviews ?? 0,
				reservationsList: parseJson(personal?.reservationJson), submissionsList: parseJson(personal?.submissionJson), recognitions: parseJson(personal?.recognitionJson) } }, 200, { "cache-control": "no-store" });
	}
	if (path === "/api/logout" && request.method === "POST") {
		const identity = await getWebIdentity(request, db, env);
		if (!identity) return json({ loggedOut: true });
		await requireWebWrite(request, identity, db);
		const session = parseCookies(request).rk_session!;
		await db.prepare("DELETE FROM web_sessions WHERE session_hash=?").bind(await sha256(session)).run();
		const headers = new Headers({ "cache-control": "no-store" });
		headers.append("set-cookie", cookie("rk_session", "", request, 0));
		headers.append("set-cookie", cookie("rk_csrf", "", request, 0));
		return json({ loggedOut: true }, 200, headers);
	}
	const identity = await getWebIdentity(request, db, env);
	if (!identity) return json({ error: "Authentication required" }, 401, { "cache-control": "no-store" });
	if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) await requireWebWrite(request, identity, db);
	if (path.startsWith("/api/admin/roadmap/") && !identity.isAdmin) return json({ error: "Maintainer access required" }, 403);
	if (path === "/api/admin/roadmap/import" && request.method === "POST") {
		try { return json(await importRoadmapCatalog(db, await request.json<any>(), identity)); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "Roadmap catalog import failed" }, 400); }
	}
	if (path === "/api/admin/roadmap/history" && request.method === "GET") {
		const limit = Math.max(1, Math.min(25, Number(url.searchParams.get("limit") ?? 25) || 25));
		let cursor: { createdAt: number; id: string } | null = null;
		if (url.searchParams.has("cursor")) { try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { return json({ error: "Invalid roadmap history cursor" }, 400); } }
		if (cursor && (!Number.isInteger(cursor.createdAt) || typeof cursor.id !== "string")) return json({ error: "Invalid roadmap history cursor" }, 400);
		const featureId = url.searchParams.get("featureId"), rows = await db.prepare(`SELECT h.id,h.feature_id AS featureId,h.action,h.details_json AS detailsJson,h.created_at AS createdAt,
			c.github_login AS actor,f.title AS featureTitle FROM roadmap_change_history h LEFT JOIN collaborators c ON c.id=h.actor_id LEFT JOIN roadmap_features f ON f.id=h.feature_id
			WHERE h.scenario='actual' AND (? IS NULL OR h.feature_id=?) AND (? IS NULL OR h.created_at<? OR (h.created_at=? AND h.id<?))
			ORDER BY h.created_at DESC,h.id DESC LIMIT ?`).bind(featureId, featureId, cursor ? 1 : null, cursor?.createdAt ?? 0, cursor?.createdAt ?? 0, cursor?.id ?? "", limit + 1).all<any>();
		const hasMore = rows.results.length > limit, items = rows.results.slice(0, limit), last = items.at(-1);
		return json({ items: items.map((item: any) => { try { return { ...item, details: JSON.parse(item.detailsJson) }; } catch { return { ...item, details: {} }; } }), nextCursor: hasMore && last ? btoa(JSON.stringify({ createdAt: last.createdAt, id: last.id })) : null }, 200, { "cache-control": "no-store" });
	}
	const acceptanceMatch = path.match(/^\/api\/admin\/roadmap\/acceptance\/([^/]+)$/);
	if (acceptanceMatch && request.method === "PATCH") {
		const criterionId = decodeURIComponent(acceptanceMatch[1]), body = await request.json<any>();
		if (!(["planned", "testing", "verified"] as string[]).includes(body.state) || Object.keys(body).some((key) => !["state", "evidenceUrl", "reason"].includes(key))) return json({ error: "Set a supported release acceptance state, evidenceUrl, and reason" }, 400);
		if (typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.length > 800) return json({ error: "Provide a verification or invalidation reason (8–800 characters)" }, 400);
		const current = await db.prepare("SELECT id,milestone_id AS milestoneId,description,state,evidence_url AS evidenceUrl FROM release_acceptance_criteria WHERE id=?").bind(criterionId).first<any>();
		if (!current) return json({ error: "Release acceptance criterion not found" }, 404);
		if (current.state === "verified" && body.state === "planned") return json({ error: "Invalidate a verified criterion to testing before returning it to planned" }, 409);
		let evidenceUrl: string | null = body.evidenceUrl == null || body.evidenceUrl === "" ? null : text(body.evidenceUrl, "evidenceUrl", 2048);
		if (body.state === "verified") {
			if (!evidenceUrl) return json({ error: "A public validation evidence URL is required before verification" }, 409);
			try { const parsed = new URL(evidenceUrl); if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname.includes(".") || parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost") || parsed.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname.startsWith("[")) throw new Error(); evidenceUrl = parsed.toString(); }
			catch { return json({ error: "Evidence URL must use a public HTTPS hostname without embedded credentials" }, 400); }
			if (!identity.githubLogin) return json({ error: "A linked maintainer GitHub identity is required" }, 403);
		}
		if (current.state === body.state && current.evidenceUrl === evidenceUrl) return json({ updated: false, unchanged: true, criterionId });
		const changeId = id(), ts = now(), verified = body.state === "verified";
		const oldValue = { state: current.state, evidenceUrl: current.evidenceUrl };
		const newValue = { state: body.state, evidenceUrl };
		const result = await db.batch([
			db.prepare(`UPDATE release_acceptance_criteria SET state=?,evidence_url=?,verified_by=?,verified_at=?,updated_by=?,updated_at=?,change_reason=?,last_change_id=?
				WHERE id=? AND state=? AND (evidence_url IS ? OR evidence_url=?) RETURNING id`)
				.bind(body.state, evidenceUrl, verified ? identity.collaboratorId : null, verified ? ts : null, identity.collaboratorId, ts, body.reason.trim(), changeId, criterionId, current.state, current.evidenceUrl, current.evidenceUrl),
			db.prepare(`INSERT INTO release_acceptance_history (id,criterion_id,actor_id,action,previous_json,current_json,reason,created_at)
				SELECT ?,id,?,?,?,?,?,? FROM release_acceptance_criteria WHERE id=? AND last_change_id=?`)
				.bind(changeId, identity.collaboratorId, verified ? "acceptance.verified" : body.state === "testing" && current.state === "verified" ? "acceptance.invalidated" : "acceptance.updated", JSON.stringify(oldValue), JSON.stringify(newValue), body.reason.trim(), ts, criterionId, changeId),
			db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,NULL,?,?,json_object('criterionId',?,'milestoneId',?,'from',?,'to',?,'reason',?),?,'actual' WHERE EXISTS(SELECT 1 FROM release_acceptance_criteria WHERE id=? AND last_change_id=?)`)
				.bind(id(), identity.collaboratorId, verified ? "acceptance.verified" : body.state === "testing" && current.state === "verified" ? "acceptance.invalidated" : "acceptance.updated", criterionId, current.milestoneId, current.state, body.state, body.reason.trim(), ts, criterionId, changeId),
		]);
		if (!result[0].results?.length) return json({ error: "Release acceptance criterion changed concurrently; reload and retry" }, 409);
		cachedRoadmap = null;
		return json({ updated: true, criterionId, state: body.state, verifiedBy: verified ? identity.githubLogin : null, verifiedAt: verified ? ts : null });
	}
	const roadmapFeatureMatch = path.match(/^\/api\/admin\/roadmap\/features\/([^/]+)$/);
	if (roadmapFeatureMatch && request.method === "PATCH") {
		const featureId = decodeURIComponent(roadmapFeatureMatch[1]), body = await request.json<any>(), state = body.state;
		if (!(["planned", "developing", "testing", "verified"] as string[]).includes(state)) return json({ error: "Unknown feature state" }, 400);
		if (Object.keys(body).some((key) => !["state", "reason"].includes(key))) return json({ error: "Unsupported roadmap state field" }, 400);
		if (typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.length > 800) return json({ error: "Provide a verification or invalidation reason (8–800 characters)" }, 400);
		const current = await db.prepare(`SELECT f.id,s.state FROM roadmap_features f LEFT JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario='actual'
			WHERE f.id=? AND f.active=1`).bind(featureId).first<any>();
		if (!current) return json({ error: "Active feature not found" }, 404);
		if ((current.state ?? "planned") === state) return json({ updated: false, unchanged: true, featureId, state });
		if (state === "verified") {
			const evidence = await db.prepare("SELECT 1 AS present FROM roadmap_feature_evidence WHERE feature_id=? AND scenario='actual' AND is_valid=1 LIMIT 1").bind(featureId).first();
			if (!evidence) return json({ error: "A feature needs valid public validation evidence before verification" }, 409);
		}
		const changeId = id(), ts = now(), oldState = current.state ?? "planned";
		const result = await db.batch([
			db.prepare(`UPDATE roadmap_feature_status SET state=?,updated_by=?,updated_at=?,verified_by=?,verified_at=?,last_change_id=?,change_reason=?
				WHERE feature_id=? AND scenario='actual' AND state=? AND EXISTS (SELECT 1 FROM roadmap_features WHERE id=? AND active=1) RETURNING feature_id`)
				.bind(state, identity.collaboratorId, ts, state === "verified" ? identity.collaboratorId : null, state === "verified" ? ts : null, changeId, body.reason.trim(), featureId, oldState, featureId),
			db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,?,?,?,json_object('from',?,'to',?,'reason',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_status WHERE feature_id=? AND scenario='actual' AND last_change_id=?)`)
				.bind(changeId, featureId, identity.collaboratorId, state === "verified" ? "feature.verified" : oldState === "verified" ? "feature.invalidated" : "feature.state_changed", oldState, state, body.reason.trim(), ts, featureId, changeId),
		]);
		if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "Feature state changed concurrently; reload and retry" }, 409);
		cachedRoadmap = null;
		return json({ updated: true, featureId, state });
	}
	const roadmapTaskMatch = path.match(/^\/api\/admin\/roadmap\/features\/([^/]+)\/tasks(?:\/([^/]+))?$/);
	if (roadmapTaskMatch && (request.method === "POST" || request.method === "DELETE")) {
		const featureId = decodeURIComponent(roadmapTaskMatch[1]), taskId = decodeURIComponent(roadmapTaskMatch[2] ?? String((await request.json<any>()).taskId ?? ""));
		if (!taskId || taskId.length > 100) return json({ error: "Provide a valid task ID" }, 400);
		const changeId = id(), ts = now();
		if (request.method === "POST") {
			const linkId = id(), result = await db.batch([
				db.prepare(`INSERT INTO roadmap_feature_tasks (id,feature_id,task_id,scenario,linked_by,linked_at,active,updated_by,updated_at,last_change_id)
					SELECT ?,f.id,t.id,'actual',?,?,1,?,?,? FROM roadmap_features f JOIN tasks t ON t.id=? WHERE f.id=? AND f.active=1
					ON CONFLICT(feature_id,task_id,scenario) DO UPDATE SET active=1,linked_by=excluded.linked_by,linked_at=excluded.linked_at,updated_by=excluded.updated_by,updated_at=excluded.updated_at,last_change_id=excluded.last_change_id WHERE roadmap_feature_tasks.active=0`)
					.bind(linkId, identity.collaboratorId, ts, identity.collaboratorId, ts, changeId, taskId, featureId),
				db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
					SELECT ?,?,?, 'feature.task_linked',json_object('taskId',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_tasks WHERE feature_id=? AND task_id=? AND scenario='actual' AND active=1 AND last_change_id=?)`).bind(changeId, featureId, identity.collaboratorId, taskId, ts, featureId, taskId, changeId),
			]);
			if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "Task or feature was not found, or this task is already linked" }, 409);
			return json({ linked: true, featureId, taskId }, 201);
		}
		const existing = await db.prepare("SELECT id FROM roadmap_feature_tasks WHERE feature_id=? AND task_id=? AND scenario='actual' AND active=1").bind(featureId, taskId).first<any>();
		if (!existing) return json({ linked: false, unchanged: true });
		const result = await db.batch([
			db.prepare("UPDATE roadmap_feature_tasks SET active=0,updated_by=?,updated_at=?,last_change_id=? WHERE id=? AND active=1").bind(identity.collaboratorId, ts, changeId, existing.id),
			db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,?,?, 'feature.task_unlinked',json_object('taskId',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_tasks WHERE id=? AND active=0 AND last_change_id=?)`).bind(changeId, featureId, identity.collaboratorId, taskId, ts, existing.id, changeId),
		]);
		return json({ linked: false, featureId, taskId, changed: (result[0].meta.changes ?? 0) === 1 });
	}
	const roadmapEvidenceMatch = path.match(/^\/api\/admin\/roadmap\/evidence\/([^/]+)$/);
	const roadmapEvidenceCreateMatch = path.match(/^\/api\/admin\/roadmap\/features\/([^/]+)\/evidence$/);
	if (roadmapEvidenceCreateMatch && request.method === "POST") {
		const featureId = decodeURIComponent(roadmapEvidenceCreateMatch[1]), body = await request.json<any>();
		if (Object.keys(body).some((key) => !["url", "label", "description"].includes(key))) return json({ error: "Unsupported evidence field" }, 400);
		let evidenceUrl: URL; try { evidenceUrl = new URL(text(body.url, "url", 2048)); } catch { return json({ error: "Evidence URL must be a valid public HTTPS URL" }, 400); }
		if (evidenceUrl.protocol !== "https:" || evidenceUrl.username || evidenceUrl.password || !evidenceUrl.hostname.includes(".") || evidenceUrl.hostname === "localhost" || evidenceUrl.hostname.endsWith(".localhost") || evidenceUrl.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(evidenceUrl.hostname) || evidenceUrl.hostname.startsWith("[")) return json({ error: "Evidence URL must use a public HTTPS hostname without embedded credentials" }, 400);
		const label = text(body.label, "label", 160), description = text(body.description, "description", 800), evidenceId = id(), changeId = id(), ts = now();
		const result = await db.batch([
			db.prepare(`INSERT INTO roadmap_feature_evidence (id,feature_id,scenario,url,label,description,is_valid,created_by,created_at,last_change_id)
				SELECT ?,id,'actual',?,?,?,1,?,?,? FROM roadmap_features WHERE id=? AND active=1`).bind(evidenceId, evidenceUrl.toString(), label, description, identity.collaboratorId, ts, changeId, featureId),
			db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,?,?, 'feature.evidence_added',json_object('evidenceId',?,'label',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_evidence WHERE id=?)`).bind(changeId, featureId, identity.collaboratorId, evidenceId, label, ts, evidenceId),
		]);
		if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "Active feature not found" }, 404);
		return json({ evidenceId, featureId }, 201);
	}
	if (roadmapEvidenceMatch && request.method === "PATCH") {
		const evidenceId = decodeURIComponent(roadmapEvidenceMatch[1]), body = await request.json<any>();
		if (typeof body.valid !== "boolean" || typeof body.reason !== "string" || body.reason.trim().length < 8 || body.reason.length > 800 || Object.keys(body).some((key) => !["valid", "reason"].includes(key))) return json({ error: "Set valid and provide a reason (8–800 characters)" }, 400);
		const evidence = await db.prepare("SELECT feature_id AS featureId,is_valid AS valid FROM roadmap_feature_evidence WHERE id=? AND scenario='actual'").bind(evidenceId).first<any>();
		if (!evidence) return json({ error: "Roadmap evidence not found" }, 404);
		if (Boolean(evidence.valid) === body.valid) return json({ updated: false, unchanged: true });
		const changeId = id(), ts = now(), statusChangeId = id();
		const batch = [
			db.prepare("UPDATE roadmap_feature_evidence SET is_valid=?,invalidated_by=?,invalidated_at=?,last_change_id=? WHERE id=? AND is_valid=?").bind(body.valid ? 1 : 0, body.valid ? null : identity.collaboratorId, body.valid ? null : ts, changeId, evidenceId, evidence.valid ? 1 : 0),
			db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,?,?,?,json_object('evidenceId',?,'valid',?,'reason',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_evidence WHERE id=? AND last_change_id=?)`)
				.bind(changeId, evidence.featureId, identity.collaboratorId, body.valid ? "feature.evidence_revalidated" : "feature.evidence_invalidated", evidenceId, body.valid, body.reason.trim(), ts, evidenceId, changeId),
		];
		if (!body.valid) {
			batch.push(db.prepare(`UPDATE roadmap_feature_status SET state='testing',updated_by=?,updated_at=?,verified_by=NULL,verified_at=NULL,last_change_id=?,change_reason=?
				WHERE feature_id=? AND scenario='actual' AND state='verified' AND NOT EXISTS(SELECT 1 FROM roadmap_feature_evidence WHERE feature_id=? AND scenario='actual' AND is_valid=1)`)
				.bind(identity.collaboratorId, ts, statusChangeId, `Validation evidence invalidated: ${body.reason.trim()}`, evidence.featureId, evidence.featureId));
			batch.push(db.prepare(`INSERT INTO roadmap_change_history (id,feature_id,actor_id,action,details_json,created_at,scenario)
				SELECT ?,?,?, 'feature.invalidated',json_object('from','verified','to','testing','reason',?),?,'actual' WHERE EXISTS(SELECT 1 FROM roadmap_feature_status WHERE feature_id=? AND scenario='actual' AND last_change_id=?)`)
				.bind(statusChangeId, evidence.featureId, identity.collaboratorId, body.reason.trim(), ts, evidence.featureId, statusChangeId));
		}
		const result = await db.batch(batch);
		if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "Evidence changed concurrently; reload and retry" }, 409);
		cachedRoadmap = null;
		return json({ updated: true, featureId: evidence.featureId, valid: body.valid });
	}
	if (path === "/api/tokens" && request.method === "GET") {
		const rows = await db.prepare(`SELECT t.id AS tokenId,t.role,t.created_at AS createdAt,t.revoked_at AS revokedAt,a.name AS agentName
			FROM tokens t LEFT JOIN agents a ON a.id=t.agent_id WHERE t.collaborator_id=? ORDER BY t.created_at DESC LIMIT 100`).bind(identity.collaboratorId).all();
		return json({ tokens: rows.results }, 200, { "cache-control": "no-store" });
	}
	if (path === "/api/tokens" && request.method === "POST") {
		const body = await request.json<any>(), role = body.role ?? "collaborator";
		if (!(["collaborator", "reviewer", "admin"] as string[]).includes(role)) return json({ error: "Unknown token role" }, 400);
		if (role === "reviewer" && !identity.isAdmin && !identity.reviewerEnabled) return json({ error: "Reviewer role is not enabled for this GitHub account" }, 403);
		if (role === "admin" && !identity.isAdmin) return json({ error: "Administrator role is not enabled for this GitHub account" }, 403);
		const count = await db.prepare("SELECT COUNT(*) AS count FROM tokens WHERE collaborator_id=? AND revoked_at IS NULL").bind(identity.collaboratorId).first<any>();
		if (Number(count?.count ?? 0) >= 20) return json({ error: "Revoke an unused token before creating another (limit: 20 active tokens)" }, 409);
		try {
			const created = await issueAgentCredential(db, identity.collaboratorId, text(body.name, "name", 120), role);
			return json(created, 201, { "cache-control": "no-store" });
		} catch (error) {
			const message = error instanceof Error ? error.message : "";
			return /UNIQUE|unique constraint|active token limit/i.test(message) ? json({ error: "The agent name is in use or the 20 active-token limit was reached" }, 409) : json({ error: "Credential storage is temporarily unavailable; retry the request" }, 503, { "retry-after": "30" });
		}
	}
	const tokenMatch = path.match(/^\/api\/tokens\/([^/]+)$/);
	if (tokenMatch && request.method === "DELETE") {
		const result = await db.prepare("UPDATE tokens SET revoked_at=unixepoch() WHERE id=? AND collaborator_id=? AND revoked_at IS NULL")
			.bind(decodeURIComponent(tokenMatch[1]), identity.collaboratorId).run();
		return json({ revoked: (result.meta.changes ?? 0) === 1 });
	}
	if (path.startsWith("/api/admin/") && !identity.isAdmin) return json({ error: "Administrator access required" }, 403);
	if (path === "/api/admin/context" && request.method === "GET") {
		const row = await db.prepare("SELECT content,updated_at AS updatedAt FROM project_context WHERE id='default'").first<any>();
		return json(row ?? { content: "", updatedAt: null }, 200, { "cache-control": "no-store" });
	}
	if (path === "/api/admin/context" && request.method === "PUT") {
		const body = await request.json<any>();
		if (typeof body.content !== "string" || body.content.length > 20_000) return json({ error: "content must be text up to 20000 characters" }, 400);
		await db.prepare(`INSERT INTO project_context (id,content,updated_at,updated_by) VALUES ('default',?,unixepoch(),?)
			ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
			.bind(body.content, identity.collaboratorId).run();
		cachedContext = null;
		return json({ updated: true });
	}
	if (path === "/api/admin/collaborators" && request.method === "GET") {
		const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50));
		let cursor: { login: string; id: string } | null = null;
		if (url.searchParams.has("cursor")) {
			try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { return json({ error: "Invalid cursor" }, 400); }
			if (!cursor || typeof cursor.login !== "string" || typeof cursor.id !== "string") return json({ error: "Invalid cursor" }, 400);
		}
		const rows = await db.prepare(`SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,c.reviewer_enabled AS reviewerEnabled,
			c.suspended_at AS suspendedAt,c.created_at AS createdAt,COUNT(DISTINCT i.id) AS integratedCount,
			(SELECT COUNT(*) FROM reviews r WHERE r.reviewer_id=c.id) AS reviewCount,
			(SELECT json_group_array(json_object('id',r.id,'code',r.code,'rationale',r.rationale,'awardedAt',r.awarded_at)) FROM collaborator_recognitions r WHERE r.collaborator_id=c.id ORDER BY r.awarded_at DESC) AS recognitionsJson
			FROM collaborators c LEFT JOIN agents a ON a.collaborator_id=c.id LEFT JOIN submissions s ON s.agent_id=a.id
			LEFT JOIN integrations i ON i.submission_id=s.id WHERE (? IS NULL OR c.github_login>? OR (c.github_login=? AND c.id>?))
			AND c.github_user_id IS NOT NULL GROUP BY c.id ORDER BY c.github_login ASC,c.id ASC LIMIT ?`)
			.bind(cursor ? 1 : null, cursor?.login ?? "", cursor?.login ?? "", cursor?.id ?? "", limit + 1).all<any>();
		const hasMore = rows.results.length > limit, page = rows.results.slice(0, limit), last = page.at(-1);
		return json({ collaborators: page.map((person: any) => { try { return { ...person, recognitions: JSON.parse(person.recognitionsJson ?? "[]") }; } catch { return { ...person, recognitions: [] }; } }), nextCursor: hasMore && last ? btoa(JSON.stringify({ login: last.login, id: last.id })) : null });
	}
	const collaboratorMatch = path.match(/^\/api\/admin\/collaborators\/([^/]+)$/);
	if (collaboratorMatch && request.method === "PATCH") {
		const body = await request.json<any>(), collaboratorId = decodeURIComponent(collaboratorMatch[1]);
		if (body.reviewerEnabled === undefined && body.suspended === undefined) return json({ error: "Set reviewerEnabled or suspended" }, 400);
		if (body.reviewerEnabled !== undefined && typeof body.reviewerEnabled !== "boolean") return json({ error: "reviewerEnabled must be a boolean" }, 400);
		if (body.suspended !== undefined && typeof body.suspended !== "boolean") return json({ error: "suspended must be a boolean" }, 400);
		if (body.suspended === true && collaboratorId === identity.collaboratorId) return json({ error: "An administrator cannot suspend their own account" }, 409);
		const statements: D1PreparedStatement[] = [];
		if (body.reviewerEnabled !== undefined) statements.push(db.prepare("UPDATE collaborators SET reviewer_enabled=? WHERE id=? AND github_user_id IS NOT NULL").bind(body.reviewerEnabled ? 1 : 0, collaboratorId));
		if (body.suspended !== undefined) {
			statements.push(db.prepare("UPDATE collaborators SET suspended_at=? WHERE id=? AND github_user_id IS NOT NULL").bind(body.suspended ? now() : null, collaboratorId));
			if (body.suspended) statements.push(db.prepare("UPDATE tokens SET revoked_at=unixepoch() WHERE collaborator_id=? AND revoked_at IS NULL").bind(collaboratorId));
			if (body.suspended) statements.push(db.prepare("DELETE FROM web_sessions WHERE collaborator_id=?").bind(collaboratorId));
		}
		await db.batch(statements);
		return json({ updated: true });
	}
	const recognitionMatch = path.match(/^\/api\/admin\/collaborators\/([^/]+)\/recognitions$/);
	if (recognitionMatch && request.method === "POST") {
		const collaboratorId = decodeURIComponent(recognitionMatch[1]), body = await request.json<any>();
		const titleByCode: Record<string, string> = { builder: "Builder", reviewer: "Reviewer", specialist: "Specialist", architect: "Architect", guardian: "Guardian", maintainer: "Maintainer" };
		if (typeof body.code !== "string" || !titleByCode[body.code]) return json({ error: "Choose a supported recognition" }, 400);
		try {
			const recognition = await db.prepare(`INSERT INTO collaborator_recognitions (id,collaborator_id,code,rationale,awarded_by,awarded_at)
				SELECT ?,id,?,?,?,unixepoch() FROM collaborators WHERE id=? AND github_user_id IS NOT NULL RETURNING id`)
				.bind(id(), body.code, text(body.rationale, "rationale", 2000), identity.collaboratorId, collaboratorId).first<any>();
			if (!recognition) return json({ error: "Contributor not found" }, 404);
			invalidateDashboard();
			return json({ recognition: { id: recognition.id, code: body.code, title: titleByCode[body.code] } }, 201);
		} catch (error) {
			if (/UNIQUE|unique constraint/i.test(error instanceof Error ? error.message : "")) return json({ error: "This recognition already exists for the contributor" }, 409);
			throw error;
		}
	}
	if (path === "/api/admin/tasks" && request.method === "POST") {
		const actor: Identity = { id: identity.collaboratorId, role: "admin", collaboratorId: identity.collaboratorId, agentId: null, name: identity.name, githubUserId: identity.githubUserId, githubLogin: identity.githubLogin };
		try { return json(await createTask(db, await request.json<any>(), actor), 201); }
		catch (error) { return json({ error: error instanceof Error ? error.message : "Task could not be created" }, 400); }
	}
	if (path === "/api/admin/submissions" && request.method === "GET") {
		const rows = await db.prepare(`SELECT s.id,s.task_id AS taskId,t.title AS taskTitle,s.commit_sha AS commitSha,
			s.pull_request_url AS pullRequestUrl,s.summary,s.created_at AS submittedAt,s.status,
			c.github_login AS contributor,a.name AS agentName,r.decision AS reviewDecision,
			i.merge_commit_sha AS mergeCommitSha,i.integrated_at AS integratedAt
			FROM submissions s JOIN tasks t ON t.id=s.task_id JOIN agents a ON a.id=s.agent_id
			JOIN collaborators c ON c.id=a.collaborator_id LEFT JOIN reviews r ON r.submission_id=s.id
			LEFT JOIN integrations i ON i.submission_id=s.id ORDER BY s.created_at DESC,s.id DESC LIMIT 100`).all<any>();
		return json({ submissions: rows.results }, 200, { "cache-control": "no-store" });
	}
	const taskMatch = path.match(/^\/api\/admin\/tasks\/([^/]+)$/);
	if (taskMatch && request.method === "PATCH") {
		const taskId = decodeURIComponent(taskMatch[1]), body = await request.json<any>(), ts = now(), sets: string[] = [], values: unknown[] = [];
		const fields: Record<string, string> = { title: "title", description: "description", acceptanceCriteria: "acceptance_criteria", module: "module" };
		if (Object.keys(body).some((key) => ![...Object.keys(fields), "priority", "complexity", "dependencies"].includes(key))) return json({ error: "Unsupported task field" }, 400);
		for (const [field, column] of Object.entries(fields)) if (body[field] !== undefined) { sets.push(`${column}=?`); values.push(text(body[field], field, field === "title" ? 200 : field === "module" ? 100 : 4000)); }
		if (body.priority !== undefined) { if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100) return json({ error: "priority must be an integer from 0 to 100" }, 400); sets.push("priority=?"); values.push(body.priority); }
		if (body.complexity !== undefined) {
			const complexity = body.complexity === "" ? null : body.complexity;
			if (complexity !== null && !["small", "medium", "large", "extra_large"].includes(complexity)) return json({ error: "Invalid task complexity" }, 400);
			sets.push("complexity=?"); values.push(complexity);
		}
		let dependencies: string[] | undefined;
		if (body.dependencies !== undefined) {
			if (!Array.isArray(body.dependencies) || body.dependencies.length > 100 || body.dependencies.some((value: unknown) => typeof value !== "string")) return json({ error: "dependencies must be an array of at most 100 task IDs" }, 400);
			const dependencyIds = body.dependencies.map((value: unknown) => text(value, "dependency id", 80)) as string[];
			dependencies = [...new Set<string>(dependencyIds)];
			if (dependencies?.includes(taskId)) return json({ error: "A task cannot depend on itself" }, 400);
		}
		if (!sets.length && dependencies === undefined) return json({ error: "Provide a task field to update" }, 400);
		sets.push("updated_at=?"); values.push(ts);
		const statements: D1PreparedStatement[] = [db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=? AND status='open' RETURNING id`).bind(...values, taskId)];
		if (dependencies !== undefined) {
			statements.push(db.prepare("DELETE FROM task_dependencies WHERE task_id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='open')").bind(taskId, taskId));
			for (const dependencyId of dependencies) statements.push(db.prepare("INSERT INTO task_dependencies (task_id,depends_on_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='open')").bind(taskId, dependencyId, taskId));
		}
		statements.push(db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
			SELECT ?,id,?,'task.updated',?,? FROM tasks WHERE id=? AND status='open' AND updated_at=?`)
			.bind(id(), identity.collaboratorId, JSON.stringify({ fields: Object.keys(fields).filter((key) => body[key] !== undefined).concat(body.priority !== undefined ? ["priority"] : [], body.complexity !== undefined ? ["complexity"] : [], body.dependencies !== undefined ? ["dependencies"] : []) }), ts, taskId, ts));
		let result: D1Result[];
		try { result = await db.batch(statements); }
		catch (error) {
			const message = error instanceof Error ? error.message : "";
			if (/task dependency cycle|FOREIGN KEY constraint|UNIQUE constraint/i.test(message)) return json({ error: "Dependency update would create an invalid task graph" }, 400);
			throw error;
		}
		if (!result[0].results?.length) return json({ error: "Task not found or is no longer open" }, 409);
		invalidateDashboard();
		return json({ updated: true, taskId });
	}
	const integrateMatch = path.match(/^\/api\/admin\/submissions\/([^/]+)\/integrate$/);
	if (integrateMatch && request.method === "POST") {
		const submissionId = decodeURIComponent(integrateMatch[1]);
		const submission = await db.prepare(`SELECT s.id,s.task_id AS taskId,s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,
			s.submitted_github_user_id AS githubUserId FROM submissions s WHERE s.id=? AND s.status='accepted' AND s.pull_request_url IS NOT NULL`)
			.bind(submissionId).first<any>();
		if (!submission) return json({ error: "Only an approved submission with a pull request can be integrated" }, 409);
		try {
			await verifyGitHubSubmission(submission.commitSha, submission.pullRequestUrl, submission.githubUserId, env);
			const pullNumber = Number(new URL(submission.pullRequestUrl).pathname.split("/").at(-1));
			const pull = await githubRepositoryPath(`/pulls/${pullNumber}`, env);
			assertPullRequestRepository(pull, configuredGitHubRepository(env), submission.commitSha);
			if (pull.merged !== true || !/^[0-9a-f]{40}$/i.test(pull.merge_commit_sha ?? "")) return json({ error: "The approved pull request is not merged at the verified commit" }, 409);
			const integration = await db.prepare(`INSERT INTO integrations (id,task_id,submission_id,submitted_commit_sha,merge_commit_sha,integrated_by,integrated_at)
				SELECT ?,s.task_id,s.id,s.commit_sha,?,?,unixepoch() FROM submissions s WHERE s.id=? AND s.status='accepted' AND s.commit_sha=? AND s.pull_request_url=? RETURNING id`)
				.bind(id(), pull.merge_commit_sha.toLowerCase(), identity.collaboratorId, submissionId, submission.commitSha, submission.pullRequestUrl).first();
			if (!integration) return json({ error: "Submission changed while integration was being recorded" }, 409);
			invalidateDashboard();
			return json({ integrated: true, taskId: submission.taskId, mergeCommitSha: pull.merge_commit_sha });
		} catch (error) { return json({ error: error instanceof Error ? error.message : "GitHub could not verify the merge" }, 502); }
	}
	return json({ error: "Not found" }, 404);
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url), db = env.rustkore_db;
		if (url.pathname === "/health") return json({ name: "RustKore", status: "ok" });
		if (request.body && (Number(request.headers.get("content-length") ?? "0") > 1_000_000 || (await request.clone().arrayBuffer()).byteLength > 1_000_000)) return json({ error: "Request body exceeds 1 MB" }, 413);
		if (url.pathname === "/auth/github" && request.method === "GET") return startGitHubLogin(request, env);
		if (url.pathname === "/auth/callback" && request.method === "GET") return completeGitHubLogin(request, env);
		if (url.pathname.startsWith("/api/")) {
			try { return await dashboardApi(request, env); }
			catch (error) {
				const message = error instanceof Error ? error.message : "Request failed";
				if (message.startsWith("Forbidden:")) return json({ error: message }, 403);
				if (/D1_ERROR|SQLITE/i.test(message)) return json({ error: "Storage is temporarily unavailable; retry the request" }, 503, { "retry-after": "30" });
				if (error instanceof SyntaxError || /must be|cursor|Provide a task field|Invalid task|Invalid dependency|dependencies must|Choose a supported|rationale must|complexity/i.test(message)) return json({ error: message }, 400);
				throw error;
			}
		}
		if (url.pathname === "/mcp") return mcp(request, env);
		if (url.pathname === "/setup" && request.method === "POST") {
			if (await anonymousRateLimited(request, env, "bootstrap")) return json({ error: "Rate limit exceeded" }, 429);
			return json({ error: "Bootstrap credentials are retired. Configure a GitHub administrator allowlist and sign in with GitHub." }, 410);
		}
		const identity = await authenticate(request, env);
		if (url.pathname.startsWith("/admin/")) {
			if (!identity) return json({ error: "Unauthorized" }, 401);
			try {
				requireRole(identity, "admin");
				if (await rateLimited(identity, "admin", env)) return json({ error: "Rate limit exceeded; retry after 60 seconds" }, 429);
				if (url.pathname === "/admin/credentials" && request.method === "GET") {
					const credentials = await db.prepare(`SELECT t.id AS tokenId,t.role,t.created_at AS createdAt,t.revoked_at AS revokedAt,c.id AS collaboratorId,c.name AS collaborator,a.id AS agentId,a.name AS agent
						FROM tokens t JOIN collaborators c ON c.id=t.collaborator_id LEFT JOIN agents a ON a.id=t.agent_id ORDER BY t.created_at DESC LIMIT 200`).all();
					return json({ credentials: credentials.results });
				}
				if (url.pathname === "/admin/credentials" && request.method === "POST") {
					return json({ error: "Credentials are issued by the authenticated GitHub collaborator in the public dashboard" }, 410);
				}
				if (url.pathname.startsWith("/admin/tokens/") && request.method === "DELETE") {
					const tokenId = url.pathname.split("/").at(-1)!;
					const result = await db.prepare("UPDATE tokens SET revoked_at=? WHERE id=? AND revoked_at IS NULL").bind(now(), tokenId).run();
					return json({ revoked: (result.meta.changes ?? 0) > 0 });
				}
				if (url.pathname === "/admin/tasks" && request.method === "POST") return json(await createTask(db, await request.json(), identity), 201);
				const taskMatch = url.pathname.match(/^\/admin\/tasks\/([^/]+)$/);
				if (taskMatch && request.method === "PATCH") {
					const taskId = decodeURIComponent(taskMatch[1]), body = await request.json<any>(), ts = now(), sets: string[] = [], values: unknown[] = [];
					const allowedFields = new Set(["title", "description", "acceptanceCriteria", "priority", "dependencies"]);
					if (Object.keys(body).some((field) => !allowedFields.has(field))) throw new Error("Unsupported task field");
					for (const [field, column, limit] of [["title", "title", 200], ["description", "description", 10_000], ["acceptanceCriteria", "acceptance_criteria", 10_000]] as const) {
						if (body[field] !== undefined) { sets.push(`${column}=?`); values.push(text(body[field], field, field === "title" ? limit : 4000)); }
					}
					if (body.priority !== undefined) {
						if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100) throw new Error("priority must be an integer from 0 to 100");
						sets.push("priority=?"); values.push(body.priority);
					}
					if (!sets.length && body.dependencies === undefined) throw new Error("Provide at least one field to update");
					sets.push("updated_at=?"); values.push(ts);
					const statements = [db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=? AND status='open' RETURNING id`).bind(...values, taskId)];
					if (Array.isArray(body.dependencies)) {
						if (body.dependencies.length > 100) throw new Error("A task can have at most 100 dependencies");
						statements.push(db.prepare("DELETE FROM task_dependencies WHERE task_id=? AND EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='open' AND updated_at=?)").bind(taskId, taskId, ts));
						for (const dependency of body.dependencies) statements.push(db.prepare("INSERT INTO task_dependencies (task_id,depends_on_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM tasks WHERE id=? AND status='open' AND updated_at=?)").bind(taskId, text(dependency, "dependency id", 80), taskId, ts));
					}
					const event = Object.fromEntries(Object.entries(body).filter(([key]) => allowedFields.has(key)).map(([key, value]) => [key, key === "description" || key === "acceptanceCriteria" ? "updated" : value]));
					statements.push(db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
						SELECT ?,id,?,'task.updated',?,? FROM tasks WHERE id=? AND status='open' AND updated_at=?`).bind(id(), identity.collaboratorId, JSON.stringify(event), ts, taskId, ts));
					const result = await db.batch(statements);
					if ((result[0].meta.changes ?? 0) !== 1) return json({ error: "Task not found or is no longer open" }, 409);
					return json({ updated: true, taskId });
				}
				if (url.pathname === "/admin/context" && request.method === "PUT") {
					const body = await request.json<any>();
					await db.prepare("INSERT INTO project_context (id,content,updated_at,updated_by) VALUES ('default',?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
						.bind(text(body.content, "content", 12_000), now(), identity.collaboratorId).run();
					cachedContext = null;
					return json({ updated: true });
				}
				return json({ error: "Not found" }, 404);
			} catch (e) {
				const message = e instanceof Error ? e.message : "Request failed";
				return json({ error: message }, message.startsWith("Forbidden:") ? 403 : message.includes("cycle") ? 409 : 400);
			}
		}
		if (env.ASSETS) return env.ASSETS.fetch(request);
		if (url.pathname === "/") return json({ name: "RustKore", status: "ok", mcp: "/mcp" });
		return json({ error: "Not found" }, 404);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const started = performance.now();
		let response: Response;
		try { response = await handleFetch(request, env); }
		catch (error) { console.error(JSON.stringify({ event: "http.failure", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : "request failed" })); response = json({ error: "Internal server error" }, 500); }
		console.log(JSON.stringify({ event: "http.request", method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Math.round((performance.now() - started) * 100) / 100 }));
		return response;
	},
} satisfies ExportedHandler<Env>;
