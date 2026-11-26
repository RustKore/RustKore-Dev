import { ALPHA_FLOW_NODES, ALPHA_FLOW_PATHS, ROADMAP_STATES, alphaReadiness, buildDonutSegments, buildIsometricMilestones, deriveStateCounts, verifiedPercentage } from "/roadmap-visual.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (selector) => document.querySelector(selector);
const stateName = { planned: "Planned", developing: "Developing", testing: "Testing", verified: "Verified" };
const stateOrder = ["planned", "developing", "testing", "verified"];
let roadmap = null, categories = [], featureCursor = null, expandedCell = null, expandedFeatures = [], isAdmin = false, csrf = "", historyCursor = null;
const query = new URLSearchParams(location.search), localHost = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
let scenario = localHost && query.get("scenario") === "demo" ? "demo" : "actual";

const ICONS = {
	network: '<circle cx="12" cy="5" r="3"/><circle cx="6" cy="19" r="3"/><circle cx="18" cy="19" r="3"/><path d="m10.7 7.5-3.3 8.6m5.9-8.6 3.3 8.6M9 19h6"/>',
	"user-round": '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
	route: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h1.5a3.5 3.5 0 0 0 0-7h-1a3.5 3.5 0 0 1 0-7H15"/>',
	swords: '<path d="m14.5 17.5 3 3L22 16l-3-3M2 22l8.5-8.5M16 8l6-6M2 2l6 6m8 8L8 8"/><path d="m15 5 4 4"/>',
	zap: '<path d="M13 2 3 14h8l-1 8 11-12h-8z"/>',
	workflow: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a3 3 0 0 0 3 3h6m0-12h-3a3 3 0 0 0-3 3v3"/><path d="M15 6h6m-3-3v6"/>',
	backpack: '<path d="M6 7V5a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v2M5 7h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M8 7v4m8-4v4M3 14h18M9 14v3h6v-3"/>',
	gem: '<path d="M6 3h12l4 6-10 13L2 9z"/><path d="M2 9h20M9 3l-2 6 5 13 5-13-2-6"/>',
	"messages-square": '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/>',
	warehouse: '<path d="m3 9 9-6 9 6v12H3z"/><path d="M3 9h18M8 21v-8h8v8m-7-5h6"/>',
	coins: '<circle cx="8" cy="8" r="6"/><path d="M6.5 6.5h3m-3 3h3M14 4.5a6 6 0 0 1 0 11M8 14a6 6 0 0 0 6 6h4a4 4 0 0 0 0-8h-4"/>',
	users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m3-11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm15 11v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
	"paw-print": '<circle cx="7.5" cy="8.5" r="2.5"/><circle cx="16.5" cy="8.5" r="2.5"/><circle cx="5" cy="14" r="2"/><circle cx="19" cy="14" r="2"/><path d="M12 13c-3 0-6 4.2-4.2 6.3 1.1 1.3 2.7-.1 4.2-.1s3.1 1.4 4.2.1C18 17.2 15 13 12 13Z"/>',
	hammer: '<path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9m-2-2 4-4 7 7-4 4m-1-12 5 5"/>',
	settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m19.4 15 .1.1 1.4 1.1-1.4 2.4-1.7-.7a8 8 0 0 1-1.6.9L16 21h-2.8l-.4-1.9a8 8 0 0 1-1.6-.9l-1.7.7-1.4-2.4 1.4-1.1a8 8 0 0 1 0-1.8l-1.4-1.1 1.4-2.4 1.7.7a8 8 0 0 1 1.6-.9L13.2 8H16l.4 1.9a8 8 0 0 1 1.6.9l1.7-.7 1.4 2.4-1.4 1.1a8 8 0 0 1-.3 1.4Z"/>',
	code: '<path d="m8 17-5-5 5-5m8 0 5 5-5 5m-2-12-4 14"/>',
	monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4"/>',
	activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
	package: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v9l9 5 9-5V8m-9 5v9m-4-17 9 5"/>',
	"heart-pulse": '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/><path d="M3 12h4l2-3 3 6 2-3h7"/>',
};

