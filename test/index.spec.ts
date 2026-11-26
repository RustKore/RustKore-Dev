import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import initialMigration from "../migrations/0001_initial.sql?raw";
import submissionIntegrityMigration from "../migrations/0002_submission_integrity.sql?raw";
import githubDashboardMigration from "../migrations/0003_github_dashboard.sql?raw";
import normalizedUniquenessMigration from "../migrations/0004_normalized_contribution_uniqueness.sql?raw";
import activeTokenLimitMigration from "../migrations/0005_active_token_limit.sql?raw";
import githubIdentityCredentialMigration from "../migrations/0006_github_identity_credentials.sql?raw";

const db = (env as any).rustkore_db as D1Database;
let githubHeadSha: string | null = null;
let nextGithubId = 1000;
const commitOwners = new Map<string, number>();
const pullHeads = new Map<number, string>();
const pullAuthors = new Map<number, number>();
const runtimeEnv = { ...(env as any), GITHUB_REPOSITORY: "boscv/RustKore", RUSTKORE_ADMIN_GITHUB_IDS: "99999", github_api: { async fetch(request: Request) {
	const url = new URL(request.url), value = url.pathname.split("/").at(-1)!;
	if (url.hostname === "github.com") return new Response(JSON.stringify({ access_token: "discarded-oauth-access-token" }), { status: 200 });
	if (url.pathname === "/user") return new Response(JSON.stringify({ id: 75000, login: "external-collaborator", name: "External Collaborator", avatar_url: "https://avatars.githubusercontent.com/u/75000" }), { status: 200 });
	if (url.pathname.includes("/pulls/")) return new Response(JSON.stringify({ user: { id: pullAuthors.get(Number(value)) ?? Number(value) }, base: { repo: { full_name: "boscv/RustKore" } }, head: { sha: githubHeadSha ?? pullHeads.get(Number(value)) ?? "" }, merged: true, merge_commit_sha: "f".repeat(40) }), { status: 200 });
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
async function rpc(token: string, method: string, params: any = {}, requestId = 1) {
	const response = await worker.fetch(new Request("https://rustkore.test/mcp", {
		method: "POST", headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream", "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
		body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
	}), runtimeEnv as any);
	const body = await json<any>(response);
	return { response, body, output: body.result?.structuredContent ?? body.result?.content?.[0]?.text };
}
async function tool(token: string, name: string, args: any = {}) { return rpc(token, "tools/call", { name, arguments: args }); }
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
		return { token, tokenId, githubUserId, commitSha, pullRequestUrl: `https://github.com/boscv/RustKore/pull/${pullNumber}` };
	}
	return { token, tokenId, githubUserId };
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
async function addTask(title: string, priority = 50, dependencies?: string[]) {
	const response = await request("/admin/tasks", "POST", adminToken, { title, description: `Work on ${title}`, acceptanceCriteria: "Implementation is reviewed", priority, dependencies });
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
});
