type Role = "admin" | "collaborator" | "reviewer";
type Env = { rustkore_db: D1Database; ASSETS?: { fetch(request: Request): Promise<Response> }; API_RATE_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> }; GITHUB_REPOSITORY?: string; GITHUB_API_TOKEN?: string; GITHUB_OAUTH_CLIENT_ID?: string; GITHUB_OAUTH_CLIENT_SECRET?: string; GITHUB_OAUTH_CALLBACK_URL?: string; RUSTKORE_ADMIN_GITHUB_IDS?: string; RUSTKORE_REVIEWER_GITHUB_IDS?: string; github_api?: { fetch(request: Request): Promise<Response> }; HEARTBEAT_INTERVAL_SECONDS?: string; LEASE_DURATION_SECONDS?: string };
type Identity = { id: string; role: Role; collaboratorId: string; agentId: string | null; name: string; githubUserId: number | null; githubLogin: string | null };
type WebIdentity = { collaboratorId: string; githubUserId: number; githubLogin: string; name: string; avatarUrl: string | null; reviewerEnabled: boolean; isAdmin: boolean };

const DEFAULT_HEARTBEAT_SECONDS = 120;
const DEFAULT_LEASE_SECONDS = 600;
const LEGACY_PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const MODERN_PROTOCOL = "2026-07-28";
const rateWindows = new Map<string, { start: number; count: number }>();
let cachedContext: { content: string; updatedAt: number; expires: number } | null = null;
let cachedDashboard: { content: any; expires: number } | null = null;

const json = (body: unknown, status = 200, extraHeaders?: HeadersInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...Object.fromEntries(new Headers(extraHeaders).entries()) } });
const id = () => crypto.randomUUID();
const now = () => Math.floor(Date.now() / 1000);
const text = (v: unknown, name: string, max = 10_000): string => {
	if (typeof v !== "string" || !v.trim() || v.length > max) throw new Error(`${name} must be a non-empty string (max ${max} characters)`);
	return v.trim();
};
const optText = (v: unknown, max = 2000): string | null => v == null || v === "" ? null : text(v, "value", max);
const authHeader = (r: Request) => r.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;

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

async function githubRepositoryPath(path: string, env: Env) {
	const repository = env.GITHUB_REPOSITORY ?? "boscv/RustKore";
	if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("GitHub repository is misconfigured");
	const headers = new Headers({ accept: "application/vnd.github+json", "user-agent": "RustKore/0.1", "x-github-api-version": "2022-11-28" });
	if (env.GITHUB_API_TOKEN) headers.set("authorization", `Bearer ${env.GITHUB_API_TOKEN}`);
	const request = new Request(`https://api.github.com/repos/${repository}${path}`, { headers, signal: AbortSignal.timeout(5000) });
	const response = await githubFetch(request, env);
	if (!response.ok) throw new Error(response.status === 404 ? "Commit or pull request does not exist in the configured repository" : "GitHub validation is unavailable; submission was not saved");
	return response.json<any>();
}