const CATEGORY_ICONS = {
	networking: "network", world: "user-round", navigation: "route", combat: "swords", skills: "zap", ai: "workflow",
	inventory: "backpack", loot: "gem", npcs: "messages-square", storage: "warehouse", commerce: "coins", social: "users",
	companions: "paw-print", crafting: "hammer", configuration: "settings", scripting: "code", ui: "monitor", reliability: "activity",
};

function node(tag, cls, text) { const out = document.createElement(tag); if (cls) out.className = cls; if (text !== undefined) out.textContent = text; return out; }
function svgElement(tag, attrs = {}) { const element = document.createElementNS(SVG_NS, tag); for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, String(value)); return element; }
function iconSvg(name, className = "", size = 24) {
	const svg = svgElement("svg", { viewBox: "0 0 24 24", width: size, height: size, "aria-hidden": "true", focusable: "false" });
	if (className) svg.setAttribute("class", className);
	svg.setAttribute("stroke-width", "1.5"); svg.setAttribute("stroke-linecap", "round"); svg.setAttribute("stroke-linejoin", "round");
	svg.innerHTML = ICONS[name] ?? ICONS.activity;
	return svg;
}
function notice(message) { const el = $("#roadmap-notice"); el.textContent = message; el.classList.add("visible"); setTimeout(() => el.classList.remove("visible"), 3500); }
async function request(url, options = {}) {
	const response = await fetch(url, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.method && options.method !== "GET" ? { "x-rustkore-csrf": csrf } : {}), ...(options.headers || {}) } });
	const data = await response.json(); if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`); return data;
}
const fmt = (value) => new Intl.NumberFormat("en").format(Number(value) || 0);

function renderHero() {
	$("#capability-count").textContent = fmt(roadmap.summary.total);
	$("#category-count").textContent = fmt(roadmap.categories.length);
	$("#milestone-count").textContent = fmt(roadmap.milestones.length);
	const svg = svgElement("svg", { viewBox: "0 0 420 280", role: "img", "aria-labelledby": "milestone-art-title milestone-art-description" });
	const title = svgElement("title", { id: "milestone-art-title" }); title.textContent = "Six planned release milestones";
	const desc = svgElement("desc", { id: "milestone-art-description" }); desc.textContent = "An isometric sequence of six ascending platforms joined by a route, with an intermediate marker at Alpha and a flag at Stable.";
	svg.append(title, desc);
	const platforms = buildIsometricMilestones();
	const points = (list) => list.map(({ x, y }) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
	for (const platform of platforms) {
		const xFace = svgElement("polygon", { points: points(platform.xFace), class: "milestone-platform-side-x" });
		const yFace = svgElement("polygon", { points: points(platform.yFace), class: "milestone-platform-side-y" });
		const top = svgElement("polygon", { points: points(platform.top), class: "milestone-platform-top" });
		svg.append(xFace, yFace, top);
	}
	const route = svgElement("polyline", { points: points(platforms.map((platform) => platform.route)), class: "milestone-route" }); svg.append(route);
	const start = svgElement("circle", { cx: platforms[0].route.x, cy: platforms[0].route.y, r: 4, class: "milestone-start" }); svg.append(start);
	const alpha = svgElement("circle", { cx: platforms[2].route.x, cy: platforms[2].route.y, r: 6, class: "milestone-alpha" }); svg.append(alpha);
	const last = platforms.at(-1).flag;
	svg.append(svgElement("line", { x1: platforms.at(-1).route.x, y1: platforms.at(-1).route.y, x2: last.poleTop.x, y2: last.poleTop.y, class: "milestone-flag-post" }));
	svg.append(svgElement("polygon", { points: points([last.poleTop, last.outerTop, last.outerBottom]), class: "milestone-flag" }));
	$("#roadmap-hero-art").replaceChildren(svg);
}

function milestoneState(milestone) {
	if (milestone.complete === true) return "complete";
	return milestone.status === "developing" ? "current" : "planned";
}

function renderMilestones() {
	const list = $("#milestone-list"); list.replaceChildren();
	roadmap.milestones.forEach((milestone, index) => {
		const item = node("li", "milestone-item"), selected = index === (window.selectedMilestoneIndex || 0), state = milestoneState(milestone);
		item.dataset.state = state; if (selected) item.setAttribute("aria-current", "step");
		const button = node("button", "milestone-select"); button.type = "button"; button.setAttribute("aria-pressed", String(selected));
		button.setAttribute("aria-label", `${milestone.name}${milestone.targetVersion ? ` ${milestone.targetVersion}` : ""}, ${stateName[state] ?? "Planned"}, ${milestone.readiness.verified} of ${milestone.readiness.total} mandatory requirements verified. View its requirements in Feature Coverage.`);
		const marker = node("span", "milestone-marker"); marker.setAttribute("aria-hidden", "true");
		if (state === "complete") { const check = svgElement("svg", { viewBox: "0 0 16 16" }); check.append(svgElement("path", { d: "m3 8.5 3.2 3.2L13 4.8" })); marker.append(check); }
		const details = node("span", "milestone-details");
		details.append(node("span", "milestone-name", milestone.name), node("span", "milestone-version", milestone.targetVersion || "—"), node("span", "milestone-readiness", `${fmt(milestone.readiness.verified)} / ${fmt(milestone.readiness.total)} required`), node("span", "milestone-state", state === "complete" ? "Complete" : state === "current" ? "In progress" : "Planned"));
		const legend = node("span", "milestone-legend", milestone.id === "alpha" ? "First usable release" : milestone.id === "stable" ? "Stable release" : "");
		details.append(legend); button.append(marker, details);
		button.addEventListener("click", () => {
			window.selectedMilestoneIndex = index;
			renderMilestones(); renderAcceptance(); renderTable();
			const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
			const coverage = $("#coverage"), header = document.querySelector(`.coverage-table thead th[data-milestone-column="${CSS.escape(milestone.id)}"]`);
			coverage.scrollIntoView({ behavior, block: "start" });
			if (header) {
				header.tabIndex = -1;
				header.focus({ preventScroll: true });
				const scroller = $(".table-scroll"), target = header.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
				const desiredLeft = scroller.scrollLeft + target.left - bounds.left - (scroller.clientWidth - target.width) / 2;
				scroller.scrollTo({ left: Math.max(0, Math.min(scroller.scrollWidth - scroller.clientWidth, desiredLeft)), behavior });
			}
		});
		item.append(button); list.append(item);
	});
}

function renderDonut() {
	const counts = deriveStateCounts(roadmap), percent = verifiedPercentage(counts), container = $("#implementation-donut"), legend = $("#implementation-legend");
	const svg = svgElement("svg", { viewBox: "0 0 200 200", role: "img", "aria-label": counts.total ? `Implementation status: ${counts.verified} verified, ${counts.testing} testing, ${counts.developing} developing, ${counts.planned} planned; ${counts.total} total.` : "No requirements" });
	const title = svgElement("title"); title.textContent = counts.total ? `${percent}% of functional requirements verified` : "No requirements"; svg.append(title);
	if (counts.total) {
		svg.append(svgElement("circle", { cx: 100, cy: 100, r: 78, class: "donut-track" }));
		for (const segment of buildDonutSegments(counts)) svg.append(svgElement("circle", { cx: 100, cy: 100, r: 78, class: "donut-segment", "data-state": segment.state, "stroke-dasharray": `${segment.length} ${segment.remainder}`, "stroke-dashoffset": segment.offset }));
		const pct = svgElement("text", { x: 100, y: 98, class: "donut-percentage" }); pct.textContent = `${percent}%`;
		const caption = svgElement("text", { x: 100, y: 119, class: "donut-caption" }); caption.textContent = "Verified"; svg.append(pct, caption);
	} else {
		svg.append(svgElement("circle", { cx: 100, cy: 100, r: 78, class: "donut-track" }));
		const empty = svgElement("text", { x: 100, y: 104, class: "donut-empty-label" }); empty.textContent = "No requirements"; svg.append(empty);
	}
	container.replaceChildren(svg); legend.replaceChildren();
	for (const state of ROADMAP_STATES) {
		const row = node("div", "implementation-legend-row"), swatch = node("span", "legend-swatch"); swatch.dataset.state = state; swatch.setAttribute("aria-hidden", "true");
		row.append(swatch, node("span", "", stateName[state]), node("strong", "", fmt(counts[state]))); legend.append(row);
	}
	const total = node("div", "implementation-total"); total.append(node("span", "", "Total catalog"), node("strong", "", fmt(counts.total))); legend.append(total);
}

function renderFlowIcon(name, centerX, topY) {
	const svg = svgElement("svg", { x: centerX - 8, y: topY, width: 16, height: 16, viewBox: "0 0 24 24", class: "flow-icon", "aria-hidden": "true", focusable: "false" });
	svg.innerHTML = ICONS[name] ?? ICONS.activity; return svg;
}

function renderFirstRelease() {
	const svg = svgElement("svg", { viewBox: "0 0 360 210", role: "img", "aria-labelledby": "alpha-flow-title alpha-flow-description" });
	const title = svgElement("title", { id: "alpha-flow-title" }); title.textContent = "Planned Alpha autonomous gameplay loop";
	const desc = svgElement("desc", { id: "alpha-flow-description" }); desc.textContent = "Connect, navigate, combat, use skills, collect loot, recover HP and SP, then return to navigation."; svg.append(title, desc);
	const defs = svgElement("defs"), marker = svgElement("marker", { id: "alpha-arrow", viewBox: "0 0 6 6", markerWidth: 6, markerHeight: 6, markerUnits: "userSpaceOnUse", refX: 6, refY: 3, orient: "auto" });
	marker.append(svgElement("path", { d: "M0 0 L6 3 L0 6Z", class: "flow-arrow" })); defs.append(marker); svg.append(defs);
	for (const flow of ALPHA_FLOW_PATHS) svg.append(svgElement("path", { d: flow.d, class: "flow-connector", "data-from": flow.from, "data-to": flow.to }));
	for (const item of ALPHA_FLOW_NODES) {
		const group = svgElement("g", { "data-node": item.id, role: "group", "aria-label": item.label });
		group.append(svgElement("rect", { x: item.x, y: item.y, width: item.width, height: item.height, rx: item.radius, class: "flow-node" }));
		group.append(renderFlowIcon(item.icon, item.x + item.width / 2, item.y + 6));
		const label = svgElement("text", { x: item.x + item.width / 2, y: item.y + 43, class: "flow-label" }); label.textContent = item.label; group.append(label); svg.append(group);
	}
	$("#first-release-flow").replaceChildren(svg);
	const readiness = alphaReadiness(roadmap.milestones); $("#alpha-readiness").textContent = `${fmt(readiness.verified)} / ${fmt(readiness.total)} requirements verified`;
}

function renderHeroContent() { renderHero(); renderDonut(); renderFirstRelease(); }

function updateFilterOptions() {
	const cat = $("#filter-category"), milestone = $("#filter-milestone"); categories.forEach((item) => cat.append(new Option(item.name, item.id)));
	roadmap.milestones.forEach((item) => milestone.append(new Option(item.name, item.id)));
}

function coverageMap() { const map = new Map(); roadmap.coverage.forEach((cell) => map.set(`${cell.categoryId}|${cell.milestoneId}`, cell)); return map; }

function stateIcon(state) {
	const svg = svgElement("svg", { viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false", class: `state-icon state-${state}` });
	if (state === "testing") svg.append(svgElement("path", { d: "M5 2h6M6 2v4l-3.2 5.5A1.7 1.7 0 0 0 4.3 14h7.4a1.7 1.7 0 0 0 1.5-2.5L10 6V2M4.8 10h6.4" }));
	else if (state === "verified") svg.append(svgElement("path", { d: "m3 8 3.2 3.2L13 4.5" }));
	else {
		svg.append(svgElement("circle", { cx: 8, cy: 8, r: 6 }));
		if (state === "developing") svg.append(svgElement("path", { d: "M8 2a6 6 0 0 0 0 12Z", fill: "currentColor", stroke: "none" }));
	}
	return svg;
}

function selectedMilestoneId() { return roadmap.milestones[window.selectedMilestoneIndex || 0]?.id; }

function renderTable() {
	const tbody = $("#coverage-body"), selectedCategory = $("#filter-category").value, selectedMilestone = $("#filter-milestone").value, selectedState = $("#filter-state").value, cells = coverageMap(), selectedId = selectedMilestoneId();
	tbody.replaceChildren();
	const visibleCats = categories.filter((category) => !selectedCategory || category.id === selectedCategory);
	visibleCats.forEach((category) => {
		const row = node("tr", "category-row"), label = node("th", "category-name"); label.scope = "row";
		const categoryLabel = node("span", "category-label"); categoryLabel.append(iconSvg(CATEGORY_ICONS[category.id] ?? "activity", "category-icon", 16), node("span", "", category.name)); label.append(categoryLabel); row.append(label);
		roadmap.milestones.forEach((milestone) => {
			const td = node("td"); td.dataset.milestoneColumn = milestone.id; if (milestone.id === selectedId) td.dataset.selectedColumn = "true"; row.append(td);
			const cell = cells.get(`${category.id}|${milestone.id}`);
			if (selectedMilestone && selectedMilestone !== milestone.id) { td.textContent = "—"; return; }
			if (!cell || !Number(cell.total)) { td.textContent = "—"; return; }
			const counts = { planned: Number(cell.planned || 0), developing: Number(cell.developing || 0), testing: Number(cell.testing || 0), verified: Number(cell.verified || 0) };
			const available = selectedState ? counts[selectedState] : Object.values(counts).reduce((sum, amount) => sum + amount, 0);
			if (!available) { td.textContent = "—"; return; }
			const status = selectedState || stateOrder.find((state) => counts[state] > 0) || "planned", button = node("button", "coverage-cell"); button.type = "button";
			button.append(stateIcon(status), node("span", "", `${counts.verified}/${Number(cell.total)}`));
			if (selectedState) button.lastChild.textContent = `${counts.verified}/${Number(cell.total)} · ${counts[selectedState]} ${stateName[selectedState].toLowerCase()}`;
			button.setAttribute("aria-label", `${category.name}, ${milestone.name}: ${counts.verified} of ${Number(cell.total)} verified; ${stateName[status]} status. Select to expand requirements.`);
			button.addEventListener("click", () => toggleCell(category.id, milestone.id)); td.append(button);
		});
		tbody.append(row);
		if (expandedCell?.categoryId === category.id) {
			const expanded = node("tr", "coverage-expand-row"), td = node("td"); td.colSpan = 7; td.dataset.milestoneColumn = expandedCell.milestoneId; td.dataset.selectedColumn = String(expandedCell.milestoneId === selectedId); td.append(renderFeatureExpansion()); expanded.append(td); tbody.append(expanded);
		}
	});
	if (!visibleCats.length) { const row = node("tr"), cell = node("td", "", "No categories match this filter."); cell.colSpan = 7; row.append(cell); tbody.append(row); }
	document.querySelectorAll(".coverage-table thead th[data-milestone-column]").forEach((header) => { header.dataset.selectedColumn = String(header.dataset.milestoneColumn === selectedId); });
}

async function toggleCell(categoryId, milestoneId) {
	if (expandedCell?.categoryId === categoryId && expandedCell?.milestoneId === milestoneId) { expandedCell = null; renderTable(); return; }
	expandedCell = { categoryId, milestoneId }; expandedFeatures = []; featureCursor = null; renderTable(); await loadFeatures(false);
}

function renderFeatureExpansion() {
	const wrap = node("div", "feature-expansion"), list = node("ul", "feature-list");
	if (!expandedFeatures.length) list.append(node("li", "feature-item roadmap-note", "Loading requirements…"));
	expandedFeatures.forEach((feature) => list.append(renderFeature(feature)));
	wrap.append(list);
	if (featureCursor) { const more = node("button", "button button-quiet", "Load more requirements"); more.type = "button"; more.addEventListener("click", () => loadFeatures(true)); wrap.append(more); }
	return wrap;
}

function renderFeature(feature) {
	const item = node("li", "feature-item"), head = node("div", "feature-head"), title = node("h3", "", feature.title), state = node("span", `feature-state state-${feature.state}`, `${feature.state === "testing" ? "⚗ " : feature.state === "verified" ? "✓ " : "○ "}${stateName[feature.state]}`);
	head.append(title, state); item.append(head, node("code", "", feature.id), node("p", "feature-description", feature.description));
	const facts = node("div", "feature-facts"); facts.append(node("span", "", feature.milestone), node("span", "", feature.required ? "Required" : "Optional"), node("span", "", feature.verifiedBy ? `Verified by @${feature.verifiedBy}` : "Not verified")); item.append(facts);
	if (feature.acceptanceCriteria?.length) { item.append(node("strong", "", "Acceptance criteria")); const list = node("ul"); feature.acceptanceCriteria.forEach((text) => list.append(node("li", "", text))); item.append(list); }
	if (feature.tasks?.length) {
		const box = node("div", "feature-tasks"); box.append(node("strong", "", "Related tasks")); const list = node("ul");
		feature.tasks.forEach((task) => { const li = node("li"), link = node("a", "", `${task.id} · ${task.title}`); link.href = `/#task/${encodeURIComponent(task.id)}`; li.append(link); if (isAdmin && feature.scenario !== "demo") { const unlink = node("button", "button button-quiet", "Unlink"); unlink.type = "button"; unlink.addEventListener("click", async () => { try { await request(`/api/admin/roadmap/features/${encodeURIComponent(feature.id)}/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" }); notice("Task unlinked."); await refresh(); } catch (error) { notice(error.message); } }); li.append(unlink); } list.append(li); }); box.append(list); item.append(box);
	}
	if (feature.evidence?.length) {
		const box = node("div", "feature-evidence"); box.append(node("strong", "", "Public validation evidence")); const list = node("ul");
		feature.evidence.forEach((evidence) => { const li = node("li"), link = node("a", "", evidence.label); link.href = evidence.url; link.target = "_blank"; link.rel = "noreferrer"; li.append(link, node("span", "", ` · ${evidence.description} · @${evidence.createdBy}`)); if (isAdmin && feature.scenario !== "demo") { const invalidate = node("button", "button button-quiet", "Invalidate evidence"); invalidate.type = "button"; invalidate.addEventListener("click", async () => { const reason = prompt("Reason for invalidating this evidence (at least 8 characters):"); if (reason === null) return; try { await request(`/api/admin/roadmap/evidence/${encodeURIComponent(evidence.id)}`, { method: "PATCH", body: JSON.stringify({ valid: false, reason }) }); notice("Evidence invalidated."); await refresh(); } catch (error) { notice(error.message); } }); li.append(invalidate); } list.append(li); }); box.append(list); item.append(box);
	}
	if (isAdmin && feature.scenario !== "demo") item.append(renderAdminControls(feature));
	return item;
}

