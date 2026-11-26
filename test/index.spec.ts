import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import initialMigration from "../migrations/0001_initial.sql?raw";
import submissionIntegrityMigration from "../migrations/0002_submission_integrity.sql?raw";
import githubDashboardMigration from "../migrations/0003_github_dashboard.sql?raw";
import normalizedUniquenessMigration from "../migrations/0004_normalized_contribution_uniqueness.sql?raw";
import activeTokenLimitMigration from "../migrations/0005_active_token_limit.sql?raw";
import githubIdentityCredentialMigration from "../migrations/0006_github_identity_credentials.sql?raw";
import dashboardEnhancementsMigration from "../migrations/0007_task_complexity_recognition.sql?raw";
import publicHistoryIndexesMigration from "../migrations/0008_public_history_indexes.sql?raw";
import activityTimelineIndexesMigration from "../migrations/0009_activity_timeline_indexes.sql?raw";
import collaboratorPublicLoginIndexMigration from "../migrations/0010_collaborator_public_login_index.sql?raw";
import featureRoadmapMigration from "../migrations/0011_feature_roadmap.sql?raw";
import refinedRoadmapMigration from "../migrations/0012_feature_roadmap_refined_catalog.sql?raw";
import releaseAcceptanceMigration from "../migrations/0013_release_acceptance_status.sql?raw";
import roadmapCatalogFixture from "./fixtures/feature-roadmap-import.json";
import roadmapMigrationReference from "./fixtures/feature-roadmap-migration-reference.json";

const db = (env as any).rustkore_db as D1Database;
let githubHeadSha: string | null = null;
let nextGithubId = 1000;
const commitOwners = new Map<string, number>();
const pullHeads = new Map<number, string>();
const pullAuthors = new Map<number, number>();
let githubPullOverrides: Record<string, unknown> = {};
const runtimeEnv = { ...(env as any), GITHUB_REPOSITORY: "boscv/RustKore", GITHUB_REPOSITORY_ID: "1472554035", RUSTKORE_ADMIN_GITHUB_IDS: "99999", github_api: { async fetch(request: Request) {
	const url = new URL(request.url), value = url.pathname.split("/").at(-1)!;
	if (url.hostname === "github.com") return new Response(JSON.stringify({ access_token: "discarded-oauth-access-token" }), { status: 200 });
	if (url.pathname === "/user") return new Response(JSON.stringify({ id: 75000, login: "external-collaborator", name: "External Collaborator", avatar_url: "https://avatars.githubusercontent.com/u/75000" }), { status: 200 });
	if (url.pathname.includes("/pulls/")) return new Response(JSON.stringify({ user: { id: pullAuthors.get(Number(value)) ?? Number(value) }, base: { repo: { id: 1472554035, full_name: "boscv/RustKore" } }, head: { sha: githubHeadSha ?? pullHeads.get(Number(value)) ?? "" }, merged: true, merge_commit_sha: "f".repeat(40), ...githubPullOverrides }), { status: 200 });
	return new Response(JSON.stringify({ sha: value, author: { id: commitOwners.get(value.toLowerCase()) ?? 1 } }), { status: 200 });
} } };
let adminToken = "";

async function request(path: string, method: string, token?: string, body?: unknown) {
	return worker.fetch(new Request(`https://rustkore.test${path}`, {
		method,
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	}), runtimeEnv as any);
}
async function json<T = any>(response: Response): Promise<T> { return response.json() as Promise<T>; }
async function rpc(token: string, method: string, params: any = {}, requestId = 1, requestEnv: any = runtimeEnv) {
	const response = await worker.fetch(new Request("https://rustkore.test/mcp", {
		method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
		body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
	}), requestEnv);
	const body = await json<any>(response);
	return { response, body, output: body.result?.structuredContent ?? body.result?.content?.[0]?.text };
}
async function tool(token: string, name: string, args: any = {}, requestId = 1, requestEnv: any = runtimeEnv) { return rpc(token, "tools/call", { name, arguments: args }, requestId, requestEnv); }
async function credential(name: string, role: "collaborator" | "reviewer", agentName?: string) {
	const githubUserId = nextGithubId++, collaboratorId = crypto.randomUUID(), agentId = role === "collaborator" ? crypto.randomUUID() : null;
	const tokenId = crypto.randomUUID(), token = `local-agent-token-${crypto.randomUUID()}`, digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	const tokenHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	const githubLogin = name.toLowerCase().replaceAll(" ", "-");
	await db.batch([
		db.prepare("INSERT INTO collaborators (id,name,created_at,github_user_id,github_login,reviewer_enabled) VALUES (?,?,unixepoch(),?,?,?)").bind(collaboratorId,name,githubUserId,githubLogin,role === "reviewer" ? 1 : 0),
		...(agentId ? [db.prepare("INSERT INTO agents (id,collaborator_id,name,created_at) VALUES (?,?,?,unixepoch())").bind(agentId,collaboratorId,agentName ?? "test-agent")] : []),
		db.prepare("INSERT INTO tokens (id,token_hash,role,collaborator_id,agent_id,created_at) VALUES (?,?,?,?,?,unixepoch())").bind(tokenId,tokenHash,role,collaboratorId,agentId),
	]);
	if (role === "collaborator") {
		const commitSha = githubUserId.toString(16).padStart(40, "0"), pullNumber = githubUserId;
		commitOwners.set(commitSha, githubUserId); pullHeads.set(pullNumber, commitSha);
		return { token, tokenId, collaboratorId, agentId, githubUserId, commitSha, pullRequestUrl: `https://github.com/boscv/RustKore/pull/${pullNumber}` };
	}
	return { token, tokenId, collaboratorId, githubUserId };
}