async function verifyGitHubSubmission(commitSha: string, pullRequestUrl: string | null, githubUserId: number | null, env: Env) {
	const repository = env.GITHUB_REPOSITORY ?? "boscv/RustKore";
	if (!githubUserId) throw new Error("Link this MCP credential to a GitHub account before submitting work");
	if (!pullRequestUrl) throw new Error("A pull request in the configured repository is required");
	const commit = await githubRepositoryPath(`/commits/${commitSha}`, env);
	if (String(commit.sha).toLowerCase() !== commitSha.toLowerCase()) throw new Error("GitHub commit SHA does not match the submitted commit");
	let parsed: URL;
	try { parsed = new URL(pullRequestUrl); } catch { throw new Error("pullRequestUrl must be a GitHub pull request URL"); }
	const match = parsed.hostname === "github.com" && parsed.protocol === "https:" && parsed.pathname.match(new RegExp(`^/${repository.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}/pull/(\\d+)/?$`, "i"));
	if (!match || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error("pullRequestUrl must point to a pull request in the configured repository");
	const pull = await githubRepositoryPath(`/pulls/${match[1]}`, env);
	if (pull.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase() || String(pull.head?.sha).toLowerCase() !== commitSha.toLowerCase()) throw new Error("Pull request must target the configured repository and its head commit must match commitSha");
	if (Number(pull.user?.id) !== githubUserId) throw new Error("The pull request must be opened by the GitHub account linked to this MCP credential");
	if (Number(commit.author?.id) !== githubUserId) throw new Error("The submitted commit must be authored by the GitHub account linked to this MCP credential");
	return { pullRequestUrl: `https://github.com/${repository}/pull/${Number(match[1])}`, commitAuthorId: Number(commit.author.id) };
}

async function createTask(db: D1Database, input: any, actor: Identity | string) {
	const taskId = id();
	const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(100, input.priority)) : 50;
	const module = input.module == null ? "General" : text(input.module, "module", 100);
	const dependencies: string[] = Array.isArray(input.dependencies) ? input.dependencies.map((x: unknown) => text(x, "dependency id", 80)) : [];
	if (dependencies.length > 100) throw new Error("A task can have at most 100 dependencies");
	const stmts = [db.prepare(`INSERT INTO tasks (id, title, description, acceptance_criteria, priority, status, created_by, created_at, updated_at, module)
		VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`)
		.bind(taskId, text(input.title, "title", 200), text(input.description, "description", 4000), text(input.acceptanceCriteria, "acceptanceCriteria", 4000), priority, typeof actor === "string" ? actor : actor.collaboratorId, now(), now(), module)];
	for (const dep of dependencies) stmts.push(db.prepare("INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)").bind(taskId, dep));
	stmts.push(db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at)
		SELECT ?,id,?,'task.created',?,? FROM tasks WHERE id=?`).bind(id(), typeof actor === "string" ? actor : actor.collaboratorId, JSON.stringify({ title: text(input.title, "title", 200), priority, dependencies }), now(), taskId));
	await db.batch(stmts);
	return { id: taskId, title: text(input.title, "title", 200), module, description: text(input.description, "description", 4000), acceptance_criteria: text(input.acceptanceCriteria, "acceptanceCriteria", 4000), priority, status: "open", dependencies, submissions: [] };
}

async function getTask(db: D1Database, taskId: string) {
	const task = await db.prepare(`SELECT t.*, CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END AS effective_status,
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
				WHERE id=(SELECT t.id FROM tasks t WHERE (t.status='open' OR (t.status='claimed' AND t.lease_until<=unixepoch()))
				AND NOT EXISTS (SELECT 1 FROM task_dependencies d JOIN tasks parent ON parent.id=d.depends_on_id WHERE d.task_id=t.id AND parent.status!='accepted')
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
			if (row) return row;
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
			return { reviewId, decision };
		}
		case "get_progress": {
			requireRole(identity, "admin", "collaborator", "reviewer");
			const rows = await db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated'
				WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END AS status,COUNT(*) AS count
				FROM tasks t GROUP BY CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 'integrated'
				WHEN t.status='claimed' AND t.lease_until<=? THEN 'open' ELSE t.status END`).bind(now(), now()).all();
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

async function publicDashboard(db: D1Database) {
	if (cachedDashboard && cachedDashboard.expires > Date.now()) return cachedDashboard.content;
	const [summary, modules, taskRows, contributors, agents, history] = await Promise.all([
		db.prepare(`SELECT COUNT(*) AS total,
			SUM(CASE WHEN EXISTS(SELECT 1 FROM integrations i WHERE i.task_id=t.id) THEN 1 ELSE 0 END) AS integrated,
			SUM(CASE WHEN t.status='submitted' THEN 1 ELSE 0 END) AS inReview,
			SUM(CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN 1 ELSE 0 END) AS reserved,
			SUM(CASE WHEN t.status='open' OR (t.status='claimed' AND t.lease_until<=unixepoch()) THEN 1 ELSE 0 END) AS available FROM tasks t`).first<any>(),
		db.prepare(`SELECT t.module,COUNT(*) AS total,SUM(CASE WHEN i.id IS NULL THEN 0 ELSE 1 END) AS integrated
			FROM tasks t LEFT JOIN integrations i ON i.task_id=t.id GROUP BY t.module ORDER BY integrated DESC,total DESC,t.module ASC LIMIT 30`).all<any>(),
		db.prepare(`SELECT t.id,t.title,t.module,t.description,t.acceptance_criteria AS acceptanceCriteria,t.priority,t.created_at AS createdAt,
			CASE WHEN i.id IS NOT NULL THEN 'integrated' WHEN t.status='claimed' AND t.lease_until<=unixepoch() THEN 'open' ELSE t.status END AS status,
			CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN a.name END AS agentName,
			CASE WHEN t.status='claimed' AND t.lease_until>unixepoch() THEN c.github_login END AS assignee
			FROM tasks t LEFT JOIN integrations i ON i.task_id=t.id LEFT JOIN agents a ON a.id=t.assignee_agent_id LEFT JOIN collaborators c ON c.id=a.collaborator_id
			ORDER BY CASE WHEN t.status='open' THEN 0 WHEN t.status='claimed' THEN 1 WHEN t.status='submitted' THEN 2 WHEN t.status='accepted' THEN 3 ELSE 4 END,
			t.priority DESC,t.created_at ASC LIMIT 100`).all<any>(),
		db.prepare(`SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,COUNT(i.id) AS integratedCount,
			MAX(COALESCE(i.integrated_at,0)) AS lastIntegratedAt FROM collaborators c JOIN agents a ON a.collaborator_id=c.id
			JOIN submissions s ON s.agent_id=a.id JOIN integrations i ON i.submission_id=s.id
			WHERE c.suspended_at IS NULL GROUP BY c.id ORDER BY integratedCount DESC,lastIntegratedAt DESC,c.github_login ASC LIMIT 30`).all<any>(),
		db.prepare(`SELECT a.id AS agentId,a.name AS agentName,c.github_login AS login,c.avatar_url AS avatarUrl,
			t.id AS taskId,t.title,t.module,t.lease_until AS leaseUntil FROM tasks t JOIN agents a ON a.id=t.assignee_agent_id
			JOIN collaborators c ON c.id=a.collaborator_id WHERE t.status='claimed' AND t.lease_until>unixepoch()
			AND c.suspended_at IS NULL ORDER BY t.lease_until ASC LIMIT 50`).all<any>(),
		db.prepare(`SELECT s.id AS submissionId,t.id AS taskId,t.title,t.module,a.name AS agentName,c.github_login AS login,
			s.commit_sha AS commitSha,s.pull_request_url AS pullRequestUrl,s.summary,s.created_at AS createdAt,
			CASE WHEN i.id IS NOT NULL THEN 'integrated' ELSE s.status END AS status,
			i.merge_commit_sha AS mergeCommitSha,i.integrated_at AS integratedAt FROM submissions s JOIN tasks t ON t.id=s.task_id
			JOIN agents a ON a.id=s.agent_id JOIN collaborators c ON c.id=a.collaborator_id LEFT JOIN integrations i ON i.submission_id=s.id
			ORDER BY s.created_at DESC,s.id DESC LIMIT 20`).all<any>(),
	]);
	const value = { summary: summary ?? { total: 0, integrated: 0, inReview: 0, reserved: 0, available: 0 }, modules: modules.results, tasks: taskRows.results,
		contributors: contributors.results, activeAgents: agents.results, recentContributions: history.results,
		recentIntegrations: history.results.filter((row: any) => row.status === "integrated") };
	cachedDashboard = { content: value, expires: Date.now() + 15_000 };
	return value;
}

async function dashboardApi(request: Request, env: Env) {
	const db = env.rustkore_db, url = new URL(request.url), path = url.pathname;
	if (await anonymousRateLimited(request, env, "web-api")) return json({ error: "Rate limit exceeded" }, 429, { "retry-after": "60" });
	if (path === "/api/dashboard" && request.method === "GET") return json(await publicDashboard(db), 200, { "cache-control": "public, max-age=15, stale-while-revalidate=30" });
	if (path === "/api/me" && request.method === "GET") {
		const identity = await getWebIdentity(request, db, env);
		if (!identity) return json({ authenticated: false });
		return json({ authenticated: true, collaboratorId: identity.collaboratorId, githubLogin: identity.githubLogin, name: identity.name,
			avatarUrl: identity.avatarUrl, isAdmin: identity.isAdmin, reviewerEnabled: identity.reviewerEnabled, csrfToken: parseCookies(request).rk_csrf ?? "" }, 200, { "cache-control": "no-store" });
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
	if (path === "/api/admin/collaborators" && request.method === "GET") {
		const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 50) || 50));
		let cursor: { login: string; id: string } | null = null;
		if (url.searchParams.has("cursor")) {
			try { cursor = JSON.parse(atob(url.searchParams.get("cursor")!)); } catch { return json({ error: "Invalid cursor" }, 400); }
			if (!cursor || typeof cursor.login !== "string" || typeof cursor.id !== "string") return json({ error: "Invalid cursor" }, 400);
		}
		const rows = await db.prepare(`SELECT c.id,c.name,c.github_login AS login,c.avatar_url AS avatarUrl,c.reviewer_enabled AS reviewerEnabled,
			c.suspended_at AS suspendedAt,c.created_at AS createdAt,COUNT(DISTINCT i.id) AS integratedCount
			FROM collaborators c LEFT JOIN agents a ON a.collaborator_id=c.id LEFT JOIN submissions s ON s.agent_id=a.id
			LEFT JOIN integrations i ON i.submission_id=s.id WHERE (? IS NULL OR c.github_login>? OR (c.github_login=? AND c.id>?))
			AND c.github_user_id IS NOT NULL GROUP BY c.id ORDER BY c.github_login ASC,c.id ASC LIMIT ?`)
			.bind(cursor ? 1 : null, cursor?.login ?? "", cursor?.login ?? "", cursor?.id ?? "", limit + 1).all<any>();
		const hasMore = rows.results.length > limit, page = rows.results.slice(0, limit), last = page.at(-1);
		return json({ collaborators: page, nextCursor: hasMore && last ? btoa(JSON.stringify({ login: last.login, id: last.id })) : null });
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
		if (Object.keys(body).some((key) => ![...Object.keys(fields), "priority"].includes(key))) return json({ error: "Unsupported task field" }, 400);
		for (const [field, column] of Object.entries(fields)) if (body[field] !== undefined) { sets.push(`${column}=?`); values.push(text(body[field], field, field === "title" ? 200 : field === "module" ? 100 : 4000)); }
		if (body.priority !== undefined) { if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 100) return json({ error: "priority must be an integer from 0 to 100" }, 400); sets.push("priority=?"); values.push(body.priority); }
		if (!sets.length) return json({ error: "Provide a task field to update" }, 400);
		sets.push("updated_at=?"); values.push(ts);
		const result = await db.prepare(`UPDATE tasks SET ${sets.join(",")} WHERE id=? AND status='open' RETURNING id`).bind(...values, taskId).first();
		if (!result) return json({ error: "Task not found or is no longer open" }, 409);
		await db.prepare(`INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at) VALUES (?,?,?,'task.updated',?,?)`)
			.bind(id(), taskId, identity.collaboratorId, JSON.stringify({ fields: Object.keys(fields).filter((key) => body[key] !== undefined).concat(body.priority !== undefined ? ["priority"] : []) }), ts).run();
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
			if (pull.merged !== true || pull.base?.repo?.full_name?.toLowerCase() !== (env.GITHUB_REPOSITORY ?? "boscv/RustKore").toLowerCase() || String(pull.head?.sha).toLowerCase() !== submission.commitSha.toLowerCase() || !/^[0-9a-f]{40}$/i.test(pull.merge_commit_sha ?? "")) return json({ error: "The approved pull request is not merged at the verified commit" }, 409);
			const integration = await db.prepare(`INSERT INTO integrations (id,task_id,submission_id,submitted_commit_sha,merge_commit_sha,integrated_by,integrated_at)
				SELECT ?,s.task_id,s.id,s.commit_sha,?,?,unixepoch() FROM submissions s WHERE s.id=? AND s.status='accepted' AND s.commit_sha=? AND s.pull_request_url=? RETURNING id`)
				.bind(id(), pull.merge_commit_sha.toLowerCase(), identity.collaboratorId, submissionId, submission.commitSha, submission.pullRequestUrl).first();
			if (!integration) return json({ error: "Submission changed while integration was being recorded" }, 409);
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
				if (error instanceof SyntaxError || /must be|cursor|Provide a task field/i.test(message)) return json({ error: message }, 400);
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