function renderAdminControls(feature) {
	const box = node("div", "feature-admin-controls"), stateLabel = node("label", "", "State"), select = document.createElement("select");
	stateOrder.forEach((state) => select.append(new Option(stateName[state], state))); select.value = feature.state; stateLabel.append(select);
	const reasonLabel = node("label", "", "Change reason"), reason = document.createElement("input"); reason.maxLength = 800; reason.placeholder = "Reason (at least 8 characters)"; reasonLabel.append(reason);
	const save = node("button", "button button-small", "Save state"); save.type = "button"; save.addEventListener("click", async () => { try { await request(`/api/admin/roadmap/features/${encodeURIComponent(feature.id)}`, { method: "PATCH", body: JSON.stringify({ state: select.value, reason: reason.value }) }); notice("Feature state updated."); await refresh(); } catch (error) { notice(error.message); } }); box.append(stateLabel, reasonLabel, save);
	const urlLabel = node("label", "wide", "Validation evidence URL"), url = document.createElement("input"); url.type = "url"; url.placeholder = "https://…"; urlLabel.append(url);
	const evidenceLabel = node("label", "", "Evidence label"), evidenceTitle = document.createElement("input"); evidenceTitle.maxLength = 160; evidenceLabel.append(evidenceTitle);
	const descriptionLabel = node("label", "", "Description"), description = document.createElement("input"); description.maxLength = 800; descriptionLabel.append(description);
	const addEvidence = node("button", "button button-small", "Add evidence"); addEvidence.type = "button"; addEvidence.addEventListener("click", async () => { try { await request(`/api/admin/roadmap/features/${encodeURIComponent(feature.id)}/evidence`, { method: "POST", body: JSON.stringify({ url: url.value, label: evidenceTitle.value, description: description.value }) }); notice("Evidence added."); await refresh(); } catch (error) { notice(error.message); } }); box.append(urlLabel, evidenceLabel, descriptionLabel, addEvidence);
	const taskLabel = node("label", "", "Link task ID"), task = document.createElement("input"); task.maxLength = 100; task.placeholder = "Existing task ID"; taskLabel.append(task);
	const link = node("button", "button button-small", "Link task"); link.type = "button"; link.addEventListener("click", async () => { try { await request(`/api/admin/roadmap/features/${encodeURIComponent(feature.id)}/tasks`, { method: "POST", body: JSON.stringify({ taskId: task.value }) }); notice("Task linked."); await refresh(); } catch (error) { notice(error.message); } }); box.append(taskLabel, link); return box;
}