async function createWebSession(collaboratorId: string) {
	const session = `local-session-${crypto.randomUUID()}`, csrf = `local-csrf-${crypto.randomUUID()}`;
	const digest = async (value: string) => {
		const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
		return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	};
	await db.prepare("INSERT INTO web_sessions (session_hash,csrf_hash,collaborator_id,expires_at,created_at) VALUES (?,?,?,unixepoch()+3600,unixepoch())")
		.bind(await digest(session), await digest(csrf), collaboratorId).run();
	return { cookie: `rk_session=${session}; rk_csrf=${csrf}`, csrf };
}
async function webRequest(path: string, method: string, session: { cookie: string; csrf: string }, body?: unknown, requestEnv: any = runtimeEnv) {
	return worker.fetch(new Request(`https://rustkore.test${path}`, {
		method, headers: { cookie: session.cookie, origin: "https://rustkore.test", "x-csrf-token": session.csrf, ...(body ? { "content-type": "application/json" } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	}), requestEnv);
}

function migrationQueries(source: string) {
	const queries: string[] = []; let pending = "", inTrigger = false;
	for (const line of source.split(/\r?\n/)) {
		if (!pending.trim() && /^\s*CREATE TRIGGER/i.test(line)) inTrigger = true;
		pending += `${line}\n`;
		if ((inTrigger && /^\s*END;\s*$/.test(line)) || (!inTrigger && /;\s*$/.test(line))) { queries.push(pending.trim().replace(/;\s*$/, "")); pending = ""; inTrigger = false; }
	}
	if (pending.trim()) queries.push(pending.trim()); return queries;
}
async function addTask(title: string, priority = 50, dependencies?: string[], module = "General") {
	const response = await request("/admin/tasks", "POST", adminToken, { title, description: `Work on ${title}`, acceptanceCriteria: "Implementation is reviewed", priority, dependencies, module });
	if (response.status !== 201) throw new Error(`Task creation failed: ${await response.text()}`);
	return json<any>(response);
}

beforeAll(async () => {
	await applyD1Migrations(db, [
		{ name: "0001_initial.sql", queries: migrationQueries(initialMigration) },
		{ name: "0002_submission_integrity.sql", queries: [submissionIntegrityMigration.trim()] },
		{ name: "0003_github_dashboard.sql", queries: migrationQueries(githubDashboardMigration) },
		{ name: "0004_normalized_contribution_uniqueness.sql", queries: migrationQueries(normalizedUniquenessMigration) },
		{ name: "0005_active_token_limit.sql", queries: [activeTokenLimitMigration.trim()] },
		{ name: "0006_github_identity_credentials.sql", queries: migrationQueries(githubIdentityCredentialMigration) },
		{ name: "0007_task_complexity_recognition.sql", queries: migrationQueries(dashboardEnhancementsMigration) },
		{ name: "0008_public_history_indexes.sql", queries: migrationQueries(publicHistoryIndexesMigration) },
		{ name: "0009_activity_timeline_indexes.sql", queries: migrationQueries(activityTimelineIndexesMigration) },
		{ name: "0010_collaborator_public_login_index.sql", queries: migrationQueries(collaboratorPublicLoginIndexMigration) },
		{ name: "0011_feature_roadmap.sql", queries: migrationQueries(featureRoadmapMigration) },
		{ name: "0012_feature_roadmap_refined_catalog.sql", queries: migrationQueries(refinedRoadmapMigration) },
		{ name: "0013_release_acceptance_status.sql", queries: migrationQueries(releaseAcceptanceMigration) },
	]);
	const collaboratorId = crypto.randomUUID(), tokenId = crypto.randomUUID();
	adminToken = `local-admin-token-${crypto.randomUUID()}`;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(adminToken));
	const tokenHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
	await db.batch([
		db.prepare("INSERT INTO collaborators (id,name,created_at,github_user_id,github_login) VALUES (?,?,unixepoch(),?,?)").bind(collaboratorId, "Test Admin", 99999, "test-admin"),
		db.prepare("INSERT INTO tokens (id,token_hash,role,collaborator_id,created_at) VALUES (?,?,?, ?,unixepoch())").bind(tokenId, tokenHash, "admin", collaboratorId),
	]);
});

describe("RustKore coordinator and stateless MCP", () => {
	it("rejects repository identity, base repository, and commit SHA mismatches before creating submissions", async () => {
		const owner = await credential("Repository identity adversary", "collaborator", "repository-identity-adversary");
		const cases: Array<{ label: string; env?: any; override?: Record<string, unknown>; shaOverride?: string }> = [
			{ label: "platform repository", override: { base: { repo: { id: 1472413946, full_name: "boscv/RustKore-DEV" } } } },
			{ label: "wrong repository ID", override: { base: { repo: { id: 1472413946, full_name: "boscv/RustKore" } } } },
			{ label: "wrong repository name", override: { base: { repo: { id: 1472554035, full_name: "boscv/RustKore-DEV" } } } },
			{ label: "missing repository ID in response", override: { base: { repo: { full_name: "boscv/RustKore" } } } },
			{ label: "missing repository ID configuration", env: { ...runtimeEnv, GITHUB_REPOSITORY_ID: undefined } },
			{ label: "nonnumeric repository ID configuration", env: { ...runtimeEnv, GITHUB_REPOSITORY_ID: "rustkore" } },
			{ label: "divergent head SHA", shaOverride: "a".repeat(40) },
		];
		for (const [index, testCase] of cases.entries()) {
			const task = await addTask(`Repository identity rejected ${index}`, 50), claim = await tool(owner.token, "claim_task");
			const sha = (99000 + index).toString(16).padStart(40, "0"), pullNumber = 99000 + index;
			commitOwners.set(sha, owner.githubUserId); pullHeads.set(pullNumber, sha); pullAuthors.set(pullNumber, owner.githubUserId);
			githubPullOverrides = testCase.override ?? {}; githubHeadSha = testCase.shaOverride ?? null;
			const result = await tool(owner.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: sha, pullRequestUrl: `https://github.com/boscv/RustKore/pull/${pullNumber}`, summary: testCase.label }, 1, testCase.env ?? runtimeEnv);
			expect(result.body.result.isError, testCase.label).toBe(true);
			expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE commit_sha=?").bind(sha).first<any>()).n, testCase.label).toBe(0);
		}
		githubPullOverrides = {}; githubHeadSha = null;
	});

	it("serves current stateless MCP discovery and rejects cross-origin, malformed versions, and invalid commit references", async () => {
		const discover = await worker.fetch(new Request("https://rustkore.test/mcp", {
			method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }),
		}), runtimeEnv as any);
		const discoverBody = await json<any>(discover);
		expect(discover.status).toBe(200);
		expect(discoverBody.result.supportedVersions).toContain("2026-07-28");
		const modernList = await worker.fetch(new Request("https://rustkore.test/mcp", {
			method: "POST", headers: { authorization: `Bearer ${adminToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } }),
		}), runtimeEnv as any);
		expect((await json<any>(modernList)).result.tools.length).toBeGreaterThan(0);
		const wrongOrigin = await worker.fetch(new Request("https://rustkore.test/mcp", { method: "POST", headers: { origin: "https://attacker.example" } }), runtimeEnv as any);
		expect(wrongOrigin.status).toBe(403);
		const unsupported = await worker.fetch(new Request("https://rustkore.test/mcp", {
			method: "POST", headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "1900-01-01" } }),
		}), runtimeEnv as any);
		expect((await json<any>(unsupported)).error.code).toBe(-32022);
		const contributor = await credential("Commit validator", "collaborator", "commit-validator");
		const task = await addTask("invalid commit blocked");
		const claim = await tool(contributor.token, "claim_task");
		const invalid = await tool(contributor.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: "not-a-real-sha", summary: "spoof" });
		expect(invalid.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE task_id=?").bind(task.id).first<any>()).n).toBe(0);
		pullAuthors.set(contributor.githubUserId, contributor.githubUserId + 1);
		const spoofedPull = await tool(contributor.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: contributor.commitSha, pullRequestUrl: contributor.pullRequestUrl, summary: "PR opened by another account" });
		expect(spoofedPull.body.result.isError).toBe(true);
		expect(spoofedPull.body.result.content[0].text).toMatch(/pull request must be opened/i);
		pullAuthors.delete(contributor.githubUserId);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE task_id=?").bind(task.id).first<any>()).n).toBe(0);
	});

	it("rejects source dumps in administrative event details", async () => {
		const task = await addTask("admin event is structured");
		const response = await request(`/admin/tasks/${task.id}`, "PATCH", adminToken, { title: "safe title", patch: "a very large source patch" });
		expect(response.status).toBe(400);
		const events = await db.prepare("SELECT details_json FROM activity WHERE task_id=? AND action='task.updated'").bind(task.id).all<any>();
		expect(events.results).toHaveLength(0);
	});

	it("rate limits unauthenticated bootstrap and MCP probes", async () => {
		const limitedEnv = { ...runtimeEnv, API_RATE_LIMITER: { async limit() { return { success: false }; } } };
		const setup = await worker.fetch(new Request("https://rustkore.test/setup", { method: "POST", headers: { "x-bootstrap-secret": "wrong" }, body: "{}" }), limitedEnv as any);
		expect(setup.status).toBe(429);
		const retired = await request("/setup", "POST", undefined, { name: "Legacy Admin" });
		expect(retired.status).toBe(410);
		const legacyHeader = await worker.fetch(new Request("https://rustkore.test/setup", { method: "POST", headers: { "x-bootstrap-secret": "previous-bootstrap-secret" }, body: "{}" }), runtimeEnv as any);
		expect(legacyHeader.status).toBe(410);
		const probe = await worker.fetch(new Request("https://rustkore.test/mcp", {
			method: "POST", headers: { authorization: "Bearer invalid", accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}), limitedEnv as any);
		expect(probe.status).toBe(429);
	});

	it("rejects MCP credential rows without a linked GitHub identity", async () => {
		const collaboratorId = crypto.randomUUID();
		await db.prepare("INSERT INTO collaborators (id,name,created_at) VALUES (?, ?, unixepoch())").bind(collaboratorId, "Unlinked legacy user").run();
		await expect(db.prepare("INSERT INTO tokens (id,token_hash,role,collaborator_id,created_at) VALUES (?, ?, 'collaborator', ?, unixepoch())")
			.bind(crypto.randomUUID(), "a".repeat(64), collaboratorId).run()).rejects.toThrow(/linked GitHub identity/);
	});

	it("enforces current admin and reviewer allowlists for already issued MCP tokens", async () => {
		expect((await rpc(adminToken, "tools/list")).response.status).toBe(200);
		const removedAdmin = await worker.fetch(new Request("https://rustkore.test/mcp", {
			method: "POST", headers: { authorization: `Bearer ${adminToken}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
		}), { ...runtimeEnv, RUSTKORE_ADMIN_GITHUB_IDS: "99998" } as any);
		expect(removedAdmin.status).toBe(401);
		const reviewer = await credential("Revocable reviewer", "reviewer");
		expect((await rpc(reviewer.token, "tools/list")).response.status).toBe(200);
		await db.prepare("UPDATE collaborators SET reviewer_enabled=0 WHERE github_user_id=?").bind(reviewer.githubUserId).run();
		expect((await rpc(reviewer.token, "tools/list")).response.status).toBe(401);
	});

	it("links OAuth sessions and revocable MCP credentials to GitHub identity", async () => {
		const oauthEnv = { ...runtimeEnv, GITHUB_OAUTH_CLIENT_ID: "local-client-id", GITHUB_OAUTH_CLIENT_SECRET: "local-client-secret",
			GITHUB_OAUTH_CALLBACK_URL: "https://rustkore.test/auth/callback", RUSTKORE_ADMIN_GITHUB_IDS: "75000" };
		const started = await worker.fetch(new Request("https://rustkore.test/auth/github"), oauthEnv as any);
		expect(started.status).toBe(302);
		const authorize = new URL(started.headers.get("location")!);
		expect(authorize.hostname).toBe("github.com");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		const state = authorize.searchParams.get("state")!;
		const stateCookie = started.headers.get("set-cookie")!.split(";")[0];
		const callbackRequest = () => new Request(`https://rustkore.test/auth/callback?code=local-code&state=${encodeURIComponent(state)}`, { headers: { cookie: stateCookie } });
		const callback = await worker.fetch(callbackRequest(), oauthEnv as any);
		expect(callback.status).toBe(303);
		const cookies = (callback.headers as any).getSetCookie?.() ?? callback.headers.get("set-cookie")!.split(/, (?=rk_)/g);
		expect(cookies.filter((value: string) => value.startsWith("rk_session=") || value.startsWith("rk_csrf=")).every((value: string) => value.includes("HttpOnly"))).toBe(true);
		const webCookies = cookies.map((value: string) => value.split(";")[0]).filter((value: string) => value.startsWith("rk_session=") || value.startsWith("rk_csrf="));
		const cookieHeader = webCookies.join("; "), csrf = decodeURIComponent(webCookies.find((value: string) => value.startsWith("rk_csrf="))!.split("=")[1]);
		const me = await worker.fetch(new Request("https://rustkore.test/api/me", { headers: { cookie: cookieHeader } }), oauthEnv as any);
		const profile = await json<any>(me);
		expect(profile.authenticated).toBe(true);
		expect(profile.githubLogin).toBe("external-collaborator");
		expect(profile.isAdmin).toBe(true);
		const forbidden = await worker.fetch(new Request("https://rustkore.test/api/tokens", { method: "POST", headers: { cookie: cookieHeader, origin: "https://attacker.test", "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "bad-origin" }) }), oauthEnv as any);
		expect(forbidden.status).toBe(403);
		const created = await worker.fetch(new Request("https://rustkore.test/api/tokens", { method: "POST", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "external-agent" }) }), oauthEnv as any);
		expect(created.status).toBe(201);
		const issued = await json<any>(created);
		const tokenIdentity = await db.prepare("SELECT c.github_user_id AS githubUserId,c.github_login AS githubLogin FROM tokens t JOIN collaborators c ON c.id=t.collaborator_id WHERE t.id=?").bind(issued.tokenId).first<any>();
		expect(tokenIdentity).toEqual({ githubUserId: 75000, githubLogin: "external-collaborator" });
		expect((await rpc(issued.token, "tools/list")).response.status).toBe(200);
		const integrationSha = (75000).toString(16).padStart(40, "0"), pullNumber = 75000, pullUrl = `https://github.com/boscv/RustKore/pull/${pullNumber}`;
		commitOwners.set(integrationSha, 75000); pullHeads.set(pullNumber, integrationSha);
		const integrationTask = await addTask("OAuth verified integration", 100), claim = await tool(issued.token, "claim_task");
		const submitted = await tool(issued.token, "submit_task", { taskId: integrationTask.id, leaseId: claim.output.task.leaseId, commitSha: integrationSha, pullRequestUrl: pullUrl, summary: "Verified implementation" });
		expect(submitted.body.result.isError).toBeFalsy();
		const independentReviewer = await credential("OAuth flow reviewer", "reviewer");
		const reviewed = await tool(independentReviewer.token, "review_task", { submissionId: submitted.output.submissionId, decision: "accepted" });
		expect(reviewed.output.decision).toBe("accepted");
		const integrated = await worker.fetch(new Request(`https://rustkore.test/api/admin/submissions/${submitted.output.submissionId}/integrate`, { method: "POST", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "x-csrf-token": csrf } }), oauthEnv as any);
		expect(integrated.status).toBe(200);
		const unmergedSha = (75001).toString(16).padStart(40, "0"), unmergedTask = await addTask("Reject an unmerged pull request", 100), unmergedClaim = await tool(issued.token, "claim_task");
		commitOwners.set(unmergedSha, 75000); pullHeads.set(75001, unmergedSha); pullAuthors.set(75001, 75000);
		const unmergedSubmission = await tool(issued.token, "submit_task", { taskId: unmergedTask.id, leaseId: unmergedClaim.output.task.leaseId, commitSha: unmergedSha, pullRequestUrl: "https://github.com/boscv/RustKore/pull/75001", summary: "Awaiting a merge" });
		const unmergedReview = await tool(independentReviewer.token, "review_task", { submissionId: unmergedSubmission.output.submissionId, decision: "accepted" });
		expect(unmergedReview.output.decision).toBe("accepted"); githubPullOverrides = { merged: false };
		const unmergedIntegration = await worker.fetch(new Request(`https://rustkore.test/api/admin/submissions/${unmergedSubmission.output.submissionId}/integrate`, { method: "POST", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "x-csrf-token": csrf } }), oauthEnv as any);
		expect(unmergedIntegration.status).toBe(409);
		expect(await db.prepare("SELECT 1 FROM integrations WHERE submission_id=?").bind(unmergedSubmission.output.submissionId).first()).toBeNull();
		githubPullOverrides = {};
		const publicProgress = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/dashboard"), oauthEnv as any));
		expect(Number(publicProgress.summary.integrated)).toBeGreaterThan(0);
		expect(publicProgress.recentIntegrations.some((item: any) => item.taskId === integrationTask.id)).toBe(true);
		const secondAgent = await worker.fetch(new Request("https://rustkore.test/api/tokens", { method: "POST", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify({ name: "second-external-agent" }) }), oauthEnv as any);
		const secondToken = await json<any>(secondAgent), secondTask = await addTask("Reject reused GitHub contribution", 100), secondClaim = await tool(secondToken.token, "claim_task");
		const reused = await tool(secondToken.token, "submit_task", { taskId: secondTask.id, leaseId: secondClaim.output.task.leaseId, commitSha: integrationSha.toUpperCase(), pullRequestUrl: pullUrl.replace("/pull/", "/PULL/") + "/", summary: "Fraudulent reuse" });
		expect(reused.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE commit_sha=?").bind(integrationSha).first<any>()).n).toBe(1);
		const tokenBurst = await Promise.all(Array.from({ length: 20 }, (_, index) => worker.fetch(new Request("https://rustkore.test/api/tokens", {
			method: "POST", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "content-type": "application/json", "x-csrf-token": csrf },
			body: JSON.stringify({ name: `burst-agent-${index}` }),
		}), oauthEnv as any)));
		expect(tokenBurst.filter(response => response.status === 201)).toHaveLength(18);
		expect(tokenBurst.filter(response => response.status === 409)).toHaveLength(2);
		const replay = await worker.fetch(callbackRequest(), oauthEnv as any);
		expect(replay.status).toBe(400);
		const revoked = await worker.fetch(new Request(`https://rustkore.test/api/tokens/${issued.tokenId}`, { method: "DELETE", headers: { cookie: cookieHeader, origin: "https://rustkore.test", "x-csrf-token": csrf } }), oauthEnv as any);
		expect((await json<any>(revoked)).revoked).toBe(true);
		expect((await rpc(issued.token, "tools/list")).response.status).toBe(401);
	});

	it("rejects pull requests whose head commit differs from the submitted commit", async () => {
		const contributor = await credential("PR integrity", "collaborator", "pr-integrity-agent");
		const task = await addTask("PR commit integrity");
		const claim = await tool(contributor.token, "claim_task");
		githubHeadSha = "b".repeat(40);
		const result = await tool(contributor.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: contributor.commitSha, pullRequestUrl: contributor.pullRequestUrl, summary: "mismatched" });
		githubHeadSha = null;
		expect(result.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE task_id=?").bind(task.id).first<any>()).n).toBe(0);
	});

	it("rolls back claims, submissions, and reviews when their activity write fails", async () => {
		await db.prepare("UPDATE tasks SET status='accepted',assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL WHERE status!='accepted'").run();
		const contributor = await credential("Atomic contributor", "collaborator", "atomic-agent");
		const reviewer = await credential("Atomic reviewer", "reviewer");
		const task = await addTask("atomic failures", 100);
		await db.prepare("CREATE TRIGGER fail_claim_activity BEFORE INSERT ON activity WHEN NEW.action='task.claimed' BEGIN SELECT RAISE(ABORT,'forced write failure'); END").run();
		const failedClaim = await tool(contributor.token, "claim_task");
		await db.prepare("DROP TRIGGER fail_claim_activity").run();
		expect(failedClaim.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT status FROM tasks WHERE id=?").bind(task.id).first<any>()).status).toBe("open");
		const claim = await tool(contributor.token, "claim_task");
		await db.prepare("CREATE TRIGGER fail_submission_activity BEFORE INSERT ON activity WHEN NEW.action='task.submitted' BEGIN SELECT RAISE(ABORT,'forced write failure'); END").run();
		const failedSubmission = await tool(contributor.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: contributor.commitSha, pullRequestUrl: contributor.pullRequestUrl, summary: "atomic" });
		await db.prepare("DROP TRIGGER fail_submission_activity").run();
		expect(failedSubmission.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT status FROM tasks WHERE id=?").bind(task.id).first<any>()).status).toBe("claimed");
		expect((await db.prepare("SELECT COUNT(*) AS n FROM submissions WHERE task_id=?").bind(task.id).first<any>()).n).toBe(0);
		const submission = await tool(contributor.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: contributor.commitSha, pullRequestUrl: contributor.pullRequestUrl, summary: "atomic" });
		await db.prepare("CREATE TRIGGER fail_review_activity BEFORE INSERT ON activity WHEN NEW.action='submission.accepted' BEGIN SELECT RAISE(ABORT,'forced write failure'); END").run();
		const failedReview = await tool(reviewer.token, "review_task", { submissionId: submission.output.submissionId, decision: "accepted" });
		await db.prepare("DROP TRIGGER fail_review_activity").run();
		expect(failedReview.body.result.isError).toBe(true);
		expect((await db.prepare("SELECT status FROM submissions WHERE id=?").bind(submission.output.submissionId).first<any>()).status).toBe("pending");
		expect((await db.prepare("SELECT status FROM tasks WHERE id=?").bind(task.id).first<any>()).status).toBe("submitted");
	});

	it("requires authorization and rejects unauthorized administration", async () => {
		const denied = await rpc("invalid-token", "tools/list");
		expect(denied.response.status).toBe(401);
		const noAdmin = await request("/admin/credentials", "POST", undefined, { name: "intruder", role: "reviewer" });
		expect(noAdmin.status).toBe(401);
		const deniedRole = await credential("Reader", "reviewer");
		const forbidden = await request("/admin/tasks", "POST", deniedRole.token, { title: "no", description: "no", acceptanceCriteria: "no" });
		expect(forbidden.status).toBe(403);
		const revoked = await request(`/admin/tokens/${deniedRole.tokenId}`, "DELETE", adminToken);
		expect((await json<any>(revoked)).revoked).toBe(true);
		expect((await rpc(deniedRole.token, "tools/list")).response.status).toBe(401);
	});

	it("supports two independent clients, safe simultaneous claims, submit, and independent review", async () => {
		const first = await credential("Contributor One", "collaborator", "agent-one");
		const second = await credential("Contributor Two", "collaborator", "agent-two");
		const reviewer = await credential("Reviewer", "reviewer");
		const taskA = await addTask("parallel-a", 90), taskB = await addTask("parallel-b", 80);
		const claims = await Promise.all([tool(first.token, "claim_task"), tool(second.token, "claim_task")]);
		const claimed = claims.map((r) => r.output).filter((r) => r?.task);
		expect(claimed).toHaveLength(2);
		expect(new Set(claimed.map((r) => r.task.id)).size).toBe(2);
		expect(claimed.map((r) => r.task.id).sort()).toEqual([taskA.id, taskB.id].sort());
		expect(claimed.every((r) => r.task.heartbeatIntervalSeconds === 120)).toBe(true);

		const owner = claimed[0];
		const ownerToken = owner === claims[0].output ? first.token : second.token;
		const ownerCollaborator = ownerToken === first.token ? first : second;
		const duplicateRace = await Promise.all([1, 2].map(() => tool(ownerToken, "submit_task", { taskId: owner.task.id, leaseId: owner.task.leaseId, commitSha: ownerCollaborator.commitSha, pullRequestUrl: ownerCollaborator.pullRequestUrl, summary: "Completed implementation" })));
		expect(duplicateRace.filter((item) => !item.body.result.isError)).toHaveLength(1);
		const submission = duplicateRace.find((item) => !item.body.result.isError)!;
		const forbiddenReview = await tool(owner === claims[0].output ? first.token : second.token, "review_task", { submissionId: submission.output.submissionId, decision: "accepted" });
		expect(forbiddenReview.body.result.isError).toBe(true);
		const reviewerTwo = await credential("Independent reviewer two", "reviewer");
		const reviewRace = await Promise.all([
			tool(reviewer.token, "review_task", { submissionId: submission.output.submissionId, decision: "accepted", comment: "Acceptance criteria met" }),
			tool(reviewerTwo.token, "review_task", { submissionId: submission.output.submissionId, decision: "rejected", comment: "Concurrent opposing review" }),
		]);
		expect(reviewRace.filter((item) => !item.body.result.isError)).toHaveLength(1);
		const other = claimed[1], otherToken = owner === claims[0].output ? second.token : first.token;
		const shortenedLease = Math.floor(Date.now() / 1000) + 30;
		await db.prepare("UPDATE tasks SET lease_until=? WHERE id=?").bind(shortenedLease, other.task.id).run();
		const beat = await tool(otherToken, "heartbeat", { taskId: other.task.id, leaseId: other.task.leaseId });
		expect(beat.output.leaseUntil).toBeGreaterThan(shortenedLease);
		const otherCollaborator = otherToken === first.token ? first : second;
		const secondSubmission = await tool(otherToken, "submit_task", { taskId: other.task.id, leaseId: other.task.leaseId, commitSha: otherCollaborator.commitSha, pullRequestUrl: otherCollaborator.pullRequestUrl, summary: "Second client's implementation" });
		expect(secondSubmission.body.result.isError).toBeFalsy();
		const secondReview = await tool(reviewer.token, "review_task", { submissionId: secondSubmission.output.submissionId, decision: "accepted", comment: "Second result reviewed" });
		expect(secondReview.output.decision).toBe("accepted");
		const duplicate = await tool(ownerToken, "submit_task", { taskId: owner.task.id, leaseId: owner.task.leaseId, commitSha: ownerCollaborator.commitSha, pullRequestUrl: ownerCollaborator.pullRequestUrl, summary: "duplicate" });
		expect(duplicate.body.result.isError).toBe(true);
		const progress = await tool(reviewer.token, "get_progress");
		expect(progress.body.result.isError).toBeFalsy();
		const task = await tool(reviewer.token, "get_task", { taskId: owner.task.id });
		expect(task.output.status).toBe("accepted");
		const secondTask = await tool(reviewer.token, "get_task", { taskId: other.task.id });
		expect(secondTask.output.status).toBe("accepted");
	});

	it("recovers an abandoned lease and rejects expired or foreign leases", async () => {
		const first = await credential("Abandoner", "collaborator", "abandoned-agent");
		const second = await credential("Recovery worker", "collaborator", "recovery-agent");
		const task = await addTask("abandoned-task");
		const claim = await tool(first.token, "claim_task");
		await db.prepare("UPDATE tasks SET lease_until=? WHERE id=?").bind(Math.floor(Date.now() / 1000) - 1, task.id).run();
		const expiredSubmit = await tool(first.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: first.commitSha, pullRequestUrl: first.pullRequestUrl, summary: "expired lease must fail" });
		expect(expiredSubmit.body.result.isError).toBe(true);
		const oldHeartbeat = await tool(first.token, "heartbeat", { taskId: task.id, leaseId: claim.output.task.leaseId });
		expect(oldHeartbeat.body.result.isError).toBe(true);
		const recovered = await tool(second.token, "claim_task");
		expect(recovered.output.task.id).toBe(task.id);
		expect(recovered.output.task.leaseId).not.toBe(claim.output.task.leaseId);
		const staleSubmit = await tool(first.token, "submit_task", { taskId: task.id, leaseId: claim.output.task.leaseId, commitSha: first.commitSha, pullRequestUrl: first.pullRequestUrl, summary: "should fail" });
		expect(staleSubmit.body.result.isError).toBe(true);
		const foreignRelease = await tool(first.token, "release_task", { taskId: task.id, leaseId: recovered.output.task.leaseId });
		expect(foreignRelease.body.result.isError).toBe(true);
	});

	it("enforces dependencies, rejects cycles, and paginates task listing", async () => {
		await db.prepare("UPDATE tasks SET status='accepted',assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL WHERE status!='accepted'").run();
		const client = await credential("Dependency client", "collaborator", "dependency-agent");
		const parent = await addTask("dependency-parent", 100), child = await addTask("dependency-child", 99, [parent.id]);
		const list = await tool(client.token, "list_tasks", { status: "open", limit: 1 });
		expect(list.output.tasks).toHaveLength(1);
		expect(typeof list.output.nextCursor).toBe("string");
		const next = await tool(client.token, "list_tasks", { status: "open", limit: 1, cursor: list.output.nextCursor });
		expect(next.output.tasks.some((item: any) => item.id === child.id)).toBe(true);
		const claim = await tool(client.token, "claim_task");
		expect(claim.output.task.id).toBe(parent.id);
		const blocked = await tool(client.token, "claim_task", { backoffAttempt: 1 });
		expect(blocked.output.task).toBeNull();
		expect(blocked.output.retryAfterSeconds).toBeGreaterThanOrEqual(2);
		expect(blocked.output.retryAfterSeconds).toBeLessThanOrEqual(3);
		expect(blocked.output.nextBackoffAttempt).toBe(2);
		await tool(client.token, "release_task", { taskId: parent.id, leaseId: claim.output.task.leaseId });
		const cycle = await request(`/admin/tasks/${parent.id}`, "PATCH", adminToken, { dependencies: [child.id] });
		expect(cycle.status).toBe(409);
		const activity = await tool(client.token, "get_activity", { taskId: parent.id });
		expect(activity.output.activities.some((item: any) => item.action === "task.created")).toBe(true);
	});

	it("shows claim eligibility and progress states consistently on the public dashboard", async () => {
		await db.prepare("UPDATE tasks SET status='accepted',assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL WHERE status IN ('open','claimed','submitted')").run();
		const baselineTask = await addTask("dashboard eligibility baseline", 40);
		const before = await json<any>(await request("/api/dashboard", "GET"));
		const parent = await addTask("dashboard dependency parent", 90), blocked = await addTask("dashboard dependency blocked", 100, [parent.id]);
		const available = await addTask("dashboard independently available", 80), inReview = await addTask("dashboard in review", 70), approved = await addTask("dashboard approved", 60);
		await db.prepare("UPDATE tasks SET status='submitted' WHERE id=?").bind(inReview.id).run();
		await db.prepare("UPDATE tasks SET status='accepted' WHERE id=?").bind(approved.id).run();

		const worker = await credential("Dashboard eligibility worker", "collaborator", "dashboard-worker");
		const claim = await tool(worker.token, "claim_task");
		expect(claim.output.task.id).toBe(parent.id);
		const dashboard = await json<any>(await request("/api/dashboard", "GET"));
		const taskById = new Map(dashboard.tasks.map((task: any) => [task.id, task]));
		expect((taskById.get(parent.id) as any).state).toBe("reserved");
		expect((taskById.get(blocked.id) as any).state).toBe("blocked");
		expect((taskById.get(available.id) as any).state).toBe("available");
		expect((taskById.get(inReview.id) as any).state).toBe("in_review");
		expect((taskById.get(approved.id) as any).state).toBe("approved");
		expect(dashboard.tasks.some((task: any) => task.state === "integrated")).toBe(true);
		expect(dashboard.summary.available).toBe(Number(before.summary.available) + 1);
		expect(dashboard.summary.blocked).toBe(Number(before.summary.blocked) + 1);
		expect(dashboard.summary.reserved).toBe(Number(before.summary.reserved) + 1);
		expect(dashboard.summary.inReview).toBe(Number(before.summary.inReview) + 1);
		expect(dashboard.summary.approved).toBe(Number(before.summary.approved) + 1);
		expect(dashboard.summary.total).toBe(Number(before.summary.total) + 5);
		expect(Number(dashboard.summary.integrated)).toBe(Number(before.summary.integrated));
		expect((taskById.get(baselineTask.id) as any).state).toBe("available");

		const otherWorker = await credential("Dashboard blocked-task guard", "collaborator", "dashboard-guard");
		const nextClaim = await tool(otherWorker.token, "claim_task");
		expect(nextClaim.output.task.id).toBe(available.id);
		const finalDashboard = await json<any>(await request("/api/dashboard", "GET"));
		const list = await tool(worker.token, "list_tasks", { status: "open", limit: 100 });
		expect(list.output.tasks.find((task: any) => task.id === blocked.id).state).toBe("blocked");
		const progress = await tool(adminToken, "get_progress");
		expect(progress.output.tasks.find((row: any) => row.state === "blocked").count).toBe(finalDashboard.summary.blocked);
		expect(progress.output.tasks.find((row: any) => row.state === "available").count).toBe(finalDashboard.summary.available);
		expect(progress.output.tasks.find((row: any) => row.state === "reserved").count).toBe(finalDashboard.summary.reserved);
		expect(progress.output.tasks.find((row: any) => row.state === "in_review").count).toBe(finalDashboard.summary.inReview);
		expect(progress.output.tasks.find((row: any) => row.state === "approved").count).toBe(finalDashboard.summary.approved);
		expect(progress.output.tasks.find((row: any) => row.state === "integrated").count).toBe(finalDashboard.summary.integrated);
	});

	it("aggregates only registered cross-module task dependencies for the project map", async () => {
		const foundation = await addTask("map module foundation", 35, undefined, "Map Core");
		const runtime = await addTask("map module runtime", 35, [foundation.id], "Map Runtime");
		await addTask("independent map tooling", 35, undefined, "Map Tooling");
		await addTask("same-module dependency", 35, [foundation.id], "Map Core");
		const cycleA = await addTask("map cycle A root", 35, undefined, "Map Cycle A");
		const cycleB = await addTask("map cycle B root", 35, undefined, "Map Cycle B");
		await addTask("map cycle A consumer", 35, [cycleB.id], "Map Cycle A");
		await addTask("map cycle B consumer", 35, [cycleA.id], "Map Cycle B");
		const dashboard = await json<any>(await request("/api/dashboard", "GET"));
		expect(dashboard.moduleDependencies).toContainEqual({ module: "Map Runtime", dependsOnModule: "Map Core", taskDependencies: 1 });
		expect(dashboard.moduleDependencies).not.toContainEqual(expect.objectContaining({ module: "Map Tooling" }));
		expect(dashboard.moduleDependencies).not.toContainEqual(expect.objectContaining({ module: "Map Core" }));
		expect(dashboard.moduleDependencies).toContainEqual({ module: "Map Cycle A", dependsOnModule: "Map Cycle B", taskDependencies: 1 });
		expect(dashboard.moduleDependencies).toContainEqual({ module: "Map Cycle B", dependsOnModule: "Map Cycle A", taskDependencies: 1 });
		expect(dashboard.modules.some((module: any) => module.module === "Map Runtime")).toBe(true);
		expect(dashboard.modules.some((module: any) => module.module === "Map Core")).toBe(true);
	});

	it("serves paginated task filters, public dependency details, profiles, and real integration history", async () => {
		const parent = await request("/admin/tasks", "POST", adminToken, { title: "Catalog root one", module: "Catalog", priority: 50, complexity: "small", description: "A filtered catalog task", acceptanceCriteria: "Visible in search" });
		const parentTask = await json<any>(parent);
		const second = await request("/admin/tasks", "POST", adminToken, { title: "Catalog root two", module: "Catalog", priority: 40, complexity: "small", description: "A second filtered task", acceptanceCriteria: "Visible on the next page" });
		const secondTask = await json<any>(second);
		const childResponse = await request("/admin/tasks", "POST", adminToken, { title: "Catalog blocked child", module: "Catalog", priority: 60, complexity: "medium", description: "Waits on a parent", acceptanceCriteria: "Shows its prerequisite", dependencies: [parentTask.id] });
		const child = await json<any>(childResponse);

		const pageOne = await json<any>(await request("/api/tasks?module=Catalog&complexity=small&limit=1", "GET"));
		const pageTwo = await json<any>(await request(`/api/tasks?module=Catalog&complexity=small&limit=1&cursor=${encodeURIComponent(pageOne.nextCursor)}`, "GET"));
		expect(pageOne.tasks).toHaveLength(1);
		expect(pageOne.nextCursor).toBeTruthy();
		expect(pageTwo.tasks).toHaveLength(1);
		expect(pageOne.tasks[0].id).not.toBe(pageTwo.tasks[0].id);
		const blocked = await json<any>(await request("/api/tasks?state=blocked&q=Catalog%20blocked%20child", "GET"));
		expect(blocked.tasks.map((task: any) => task.id)).toContain(child.id);
		const detail = await json<any>(await request(`/api/tasks/${child.id}`, "GET"));
		expect(detail.state).toBe("blocked");
		expect(detail.complexity).toBe("medium");
		expect(detail.dependencies).toEqual([expect.objectContaining({ id: parentTask.id, state: "available" })]);
		const parentDetail = await json<any>(await request(`/api/tasks/${parentTask.id}`, "GET"));
		expect(parentDetail.dependents).toEqual([expect.objectContaining({ id: child.id, state: "blocked" })]);

		const dashboard = await json<any>(await request("/api/dashboard", "GET"));
		const stateTotal = [dashboard.summary.available, dashboard.summary.blocked, dashboard.summary.reserved, dashboard.summary.inReview, dashboard.summary.approved, dashboard.summary.integrated].reduce((sum: number, value: number) => sum + Number(value), 0);
		expect(stateTotal).toBe(Number(dashboard.summary.total));
		expect(dashboard.integrationHistory.daily).toBeInstanceOf(Array);
		expect(dashboard.integrationHistory.monthly).toBeInstanceOf(Array);
		expect(dashboard.recentActivity).toBeInstanceOf(Array);
		expect(dashboard.summary.contributors).toBeGreaterThan(0);
		const contributor = await json<any>(await request("/api/contributors/external-collaborator", "GET"));
		expect(contributor.integratedCount).toBe(1);
		expect(contributor.contributions[0].pullRequestUrl).toContain("github.com/");
	});

	it("protects task registry, context, and permanent recognition management", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		const adminSession = await createWebSession(adminId), contributor = await credential("Recognition recipient", "collaborator", "recognition-agent"), contributorSession = await createWebSession(contributor.collaboratorId);
		const denied = await webRequest("/api/admin/context", "GET", contributorSession);
		expect(denied.status).toBe(403);
		const savedContext = await webRequest("/api/admin/context", "PUT", adminSession, { content: "Local test context for dashboard." });
		expect(savedContext.status).toBe(200);
		const contextToken = await credential("Context verification", "collaborator", "context-reader");
		expect((await tool(contextToken.token, "get_project_context")).output.content).toContain("Local test context");

		const parent = await request("/admin/tasks", "POST", adminToken, { title: "Admin graph parent", module: "Admin", priority: 20, complexity: "large", description: "Parent", acceptanceCriteria: "Graph stays valid" });
		const parentTask = await json<any>(parent);
		const child = await request("/admin/tasks", "POST", adminToken, { title: "Admin graph child", module: "Admin", priority: 10, description: "Child", acceptanceCriteria: "Graph stays valid" });
		const childTask = await json<any>(child);
		const updated = await webRequest(`/api/admin/tasks/${childTask.id}`, "PATCH", adminSession, { complexity: "small", dependencies: [parentTask.id] });
		expect(updated.status).toBe(200);
		const childDetail = await json<any>(await request(`/api/tasks/${childTask.id}`, "GET"));
		expect(childDetail.complexity).toBe("small");
		expect(childDetail.dependencies[0].id).toBe(parentTask.id);
		const cycle = await webRequest(`/api/admin/tasks/${parentTask.id}`, "PATCH", adminSession, { dependencies: [childTask.id] });
		expect(cycle.status).toBe(400);
		expect((await json<any>(await request(`/api/tasks/${parentTask.id}`, "GET"))).dependencies).toEqual([]);

		const award = await webRequest(`/api/admin/collaborators/${contributor.collaboratorId}/recognitions`, "POST", adminSession, { code: "builder", rationale: "Recognized for a verified local test contribution." });
		expect(award.status).toBe(201);
		const duplicate = await webRequest(`/api/admin/collaborators/${contributor.collaboratorId}/recognitions`, "POST", adminSession, { code: "builder", rationale: "Duplicate award should be rejected." });
		expect(duplicate.status).toBe(409);
		const profile = await json<any>(await request("/api/contributors/recognition-recipient", "GET"));
		expect(profile.recognitions).toEqual([expect.objectContaining({ code: "builder", rationale: "Recognized for a verified local test contribution." })]);
	});

	it.each([10, 50, 100, 500])("handles a burst of %i independent agents without double claims", async (count) => {
		await db.prepare("UPDATE tasks SET status='accepted',assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL WHERE status IN ('open','claimed')").run();
		const collaborators: any[] = [];
		for (let i = 0; i < count; i++) {
			const collaboratorId = crypto.randomUUID(), agentId = crypto.randomUUID(), raw = `load_${count}_${i}_${crypto.randomUUID()}`, githubUserId = nextGithubId++;
			const hashBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
			const tokenHash = [...new Uint8Array(hashBytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
			collaborators.push({ collaboratorId, agentId, raw, tokenHash, githubUserId, taskId: crypto.randomUUID(), tokenId: crypto.randomUUID() });
		}
		for (let offset = 0; offset < count; offset += 100) {
			const group = collaborators.slice(offset, offset + 100), createdAt = Math.floor(Date.now() / 1000);
			const statements: D1PreparedStatement[] = [];
			for (const row of group) {
				statements.push(db.prepare("INSERT INTO collaborators (id,name,created_at,github_user_id,github_login) VALUES (?,?,?, ?,?)").bind(row.collaboratorId, `load-${count}`, createdAt, row.githubUserId, `load-${row.githubUserId}`));
				statements.push(db.prepare("INSERT INTO agents (id,collaborator_id,name,created_at) VALUES (?,?,?,?)").bind(row.agentId, row.collaboratorId, `agent-${row.agentId}`, createdAt));
				statements.push(db.prepare("INSERT INTO tokens (id,token_hash,role,collaborator_id,agent_id,created_at) VALUES (?,?, 'collaborator',?,?,?)").bind(row.tokenId, row.tokenHash, row.collaboratorId, row.agentId, createdAt));
				statements.push(db.prepare("INSERT INTO tasks (id,title,description,acceptance_criteria,priority,status,created_by,created_at,updated_at) VALUES (?,?,?,'done',50,'open',?,?,?)").bind(row.taskId, `load-${count}`, "load test", row.collaboratorId, createdAt, createdAt));
			}
			await db.batch(statements);
		}
		const claims: any[] = [];
		for (let offset = 0; offset < count; offset += 25) {
			claims.push(...await Promise.all(collaborators.slice(offset, offset + 25).map(async (row, i) => (await tool(row.raw, "claim_task", {}, offset + i + 1)).output)));
		}
		const taskIds = claims.map((claim) => claim?.task?.id).filter(Boolean);
		expect(taskIds).toHaveLength(count);
		expect(new Set(taskIds).size).toBe(count);
		expect([...taskIds].sort()).toEqual(collaborators.map((row) => row.taskId).sort());
	});

	it("paginates thousands of registered tasks without gaps or duplicates", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		for (let offset = 0; offset < 1500; offset += 100) {
			const batch = Array.from({ length: Math.min(100, 1500 - offset) }, (_, index) => {
				const number = offset + index, id = `scale-${String(number).padStart(4, "0")}`;
				return db.prepare("INSERT INTO tasks (id,title,description,acceptance_criteria,priority,status,created_by,created_at,updated_at,module) VALUES (?,?,?,'Registered',50,'open',?,1800000000,1800000000,'Scale sample')")
					.bind(id, `Scale task ${number}`, "Local pagination test", adminId);
			});
			await db.batch(batch);
		}
		const ids = new Set<string>(); let cursor = "", pages = 0;
		do {
			const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
			const page = await json<any>(await request(`/api/tasks?module=Scale%20sample&limit=100${suffix}`, "GET"));
			expect(page.tasks.length).toBeLessThanOrEqual(100);
			page.tasks.forEach((task: any) => ids.add(task.id));
			cursor = page.nextCursor ?? ""; pages++;
		} while (cursor);
		expect(ids.size).toBe(1500);
		expect(pages).toBe(15);
	});

	it("paginates public activity and contributions on the backend with combined filters", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		const actor = await credential("Public history actor", "collaborator", "history-agent");
		const task = await addTask("Public history pagination task", 50, undefined, "HistoryPage");
		await db.batch(Array.from({ length: 30 }, (_, index) => db.prepare("INSERT INTO activity (id,task_id,actor_id,action,details_json,created_at) VALUES (?,?,?,'task.claimed','{}',?)")
			.bind(`page-event-${String(index).padStart(2,"0")}`, task.id, actor.collaboratorId, 1900000000 - index)));
		const first = await json<any>(await request("/api/activity?limit=25&type=task.claimed&module=HistoryPage&contributor=public-history-actor&period=all", "GET"));
		const second = await json<any>(await request(`/api/activity?limit=25&type=task.claimed&module=HistoryPage&contributor=public-history-actor&period=all&cursor=${encodeURIComponent(first.nextCursor)}`, "GET"));
		expect(first.items).toHaveLength(25); expect(second.items).toHaveLength(5); expect(first.nextCursor).toBeTruthy();
		expect(first.items[0].createdAt).toBeGreaterThan(first.items[24].createdAt);
		expect([...first.items,...second.items].every((item:any)=>item.module==="HistoryPage"&&item.actor==="public-history-actor")).toBe(true);

		const contributionIds:string[]=[];
		for(let index=0;index<27;index++){
			const taskRow=await addTask(`Contribution page ${index}`,50,undefined,"HistoryPage"), submissionId=`public-page-submission-${String(index).padStart(2,"0")}`, sha=(index+1).toString(16).padStart(40,"0"); contributionIds.push(submissionId);
			await db.prepare("UPDATE tasks SET status='claimed',assignee_agent_id=?,lease_id=?,lease_until=unixepoch()+3600 WHERE id=?").bind(actor.agentId,`history-lease-${index}`,taskRow.id).run();
			await db.prepare("INSERT INTO submissions (id,task_id,agent_id,commit_sha,pull_request_url,summary,status,created_at,submitted_github_user_id,submitted_github_login) VALUES (?,?,?,?,NULL,'Public page test','pending',?,?,?)")
				.bind(submissionId,taskRow.id,actor.agentId,sha,1900000000-index,actor.githubUserId,"public-history-actor").run();
		}
		const contributions = await json<any>(await request("/api/contributions?limit=25&module=HistoryPage&contributor=public-history-actor&status=pending&period=all","GET"));
		const older = await json<any>(await request(`/api/contributions?limit=25&module=HistoryPage&contributor=public-history-actor&status=pending&period=all&cursor=${encodeURIComponent(contributions.nextCursor)}`,"GET"));
		expect(contributions.items).toHaveLength(25); expect(older.items).toHaveLength(2); expect(new Set([...contributions.items,...older.items].map((item:any)=>item.id)).size).toBe(27);
	});

	it("provides a stable ten-person ranking cursor and excludes expired reservations", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		for(let index=0;index<12;index++){
			const collaboratorId=`rank-page-person-${String(index).padStart(2,"0")}`,agentId=`rank-page-agent-${String(index).padStart(2,"0")}`,taskId=`rank-page-task-${String(index).padStart(2,"0")}`,submissionId=`rank-page-submission-${String(index).padStart(2,"0")}`,sha=(index+500).toString(16).padStart(40,"0"),userId=81000+index;
			await db.batch([
				db.prepare("INSERT INTO collaborators (id,name,created_at,github_user_id,github_login) VALUES (?, ?,unixepoch(),?,?)").bind(collaboratorId,`Rank Person ${index}`,userId,`rank-person-${String(index).padStart(2,"0")}`),
				db.prepare("INSERT INTO agents (id,collaborator_id,name,created_at) VALUES (?,?,?,unixepoch())").bind(agentId,collaboratorId,`Rank Agent ${index}`),
				db.prepare("INSERT INTO tasks (id,title,description,acceptance_criteria,priority,status,created_by,assignee_agent_id,lease_id,lease_until,created_at,updated_at,module) VALUES (?,?,?,'Verified',50,'claimed',?,?,?,unixepoch()+3600,unixepoch(),unixepoch(),'Ranking')").bind(taskId,`Rank task ${index}`,"Ranking test",collaboratorId,agentId,`rank-lease-${index}`),
				db.prepare("INSERT INTO submissions (id,task_id,agent_id,commit_sha,pull_request_url,summary,status,created_at,submitted_github_user_id,submitted_github_login) VALUES (?,?,?, ?,NULL,'Rank contribution','pending',unixepoch(),?,?)").bind(submissionId,taskId,agentId,sha,userId,`rank-person-${String(index).padStart(2,"0")}`),
				db.prepare("UPDATE tasks SET status='accepted',lease_id=NULL,lease_until=NULL,assignee_agent_id=NULL WHERE id=?").bind(taskId),
				db.prepare("UPDATE submissions SET status='accepted' WHERE id=?").bind(submissionId),
				db.prepare("INSERT INTO integrations (id,task_id,submission_id,submitted_commit_sha,merge_commit_sha,integrated_by,integrated_at) VALUES (?,?,?,?,?,?,unixepoch())").bind(`rank-page-integration-${String(index).padStart(2,"0")}`,taskId,submissionId,sha,(index+900).toString(16).padStart(40,"0"),collaboratorId),
			]);
		}
		const pageOne=await json<any>(await request("/api/ranking?measure=integrated&module=Ranking&period=all&limit=10","GET"));
		const pageTwo=await json<any>(await request(`/api/ranking?measure=integrated&module=Ranking&period=all&limit=10&cursor=${encodeURIComponent(pageOne.nextCursor)}`,"GET"));
		expect(pageOne.items).toHaveLength(10);expect(pageTwo.items).toHaveLength(2);expect(new Set([...pageOne.items,...pageTwo.items].map((person:any)=>person.login)).size).toBe(12);

		await db.prepare("UPDATE tasks SET status='open',assignee_agent_id=NULL,lease_id=NULL,lease_until=NULL WHERE status='claimed'").run();
		const reservationOwner=await credential("Reservation page owner","collaborator","lease-demo-agent"), activeTasks=[];
		for(let index=0;index<11;index++)activeTasks.push(await addTask(`Currently reserved task ${index}`,50,undefined,"LeasePage"));
		const expiredTask=await addTask("Expired reservation task",50,undefined,"LeasePage");
		await db.batch([
			...activeTasks.map((task:any,index:number)=>db.prepare("UPDATE tasks SET status='claimed',assignee_agent_id=?,lease_id=?,lease_until=unixepoch()+?,updated_at=unixepoch()-120 WHERE id=?").bind(reservationOwner.agentId,`test-active-lease-${index}`,3600+index,task.id)),
			db.prepare("UPDATE tasks SET status='claimed',assignee_agent_id=?,lease_id='test-expired-lease',lease_until=unixepoch()-10,updated_at=unixepoch()-3600 WHERE id=?").bind(reservationOwner.agentId,expiredTask.id),
		]);
		const reservations=await json<any>(await request("/api/reservations?limit=10","GET"));
		const nextReservations=await json<any>(await request(`/api/reservations?limit=10&cursor=${encodeURIComponent(reservations.nextCursor)}`,"GET"));
		expect(reservations.items).toHaveLength(10);expect(nextReservations.items).toHaveLength(1);expect(reservations.nextCursor).toBeTruthy();
		expect(new Set([...reservations.items,...nextReservations.items].map((item:any)=>item.taskId)).size).toBe(11);
		expect([...reservations.items,...nextReservations.items].some((item:any)=>item.taskId===expiredTask.id)).toBe(false);
	});

	it("seeds the functional roadmap as planned and computes coverage separately from task progress", async () => {
		const response = await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any);
		expect(response.status).toBe(200);
		const data = await json<any>(response);
		expect(data.milestones.map((item: any) => item.id)).toEqual(["foundation","prototype","alpha","beta","rc","stable"]);
		expect(data.categories).toHaveLength(18);
		expect(data.summary.total).toBe(278);
		expect(data.summary.verified).toBe(0);
		expect(data.summary.nextRelease).toMatchObject({ milestoneId: "prototype", verified: 0, total: 45 });
		const states = await db.prepare("SELECT state,COUNT(*) AS n FROM roadmap_feature_status WHERE scenario='actual' GROUP BY state").all<any>();
		expect(states.results).toEqual([{ state: "planned", n: 278 }]);
	});

	it("migrates exactly the versioned catalog without changing IDs, scope, or unrelated records", async () => {
		const { catalogHash: referenceHash, ...referenceCatalog } = roadmapMigrationReference;
		const rows = await db.prepare(`SELECT f.id,f.category_id AS categoryId,f.title,f.description,f.milestone_id AS milestoneId,f.is_required AS required,
			f.acceptance_criteria_json AS acceptanceCriteria,f.upstream_references_json AS upstreamReferences FROM roadmap_features f WHERE f.active=1 ORDER BY f.id`).all<any>();
		const normalized = rows.results.map((row: any) => ({ ...row, required: Boolean(row.required), acceptanceCriteria: JSON.parse(row.acceptanceCriteria), upstreamReferences: JSON.parse(row.upstreamReferences) }));
		expect(normalized).toEqual([...roadmapMigrationReference.features].sort((a: any, b: any) => a.id.localeCompare(b.id)).map((feature: any) => ({ ...feature, required: Boolean(feature.required) })));
		const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM roadmap_features WHERE active=1) AS featureCount,
			(SELECT COUNT(*) FROM roadmap_categories) AS categoryCount,(SELECT COUNT(*) FROM roadmap_milestones) AS milestoneCount,
			(SELECT COUNT(*) FROM release_acceptance_criteria) AS acceptanceCount`).first<any>();
		const acceptanceCount = Object.values(roadmapMigrationReference.releaseAcceptanceCriteria).reduce((sum: number, items: any) => sum + items.length, 0);
		expect(counts).toEqual({ featureCount: 278, categoryCount: 18, milestoneCount: 6, acceptanceCount });
		const imported = await db.prepare("SELECT catalog_hash AS hash,catalog_version AS version,source_revision AS revision,feature_count AS count FROM roadmap_catalog_imports WHERE catalog_version=?").bind(roadmapMigrationReference.catalogVersion).first<any>();
		expect(imported).toEqual({ hash: referenceHash, version: roadmapMigrationReference.catalogVersion, revision: roadmapMigrationReference.source.reviewedMasterRevision, count: 278 });
		const history = await db.prepare("SELECT json_extract(details_json,'$.catalogHash') AS hash FROM roadmap_change_history WHERE action='catalog.migration_applied' AND json_extract(details_json,'$.catalogVersion')=?").bind(roadmapMigrationReference.catalogVersion).first<any>();
		expect(history?.hash).toBe(imported.hash);
		const legacyImport = await db.prepare("SELECT catalog_hash AS hash FROM roadmap_catalog_imports WHERE catalog_version='1.0.0'").first<any>();
		const legacyHistory = await db.prepare("SELECT json_extract(details_json,'$.catalogHash') AS hash FROM roadmap_change_history WHERE id='roadmap-initial-catalog'").first<any>();
		const reconciliation = await db.prepare("SELECT json_extract(details_json,'$.recordedHash') AS recordedHash,json_extract(details_json,'$.registeredHash') AS registeredHash FROM roadmap_change_history WHERE id='roadmap-v1.0.0-hash-reconciliation'").first<any>();
		expect(legacyHistory.hash).toBe(legacyImport.hash);
		expect(reconciliation).toEqual({ recordedHash: "6a3d09c23f0e0766df7ab03c3ce54f1e5c429acf1636d06debaa7ce3f715b2ef", registeredHash: legacyImport.hash });
		const admin = await createWebSession((await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id);
		const reimport = await webRequest("/api/admin/roadmap/import", "POST", admin, referenceCatalog);
		expect(await json<any>(reimport)).toMatchObject({ imported: false, unchanged: true, catalogHash: referenceHash });
	});

	it("authorizes, audits, invalidates, and counts persisted release acceptance criteria independently", async () => {
		const criterion = await db.prepare("SELECT id,state FROM release_acceptance_criteria WHERE milestone_id='prototype' ORDER BY id LIMIT 1").first<any>();
		const before = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(before.milestones[1].acceptanceReadiness).toMatchObject({ verified: 0, total: 6 });
		expect(before.milestones[1].complete).toBe(false);
		const contributor = await credential("Acceptance denied", "collaborator", "acceptance-denied"), denied = await createWebSession(contributor.collaboratorId);
		expect((await webRequest(`/api/admin/roadmap/acceptance/${criterion.id}`, "PATCH", denied, { state: "verified", evidenceUrl: "https://example.org/proof", reason: "Unauthorized attempt" })).status).toBe(403);
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id, admin = await createWebSession(adminId);
		expect((await webRequest(`/api/admin/roadmap/acceptance/${criterion.id}`, "PATCH", admin, { state: "verified", reason: "Evidence must be required" })).status).toBe(409);
		const testing = await webRequest(`/api/admin/roadmap/acceptance/${criterion.id}`, "PATCH", admin, { state: "testing", reason: "Integration fixture is ready" });
		expect(testing.status).toBe(200);
		const verified = await webRequest(`/api/admin/roadmap/acceptance/${criterion.id}`, "PATCH", admin, { state: "verified", evidenceUrl: "https://example.org/prototype-check", reason: "Authorized fixture confirms the milestone criterion" });
		expect(verified.status).toBe(200);
		const after = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(after.milestones[1].acceptanceReadiness).toMatchObject({ verified: 1, total: 6 });
		expect(after.milestones[1].complete).toBe(false);
		expect(after.summary.nextRelease).toEqual(before.summary.nextRelease);
		const invalidated = await webRequest(`/api/admin/roadmap/acceptance/${criterion.id}`, "PATCH", admin, { state: "testing", reason: "Public evidence was withdrawn" });
		expect(invalidated.status).toBe(200);
		const row = await db.prepare("SELECT state,evidence_url AS evidenceUrl,verified_by AS verifiedBy,verified_at AS verifiedAt FROM release_acceptance_criteria WHERE id=?").bind(criterion.id).first<any>();
		expect(row).toMatchObject({ state: "testing", verifiedBy: null, verifiedAt: null });
		const history = await db.prepare("SELECT action,actor_id AS actorId,reason FROM release_acceptance_history WHERE criterion_id=? ORDER BY created_at,id").bind(criterion.id).all<any>();
		expect(history.results).toHaveLength(3);
		expect(history.results.map((item: any) => item.action)).toEqual(expect.arrayContaining(["acceptance.updated", "acceptance.verified", "acceptance.invalidated"]));
		expect(history.results.every((item: any) => item.actorId === adminId && item.reason.length >= 8)).toBe(true);
	});

	it("keeps optional requirements out of release readiness and restricts roadmap changes to maintainers", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		const adminSession = await createWebSession(adminId), contributor = await credential("Roadmap denied contributor", "collaborator", "roadmap-denied");
		const contributorSession = await createWebSession(contributor.collaboratorId);
		const deniedOperations = await Promise.all([
			webRequest("/api/admin/roadmap/features/commerce.barter", "PATCH", contributorSession, { state: "verified", reason: "Attempt unauthorized verification" }),
			webRequest("/api/admin/roadmap/features/commerce.barter/evidence", "POST", contributorSession, { url: "https://example.org/unauthorized-proof", label: "Unauthorized evidence", description: "Must not be accepted from a contributor." }),
			webRequest("/api/admin/roadmap/features/commerce.barter/tasks", "POST", contributorSession, { taskId: "no-such-task" }),
			webRequest("/api/admin/roadmap/import", "POST", contributorSession, roadmapCatalogFixture),
			webRequest("/api/admin/roadmap/evidence/no-such-evidence", "PATCH", contributorSession, { valid: false, reason: "Attempt unauthorized invalidation" }),
		]);
		expect(deniedOperations.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
		const evidence = await webRequest("/api/admin/roadmap/features/commerce.barter/evidence", "POST", adminSession, { url: "https://example.org/optional-validation", label: "Optional test evidence", description: "Validated in an isolated automated test." });
		expect(evidence.status).toBe(201);
		const verified = await webRequest("/api/admin/roadmap/features/commerce.barter", "PATCH", adminSession, { state: "verified", reason: "Optional requirement verified using test evidence." });
		expect(verified.status).toBe(200);
		const roadmapResponse = await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any), roadmap = await json<any>(roadmapResponse);
		expect(roadmap.summary.verified).toBe(1);
		expect(roadmap.summary.nextRelease).toMatchObject({ milestoneId: "prototype", verified: 0, total: 45 });
	});

	it("invalidates a verified feature when its last public evidence is invalidated and records history", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id, session = await createWebSession(adminId);
		const proof = await webRequest("/api/admin/roadmap/features/networking.authentication/evidence", "POST", session, { url: "https://example.org/networking-proof", label: "Protocol test", description: "Local deterministic integration validation." });
		const proofBody = await json<any>(proof);
		const setTesting = await webRequest("/api/admin/roadmap/features/networking.authentication", "PATCH", session, { state: "testing", reason: "Automated proof is ready for maintainer verification." });
		expect(setTesting.status).toBe(200);
		const verify = await webRequest("/api/admin/roadmap/features/networking.authentication", "PATCH", session, { state: "verified", reason: "Protocol test confirms the acceptance criteria." });
		expect(verify.status).toBe(200);
		const afterVerify = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(afterVerify.summary.verified).toBe(2);
		expect(afterVerify.summary.nextRelease).toMatchObject({ milestoneId: "prototype", verified: 1, total: 45 });
		const invalidated = await webRequest(`/api/admin/roadmap/evidence/${proofBody.evidenceId}`, "PATCH", session, { valid: false, reason: "Evidence was found to be incomplete." });
		expect(invalidated.status).toBe(200);
		const feature = await db.prepare("SELECT state,verified_by,verified_at FROM roadmap_feature_status WHERE feature_id='networking.authentication' AND scenario='actual'").first<any>();
		expect(feature).toMatchObject({ state: "testing", verified_by: null, verified_at: null });
		const afterInvalidation = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(afterInvalidation.summary.verified).toBe(1);
		expect(afterInvalidation.summary.nextRelease).toMatchObject({ milestoneId: "prototype", verified: 0, total: 45 });
		const evidenceRow = await db.prepare("SELECT created_by,is_valid FROM roadmap_feature_evidence WHERE id=?").bind(proofBody.evidenceId).first<any>();
		expect(evidenceRow).toMatchObject({ created_by: adminId, is_valid: 0 });
		const history = await webRequest("/api/admin/roadmap/history?limit=25", "GET", session), body = await json<any>(history);
		expect(body.items.some((item: any) => item.action === "feature.invalidated" && item.actor === "test-admin")).toBe(true);
		expect(body.items.some((item: any) => item.action === "feature.evidence_added" && item.actor === "test-admin")).toBe(true);
	});

	it("keeps demonstration roadmap state isolated and rejects demo mode on public hosts", async () => {
		const local = await worker.fetch(new Request("http://localhost/api/roadmap?scenario=demo"), runtimeEnv as any);
		expect(local.status).toBe(200); expect((await json<any>(local)).scenario).toBe("demo");
		const publicAttempt = await worker.fetch(new Request("https://rustkore.test/api/roadmap?scenario=demo"), runtimeEnv as any);
		expect(publicAttempt.status).toBe(403);
		const actual = await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any);
		expect((await json<any>(actual)).summary.verified).toBe(1);
	});

	it("filters functional requirements and paginates only the selected catalog slice", async () => {
		const firstResponse = await worker.fetch(new Request("https://rustkore.test/api/roadmap/features?category=networking&milestone=prototype&state=planned&limit=2"), runtimeEnv as any);
		expect(firstResponse.status).toBe(200);
		const first = await json<any>(firstResponse);
		expect(first.features).toHaveLength(2);
		expect(first.features.every((feature: any) => feature.categoryId === "networking" && feature.milestoneId === "prototype" && feature.state === "planned")).toBe(true);
		expect(first.nextCursor).toBeTruthy();
		const secondResponse = await worker.fetch(new Request(`https://rustkore.test/api/roadmap/features?category=networking&milestone=prototype&state=planned&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`), runtimeEnv as any);
		const second = await json<any>(secondResponse);
		expect(second.features.every((feature: any) => feature.categoryId === "networking" && feature.milestoneId === "prototype" && feature.state === "planned")).toBe(true);
		expect(second.features.some((feature: any) => first.features.some((prior: any) => prior.id === feature.id))).toBe(false);
		const invalidState = await worker.fetch(new Request("https://rustkore.test/api/roadmap/features?state=unknown"), runtimeEnv as any);
		expect(invalidState.status).toBe(400);
	});

	it("imports roadmap catalog idempotently while preserving status and task associations", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id, session = await createWebSession(adminId);
		const catalog = structuredClone(roadmapCatalogFixture);
		const first = await webRequest("/api/admin/roadmap/import", "POST", session, catalog);
		expect(first.status, await first.clone().text()).toBe(200); expect((await json<any>(first)).imported).toBe(true);
		const second = await webRequest("/api/admin/roadmap/import", "POST", session, catalog);
		expect((await json<any>(second)).unchanged).toBe(true);
		await db.prepare("UPDATE roadmap_feature_status SET state='developing',change_reason='Preserve across catalog refresh' WHERE feature_id='testing.roadmap-import' AND scenario='actual'").run();
		const task = await addTask("Roadmap import association fixture");
		const linked = await webRequest("/api/admin/roadmap/features/testing.roadmap-import/tasks", "POST", session, { taskId: task.id });
		expect(linked.status).toBe(201);
		const unlinked = await webRequest(`/api/admin/roadmap/features/testing.roadmap-import/tasks/${encodeURIComponent(task.id)}`, "DELETE", session);
		expect((await json<any>(unlinked)).linked).toBe(false);
		const relinked = await webRequest("/api/admin/roadmap/features/testing.roadmap-import/tasks", "POST", session, { taskId: task.id });
		expect(relinked.status).toBe(201);
		catalog.catalogVersion = "1.0.1"; catalog.features[0].description = "Updated catalog description while preserving implementation tracking.";
		const updated = await webRequest("/api/admin/roadmap/import", "POST", session, catalog);
		expect(updated.status).toBe(200);
		const proof = await webRequest("/api/admin/roadmap/features/testing.roadmap-import/evidence", "POST", session, { url: "https://example.org/import-preserved-proof", label: "Import preservation", description: "Evidence remains after a metadata-only catalog refresh." });
		const proofBody = await json<any>(proof);
		const verified = await webRequest("/api/admin/roadmap/features/testing.roadmap-import", "PATCH", session, { state: "testing", reason: "Prepare import fixture state for verification." });
		expect(verified.status).toBe(200);
		const verification = await webRequest("/api/admin/roadmap/features/testing.roadmap-import", "PATCH", session, { state: "verified", reason: "Local fixture evidence confirms the import preservation behavior." });
		expect(verification.status).toBe(200);
		catalog.catalogVersion = "1.0.2";
		catalog.features[0].upstreamReferences = ["https://github.com/OpenKore/openkore/blob/396c4c64f39a9dbc0b3f522754e4da5dfc3e1096/src/Network/Receive.pm"];
		const refreshed = await webRequest("/api/admin/roadmap/import", "POST", session, catalog);
		expect(refreshed.status).toBe(200);
		const feature = await db.prepare(`SELECT f.description,s.state,s.verified_by,
			(SELECT COUNT(*) FROM roadmap_feature_tasks ft WHERE ft.feature_id=f.id AND ft.active=1 AND ft.scenario='actual') AS links,
			(SELECT COUNT(*) FROM roadmap_feature_evidence e WHERE e.feature_id=f.id AND e.is_valid=1 AND e.scenario='actual') AS evidence
			FROM roadmap_features f JOIN roadmap_feature_status s ON s.feature_id=f.id AND s.scenario='actual' WHERE f.id='testing.roadmap-import'`).first<any>();
		expect(feature).toMatchObject({ description: catalog.features[0].description, state: "verified", verified_by: adminId, links: 1, evidence: 1 });
		const link = await db.prepare("SELECT linked_by FROM roadmap_feature_tasks WHERE feature_id='testing.roadmap-import' AND active=1 AND scenario='actual'").first<any>();
		expect(link.linked_by).toBe(adminId);
		const evidenceRow = await db.prepare("SELECT created_by,is_valid FROM roadmap_feature_evidence WHERE id=?").bind(proofBody.evidenceId).first<any>();
		expect(evidenceRow).toMatchObject({ created_by: adminId, is_valid: 1 });
		const history = await webRequest("/api/admin/roadmap/history?limit=25", "GET", session), historyBody = await json<any>(history);
		expect(historyBody.items.some((item: any) => item.featureId === "testing.roadmap-import" && item.action === "feature.task_linked" && item.actor === "test-admin")).toBe(true);
		expect(historyBody.items.some((item: any) => item.featureId === "testing.roadmap-import" && item.action === "feature.verified" && item.actor === "test-admin")).toBe(true);
		expect(proofBody.evidenceId).toBeTruthy();
	});

	it("marks a milestone complete only after cumulative mandatory features and integrated acceptance are verified", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id, session = await createWebSession(adminId), noRateLimitEnv = { ...runtimeEnv, API_RATE_LIMITER: { async limit() { return { success: true }; } } };
		const features = await db.prepare("SELECT id FROM roadmap_features WHERE active=1 AND is_required=1 AND milestone_id IN ('foundation','prototype')").all<any>();
		const statements: D1PreparedStatement[] = [];
		for (const [index, feature] of features.results.entries()) {
			const proofId = `gate-fixture-proof-${index}`, changeId = `gate-fixture-status-${index}`;
			statements.push(db.prepare(`INSERT INTO roadmap_feature_evidence (id,feature_id,scenario,url,label,description,is_valid,created_by,created_at,last_change_id)
				VALUES (?,?,'actual','https://example.org/deterministic-fixture','Gate fixture','Synthetic local test evidence only',1,?,unixepoch(),?)`).bind(proofId, feature.id, adminId, proofId));
			statements.push(db.prepare(`UPDATE roadmap_feature_status SET state='verified',updated_by=?,updated_at=unixepoch(),verified_by=?,verified_at=unixepoch(),last_change_id=?,change_reason='Local release gate test fixture' WHERE feature_id=? AND scenario='actual'`).bind(adminId, adminId, changeId, feature.id));
		}
		await db.batch(statements);
		const resetCache = await webRequest(`/api/admin/roadmap/features/${features.results[0].id}`, "PATCH", session, { state: "testing", reason: "Refresh the local release gate cache." }, noRateLimitEnv);
		expect(resetCache.status).toBe(200);
		await db.prepare("UPDATE roadmap_feature_status SET state='verified',verified_by=?,verified_at=unixepoch() WHERE feature_id=? AND scenario='actual'").bind(adminId, features.results[0].id).run();
		const beforeCriteria = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(beforeCriteria.milestones[1].readiness.verified).toBe(beforeCriteria.milestones[1].readiness.total);
		expect(beforeCriteria.milestones[1].complete).toBe(false);
		const criteria = (await db.prepare("SELECT id FROM release_acceptance_criteria WHERE milestone_id IN ('foundation','prototype') ORDER BY milestone_id,id").all<any>()).results;
		await db.batch(criteria.map((criterion: any, index: number) => db.prepare(`UPDATE release_acceptance_criteria SET state='verified',evidence_url='https://example.org/prototype-integrated-fixture',verified_by=?,verified_at=unixepoch(),updated_by=?,updated_at=unixepoch(),change_reason='Local integrated scenario has been checked.',last_change_id=? WHERE id=?`).bind(adminId, adminId, `gate-fixture-criterion-${index}`, criterion.id)));
		const refreshAcceptance = await webRequest(`/api/admin/roadmap/acceptance/${criteria[0].id}`, "PATCH", session, { state: "testing", reason: "Refresh the local acceptance gate cache." }, noRateLimitEnv);
		expect(refreshAcceptance.status).toBe(200);
		await db.prepare("UPDATE release_acceptance_criteria SET state='verified',evidence_url='https://example.org/prototype-integrated-fixture',verified_by=?,verified_at=unixepoch() WHERE id=?").bind(adminId, criteria[0].id).run();
		const complete = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(complete.milestones[1].acceptanceReadiness.verified).toBe(complete.milestones[1].acceptanceReadiness.total);
		expect(complete.milestones[1].complete).toBe(true);
		const blockedCriterion = criteria.at(-1)!;
		const invalidateAcceptance = await webRequest(`/api/admin/roadmap/acceptance/${blockedCriterion.id}`, "PATCH", session, { state: "testing", reason: "Integration evidence has been withdrawn." }, noRateLimitEnv);
		expect(invalidateAcceptance.status).toBe(200);
		const noLongerComplete = await json<any>(await worker.fetch(new Request("https://rustkore.test/api/roadmap"), runtimeEnv as any));
		expect(noLongerComplete.milestones[1].complete).toBe(false);
	});

	it("invalidates only previously verified requirements whose catalog criteria changed during migration", async () => {
		const adminId = (await db.prepare("SELECT id FROM collaborators WHERE github_user_id=99999").first<any>()).id;
		const changedId = "networking.authentication", unchangedId = "networking.server-selection", taskId = "migration-preserved-task";
		await db.batch([
			db.prepare("INSERT INTO tasks (id,title,description,acceptance_criteria,priority,status,created_by,created_at,updated_at,module) VALUES (?,?,'Migration preservation fixture','Task stays linked through catalog refresh',50,'open',?,unixepoch(),unixepoch(),'Networking')").bind(taskId,"Migration preservation task",adminId),
			db.prepare("INSERT INTO roadmap_feature_tasks (id,feature_id,task_id,scenario,linked_by,linked_at,active) VALUES ('migration-preserved-link',?,?,'actual',?,unixepoch(),1)").bind(changedId,taskId,adminId),
			db.prepare("UPDATE roadmap_features SET acceptance_criteria_json='[\"Superseded acceptance condition\"]' WHERE id=?").bind(changedId),
			db.prepare("UPDATE roadmap_feature_status SET state='verified',verified_by=?,verified_at=unixepoch(),updated_by=?,change_reason='Existing verified state for migration fixture' WHERE feature_id IN (?,?) AND scenario='actual'").bind(adminId,adminId,changedId,unchangedId),
			db.prepare("DELETE FROM roadmap_catalog_imports WHERE catalog_version=?").bind(roadmapMigrationReference.catalogVersion),
			db.prepare("DELETE FROM roadmap_change_history WHERE id=?").bind("roadmap-catalog-1-0-1"),
		]);
		await db.batch(migrationQueries(refinedRoadmapMigration).map((sql) => db.prepare(sql)));
		const states = await db.prepare("SELECT feature_id AS id,state,verified_by AS verifiedBy FROM roadmap_feature_status WHERE feature_id IN (?,?) AND scenario='actual' ORDER BY feature_id").bind(changedId,unchangedId).all<any>();
		expect(states.results.find((item: any) => item.id === changedId)).toMatchObject({ state: "testing", verifiedBy: null });
		expect(states.results.find((item: any) => item.id === unchangedId)).toMatchObject({ state: "verified", verifiedBy: adminId });
		expect(await db.prepare("SELECT 1 FROM roadmap_feature_tasks WHERE id='migration-preserved-link' AND active=1").first()).toBeTruthy();
		expect(await db.prepare("SELECT 1 FROM roadmap_change_history WHERE feature_id=? AND action='feature.invalidated'").bind(changedId).first()).toBeTruthy();
		const imported = await db.prepare("SELECT catalog_hash AS hash FROM roadmap_catalog_imports WHERE catalog_version=?").bind(roadmapMigrationReference.catalogVersion).first<any>();
		const recorded = await db.prepare("SELECT json_extract(details_json,'$.catalogHash') AS hash FROM roadmap_change_history WHERE id='roadmap-catalog-1-0-1'").first<any>();
		expect(recorded.hash).toBe(imported.hash);
	});


});
