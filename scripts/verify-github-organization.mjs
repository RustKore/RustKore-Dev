import { readFile } from "node:fs/promises";

const EXPECTED_ORG_ID = 361817169;
const EXPECTED_REPOSITORY_ID = 1472554035;
const EXPECTED_TEAMS = new Map([
	["Maintainers", 20908865],
	["Developers", null],
	["Release Managers", 20908882],
]);

function tokenFromDevVars(source) {
	for (const line of source.split(/\r?\n/)) {
		const match = line.match(/^\s*GITHUB_API_TOKEN\s*=\s*(.*?)\s*$/);
		if (match) return match[1].replace(/^(["'])(.*)\1$/, "$2");
	}
	return "";
}

let token = process.env.GITHUB_API_TOKEN ?? "";
if (!token) {
	try { token = tokenFromDevVars(await readFile(new URL("../.dev.vars", import.meta.url), "utf8")); }
	catch { /* The caller can set GITHUB_API_TOKEN in the environment. */ }
}
if (!token) {
	console.error("Missing GITHUB_API_TOKEN. Set it in the process environment or the ignored .dev.vars file.");
	process.exit(2);
}

const checks = [];
async function get(path, label) {
	let response;
	try {
		response = await fetch(`https://api.github.com${path}`, { headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"user-agent": "RustKore-org-access-verification",
			"x-github-api-version": "2022-11-28",
		}, signal: AbortSignal.timeout(8000) });
	} catch {
		checks.push({ check: label, status: "unavailable" });
		throw new Error("GitHub could not be reached; verification is inconclusive");
	}
	let data = null;
	if (response.ok) {
		try { data = await response.json(); }
		catch { checks.push({ check: label, status: response.status, result: "invalid-json" }); throw new Error("GitHub returned an ambiguous response"); }
	}
		checks.push({ check: label, status: response.status, endpointRequiredPermissions: response.headers.get("x-accepted-github-permissions") ?? "not reported" });
	if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}; no authorization conclusion was made`);
	return data;
}

function requireCheck(condition, label) {
	checks.push({ check: label, result: condition ? "pass" : "fail" });
	if (!condition) throw new Error(`${label} did not match the expected organization identity`);
}

try {
	const actor = await get("/user", "PAT identity");
	const org = await get("/orgs/RustKore", "organization identity");
	requireCheck(Number(org.id) === EXPECTED_ORG_ID && org.login === "RustKore", "Organization ID/name");

	const ownerLogin = (process.env.RUSTKORE_OWNER_GITHUB_LOGIN || actor.login).replace(/^@/, "");
	const owner = await get(`/users/${encodeURIComponent(ownerLogin)}`, "Owner GitHub identity");
	const membership = await get(`/orgs/RustKore/memberships/${encodeURIComponent(owner.login)}`, "Owner organization membership");
	requireCheck(Number(membership.user?.id) === Number(owner.id) && membership.state === "active" && membership.role === "admin", "Target is an active Organization Owner");

	const teams = [];
	let pageUrl = "/orgs/RustKore/teams?per_page=100";
	for (let page = 0; page < 10 && pageUrl; page++) {
		const pageData = await get(pageUrl, `organization teams page ${page + 1}`);
		if (!Array.isArray(pageData)) throw new Error("GitHub returned an ambiguous team directory");
		teams.push(...pageData);
		const next = pageUrl.match(/(?:\?|&)page=(\d+)/);
		const nextPage = next ? Number(next[1]) + 1 : 2;
		pageUrl = pageData.length === 100 ? `/orgs/RustKore/teams?per_page=100&page=${nextPage}` : "";
	}
	if (pageUrl) throw new Error("Team directory exceeded the verification pagination limit");
	const namedTeams = teams.filter((team) => EXPECTED_TEAMS.has(team.name));
	requireCheck(teams.length === EXPECTED_TEAMS.size && namedTeams.length === EXPECTED_TEAMS.size && new Set(namedTeams.map((team) => team.name)).size === EXPECTED_TEAMS.size, "Exact required team names and no extra teams");
	requireCheck(teams.every((team) => team.privacy === "closed" && team.parent == null), "All teams are Visible and independent");
	for (const [name, expectedId] of EXPECTED_TEAMS) {
		const team = namedTeams.find((item) => item.name === name);
		requireCheck(Boolean(team) && (expectedId === null || Number(team.id) === expectedId), `${name} team ID`);
	}
	requireCheck(!teams.some((team) => ["Administrators", "Contributors"].includes(String(team.name).toLowerCase())), "No legacy Administrators/Contributors teams");

	const repository = await get("/repos/RustKore/RustKore", "official software repository access");
	requireCheck(Number(repository.id) === EXPECTED_REPOSITORY_ID && repository.full_name === "RustKore/RustKore", "Software repository ID/name");
	await get("/repos/RustKore/RustKore/contents?per_page=1", "repository Contents read access");
	await get("/repos/RustKore/RustKore/pulls?state=all&per_page=1", "repository Pull requests read access");

	console.log(JSON.stringify({ verification: "read-only", result: "passed", organization: { id: org.id, login: org.login }, patIdentity: { id: actor.id, login: actor.login }, owner: { id: owner.id, login: owner.login, membershipRole: membership.role, membershipState: membership.state }, teams: namedTeams.map(({ id, name, slug, privacy, parent }) => ({ id, name, slug, privacy, parent: parent?.name ?? null })), repository: { id: repository.id, fullName: repository.full_name }, checks }, null, 2));
} catch (error) {
	console.error(JSON.stringify({ verification: "read-only", result: "inconclusive-or-failed", reason: error instanceof Error ? error.message : "verification failed", checks }, null, 2));
	process.exitCode = 1;
} finally {
	token = "";
}