async function loadFeatures(next) {
	const cell = expandedCell; if (!cell) return;
	const params = new URLSearchParams({ category: cell.categoryId, milestone: cell.milestoneId, limit: "25" }), state = $("#filter-state").value;
	if (state) params.set("state", state); if (next && featureCursor) params.set("cursor", featureCursor);
	try { const data = await request(`/api/roadmap/features?${params}`); expandedFeatures = next ? expandedFeatures.concat(data.features) : data.features; featureCursor = data.nextCursor; renderTable(); }
	catch (error) { notice(error.message); }
}

function renderAcceptance() {
	const selected = roadmap.milestones[window.selectedMilestoneIndex || 0], list = $("#acceptance-list"); list.replaceChildren();
	$("#acceptance-milestone").textContent = `${selected.name}${selected.targetVersion ? ` · ${selected.targetVersion}` : ""}`;
	$("#acceptance-objective").textContent = selected.objective;
	$("#acceptance-caption").textContent = "Required scope accumulates from earlier milestones; optional items do not block a release.";
	const criteria = selected.acceptanceCriteria || [];
	if (!criteria.length) { const empty = node("li", "acceptance-empty", "No release acceptance checklist is defined for this milestone yet."); list.append(empty); return; }
	criteria.forEach((criterion) => {
		const item = node("li", "acceptance-item"), state = criterion.state || "planned";
		item.append(stateIcon(state), node("span", "", criterion.description), node("span", "acceptance-state", stateName[state] || "Planned"));
		if (isAdmin && scenario === "actual") {
			const controls = node("div", "roadmap-admin-controls"), statusLabel = node("label", "", "State"), status = node("select");
			status.setAttribute("aria-label", `State for ${criterion.id}`);
			["planned", "testing", "verified"].forEach((value) => { const option = node("option", "", stateName[value]); option.value = value; status.append(option); }); status.value = state;
			statusLabel.append(status);
			const evidenceLabel = node("label", "", "Public evidence URL"), evidence = node("input"); evidence.type = "url"; evidence.maxLength = 2048; evidence.value = criterion.evidenceUrl || ""; evidenceLabel.append(evidence);
			const reasonLabel = node("label", "", "Reason"), reason = node("input"); reason.maxLength = 800; reasonLabel.append(reason);
			const save = node("button", "button button-small", "Save acceptance status"); save.type = "button";
			save.addEventListener("click", async () => { try { await request(`/api/admin/roadmap/acceptance/${encodeURIComponent(criterion.id)}`, { method: "PATCH", body: JSON.stringify({ state: status.value, evidenceUrl: evidence.value, reason: reason.value }) }); notice("Release acceptance status updated."); await refresh(); } catch (error) { notice(error.message); } });
			controls.append(statusLabel, evidenceLabel, reasonLabel, save); item.append(controls);
		}
		list.append(item);
	});
}

function renderHistory(items, append = false) {
	const list = $("#roadmap-history-list"); if (!append) list.replaceChildren();
	items.forEach((item) => { const row = node("li"), label = node("span", "", `${item.action.replaceAll(".", " ")}${item.featureTitle ? ` · ${item.featureTitle}` : ""}`), time = node("small", "", `@${item.actor || "system"} · ${new Date(item.createdAt * 1000).toLocaleString()}`); row.append(label, time); list.append(row); });
}
async function loadHistory(append = false) {
	try { const params = new URLSearchParams({ limit: "25" }); if (append && historyCursor) params.set("cursor", historyCursor); const data = await request(`/api/admin/roadmap/history?${params}`); renderHistory(data.items, append); historyCursor = data.nextCursor; $("#roadmap-history-more").hidden = !historyCursor; }
	catch (error) { notice(error.message); }
}

async function refresh() {
	roadmap = await request(`/api/roadmap${scenario === "demo" ? "?scenario=demo" : ""}`);
	if (window.selectedMilestoneIndex === undefined) window.selectedMilestoneIndex = Math.max(0, roadmap.milestones.findIndex((milestone) => milestone.status === "planned"));
	renderHeroContent(); renderMilestones(); renderAcceptance(); renderTable();
}

async function init() {
	try {
		if (localHost) {
			$("#scenario-switch").hidden = false;
			document.querySelectorAll("[data-scenario]").forEach((button) => { button.setAttribute("aria-pressed", String(button.dataset.scenario === scenario)); button.addEventListener("click", () => { scenario = button.dataset.scenario; const url = new URL(location.href); scenario === "demo" ? url.searchParams.set("scenario", "demo") : url.searchParams.delete("scenario"); history.replaceState(null, "", url); $("#scenario-banner").hidden = scenario !== "demo"; document.querySelectorAll("[data-scenario]").forEach((item) => item.setAttribute("aria-pressed", String(item.dataset.scenario === scenario))); refresh(); }); });
		}
		$("#scenario-banner").hidden = scenario !== "demo";
		const session = await request("/api/me");
		if (session.authenticated) { csrf = session.csrfToken || ""; isAdmin = Boolean(session.isAdmin); $("#roadmap-login").hidden = true; $("#roadmap-account-link").hidden = false; if (isAdmin) { $("#roadmap-admin").hidden = false; $("#roadmap-admin-link").hidden = false; } }
		roadmap = await request(`/api/roadmap${scenario === "demo" ? "?scenario=demo" : ""}`); categories = roadmap.categories;
		window.selectedMilestoneIndex = Math.max(0, roadmap.milestones.findIndex((milestone) => milestone.status === "planned"));
		updateFilterOptions(); renderHeroContent(); renderMilestones(); renderAcceptance(); renderTable();
		["#filter-category", "#filter-milestone", "#filter-state"].forEach((selector) => $(selector).addEventListener("change", () => { expandedCell = null; expandedFeatures = []; featureCursor = null; renderTable(); }));
		$("#clear-roadmap-filters").addEventListener("click", () => { ["#filter-category", "#filter-milestone", "#filter-state"].forEach((selector) => { $(selector).value = ""; }); expandedCell = null; expandedFeatures = []; featureCursor = null; renderTable(); });
		$("#load-roadmap-history").addEventListener("click", () => loadHistory(false)); $("#roadmap-history-more").addEventListener("click", () => loadHistory(true));
	} catch (error) {
		$("#coverage-body").replaceChildren(); const row = node("tr"), cell = node("td", "", `Roadmap could not be loaded. ${error.message}`); cell.colSpan = 7; row.append(cell); $("#coverage-body").append(row);
	}
}

init();
