const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const el = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
const count = value => Number(value || 0).toLocaleString("en-US");
const STATE = { available: "Available", blocked: "Blocked", reserved: "In progress", in_review: "In review", approved: "Approved", integrated: "Integrated" };
const COMPLEXITY = { small: "Small", medium: "Medium", large: "Large", extra_large: "Extra Large" };
const AWARDS = { builder: "Builder", reviewer: "Reviewer", specialist: "Specialist", architect: "Architect", guardian: "Guardian", maintainer: "Maintainer" };
const ACTIVITY = { "task.claimed": "reserved a task", "task.submitted": "submitted a contribution", "submission.accepted": "approved a contribution", "submission.rejected": "requested changes", "task.integrated": "integrated a contribution" };
let dashboard = null, csrf = "", account = null, catalog = [], catalogCursor = null, catalogRequest = 0, range = "90", refreshTimer = 0, refreshDelay = 60_000, lastFingerprint = "", lastCatalogQuery = "";
let rankingCursor = null, rankingItems = [], rankingQuery = "", activityCursor = null, activityStack = [], activityRequestSeq = 0, contributionCursor = null, contributionStack = [], contributionRequestSeq = 0, moduleSort = "module", moduleSortDirection = 1;
let taskDependencyPicker = null;

function notice(message) {
 const box = $("#notice"); box.textContent = message; box.classList.add("show"); clearTimeout(notice.timer);
 notice.timer = setTimeout(() => box.classList.remove("show"), 3600);
}
async function api(path, options = {}) {
 const headers = new Headers(options.headers || {});
 if (options.body) headers.set("content-type", "application/json");
 if (["POST", "PATCH", "PUT", "DELETE"].includes(options.method)) { headers.set("x-csrf-token", csrf); headers.set("origin", location.origin); }
 const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
 const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
 if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
 return data;
}
const dateTime = seconds => seconds ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(Number(seconds) * 1000)) : "Date unavailable";
const shortDate = seconds => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Number(seconds) * 1000));
function timeAgo(timestamp) {
 if (!timestamp) return "";
 const seconds = Math.max(0, Math.floor(Date.now() / 1000 - Number(timestamp)));
 if (seconds < 60) return "just now";
 if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
 if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
 return `${Math.floor(seconds / 86400)}d ago`;
}
function safeGitHubUrl(value) {
 try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" ? url.href : null; } catch { return null; }
}
function safeAvatarUrl(value) {
 try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "avatars.githubusercontent.com" ? url.href : null; } catch { return null; }
}
function setLink(link, href, label) { if (!href) return; link.href = href; link.textContent = label; link.target = "_blank"; link.rel = "noreferrer"; }
function statusLabel(state) { return STATE[state] || state || "Unknown"; }
function contributionStatusLabel(state) { return state === "rejected" ? "Changes requested" : statusLabel(state === "pending" ? "in_review" : state === "accepted" ? "approved" : state); }
function statusBadge(state) { return el("span", `status status-${state}`, statusLabel(state)); }
function updateMetrics(data) {
 const summary = data.summary || {}, total = Number(summary.total || 0), integrated = Number(summary.integrated || 0), percent = total ? Math.round(integrated / total * 100) : 0;
 $("#progress-percent").textContent = `${percent}%`;
 $("#progress-caption").textContent = `${count(integrated)} of ${count(total)} tasks integrated`;
 $("#progress-bar").style.width = `${percent}%`;
 $(".progress-line").setAttribute("aria-valuenow", String(percent));
 $("#active-agent-summary").textContent = `${count(summary.activeAgents)} active reservations`;
 $("#contributor-summary").textContent = `${count(summary.contributors)} contributors`;
 $("#metric-total").textContent = count(summary.total);
 $("#metric-available").textContent = count(summary.available);
 $("#metric-blocked").textContent = count(summary.blocked);
 $("#metric-reserved").textContent = count(summary.reserved);
 $("#metric-review").textContent = count(summary.inReview);
 $("#metric-approved").textContent = count(summary.approved);
 $("#metric-integrated").textContent = count(summary.integrated);
 $("#last-updated").textContent = `Updated ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(Number(data.lastUpdatedAt || Date.now() / 1000) * 1000))}`;
}
function renderModules(modules = []) {
 const moduleSelect = $("#module-filter"), rankSelect = $("#ranking-module"), previous = moduleSelect.value, rankPrevious = rankSelect.value;
 [moduleSelect, rankSelect, $("#activity-filters [name=module]"), $("#contribution-filters [name=module]")].forEach(select => select.replaceChildren(new Option("All modules", "")));
 modules.forEach(item => { const module = String(item.module); [moduleSelect, rankSelect, $("#activity-filters [name=module]"), $("#contribution-filters [name=module]")].forEach(select => select.add(new Option(module, module))); });
 moduleSelect.value = modules.some(item => item.module === previous) ? previous : "";
 rankSelect.value = modules.some(item => item.module === rankPrevious) ? rankPrevious : "";
}
function renderPipeline(data) {
 const root = $("#pipeline-stages"), summary = data.summary || {};
 const stages = [["blocked", summary.blocked], ["available", summary.available], ["reserved", summary.reserved], ["in_review", summary.inReview], ["approved", summary.approved], ["integrated", summary.integrated]];
 root.replaceChildren();
 stages.forEach(([state, value], index) => {
  const item = el("li", `pipeline-stage state-${state}`), marker = el("span", "pipeline-marker", ["◆", "○", "●", "◷", "✓", "✓"][index]);
  marker.setAttribute("aria-hidden", "true"); item.append(marker, el("span", "pipeline-name", statusLabel(state)), el("strong", "pipeline-count", count(value)));
  item.setAttribute("aria-label", `${statusLabel(state)}: ${count(value)} tasks`); root.append(item);
 });
}
function renderTaskMap(tasks = []) {
 const root = $("#task-map-view"); root.replaceChildren();
 if (!tasks.length) { root.append(el("p", "empty-state", dashboard?.summary?.total ? "No tasks match these filters. Clear a filter or load another page." : "Task map will appear when work is registered.")); return; }
 const groups = new Map();
 tasks.forEach(task => { const module = task.module || "Unassigned module"; if (!groups.has(module)) groups.set(module, []); groups.get(module).push(task); });
 groups.forEach((items, module) => {
  const section = el("section", "map-module"), heading = el("div", "map-module-heading"); heading.append(el("h3", "", module), el("span", "quiet-label", `${items.length} loaded task${items.length === 1 ? "" : "s"}`));
  const grid = el("div", "task-map-grid");
  items.forEach(task => {
   const button = el("button", `task-cell state-${task.state}`, task.id.slice(0, 8)); button.type = "button";
   const complexity = task.complexity ? COMPLEXITY[task.complexity] : "Not assessed";
   button.title = `${task.title} · ${statusLabel(task.state)} · ${complexity}`;
   button.setAttribute("aria-label", `${task.id}. ${task.title}. Module ${module}. ${statusLabel(task.state)}. Complexity ${complexity}. Priority ${task.priority}. ${task.hasDependencies ? `${task.dependencyCount} dependencies.` : "No dependencies."}`);
   button.addEventListener("click", () => navigateToTask(task.id)); grid.append(button);
  });
  section.append(heading, grid); root.append(section);
 });
}
function moduleRelationButton(name) {
 const button = el("button", "module-relation-name", name); button.type = "button";
 button.addEventListener("click", () => { $("#module-filter").value = name; loadCatalog(true); location.hash = "tasks"; }); return button;
}
function renderModuleMap(modules = [], relations = []) {
 const root = $("#project-map-groups");
 const model = globalThis.RustKoreProjectMap.renderProjectMap(root, modules, relations, selectModuleTasks);
 const sorted = [...modules].sort((a, b) => String(a.module).localeCompare(String(b.module)));
 $("#map-count").textContent = modules.length ? `${count(sorted.length)} modules · ${count(model.edges.length)} prerequisite links · select a module to filter tasks` : "No modules registered";
 renderModuleTable(modules, relations);
}
function renderModuleTable(modules = [], relations = []) {
 const rows = $("#module-rows"); if (!rows) return; rows.replaceChildren();
 const sorted = [...modules].sort((a, b) => { const av=moduleSort==="module"?String(a.module):Number(moduleSort==="integrated"?(a.integrated||0)/(a.total||1):(a.total||0)),bv=moduleSort==="module"?String(b.module):Number(moduleSort==="integrated"?(b.integrated||0)/(b.total||1):(b.total||0));return moduleSortDirection*(typeof av==="string"?av.localeCompare(String(bv)):av-Number(bv)); });
 if (!sorted.length) { const row = el("tr"), cell = el("td", "empty-state", "No modules are registered."); cell.colSpan = 4; row.append(cell); rows.append(row); return; }
 sorted.forEach(module => {
  const total = Number(module.total || 0), integrated = Number(module.integrated || 0), percent = total ? Math.round(integrated / total * 100) : 0;
  const row = el("tr"), moduleCell = el("td"), name = moduleRelationButton(module.module), totalCell = el("td", "mono", count(total)), states = el("td", "module-table-states"), progressCell = el("td", "mono", `${count(integrated)} / ${count(total)} · ${percent}%`);
  moduleCell.append(name);
  [["available", module.available], ["blocked", module.blocked], ["reserved", module.reserved], ["in_review", module.inReview], ["approved", module.approved], ["integrated", module.integrated]].forEach(([key, value]) => { if (Number(value)) states.append(el("span", `state-chip state-${key}`, `${statusLabel(key)} ${count(value)}`)); });
  progressCell.setAttribute("aria-label", `${module.module}: ${percent}% integrated, ${integrated} of ${total} tasks`);
  row.append(moduleCell,totalCell,states,progressCell); rows.append(row);
 });
}
function filteredTasks() {
 const module = $("#module-filter").value, state = $("#status-filter").value, complexity = $("#complexity-filter").value,
  priority = $("#priority-filter").value, assignee = $("#assignee-filter").value, dependencies = $("#dependencies-filter").value, availability = $("#availability-filter").value;
 return catalog.filter(task => (!module || task.module === module) && (!state || task.state === state) &&
  (!complexity || (complexity === "unassessed" ? !task.complexity : task.complexity === complexity)) &&
  (!priority || (priority === "high" ? task.priority >= 70 : priority === "medium" ? task.priority >= 40 && task.priority < 70 : task.priority < 40)) &&
  (!assignee || (assignee === "unassigned" ? !task.assignee : task.assignee === assignee)) &&
  (!dependencies || (dependencies === "none" ? !task.hasDependencies : dependencies === "waiting" ? task.state === "blocked" : task.hasDependencies)) &&
  (availability === "all" || !availability || (availability === "eligible" ? task.state === "available" : task.state === "blocked")));
}
function renderCatalog() {
 const items = filteredTasks(), term = $("#task-search").value.trim().toLocaleLowerCase(), visible = term ? items.filter(task => `${task.id} ${task.title} ${task.module}`.toLocaleLowerCase().includes(term)) : items;
 renderTaskMap(visible); renderTaskTable(visible);
 const total = Number(dashboard?.summary?.total || 0), more = Boolean(catalogCursor);
 $("#filter-note").textContent = `Showing ${count(visible.length)} loaded task${visible.length === 1 ? "" : "s"}${total ? ` · ${count(total)} registered` : ""}${more ? " · more tasks available" : ""}`;
 $("#load-more").hidden = !more;
 const names = new Set(catalog.map(task => task.assignee).filter(Boolean));
 const select = $("#assignee-filter"), selected = select.value;
 names.forEach(name => { if (![...select.options].some(option => option.value === name)) select.add(new Option(`@${name}`, name)); });
 if ([...select.options].some(option => option.value === selected)) select.value = selected;
}
function taskLinkButton(task) {
 const button = el("button", "task-title-button", task.title); button.type = "button"; button.addEventListener("click", () => navigateToTask(task.id)); return button;
}
function renderTaskTable(tasks) {
 const rows = $("#task-rows"); rows.replaceChildren();
 if (!tasks.length) { const row = el("tr"), cell = el("td", "empty-state", "No tasks match the current filters."); cell.colSpan = 7; row.append(cell); rows.append(row); return; }
 tasks.forEach(task => {
  const row = el("tr"), title = el("td", "task-title-cell"), module = el("td", "module-tag", task.module), state = el("td"), complexity = el("td", "complexity-label", task.complexity ? COMPLEXITY[task.complexity] : "Not assessed"), priority = el("td", "priority", `P${String(task.priority).padStart(2, "0")}`), assignee = el("td", "assignee", task.assignee ? `@${task.assignee} · ${task.agentName || "AI Agent"}` : "—"), deps = el("td", "task-dependencies-cell", task.hasDependencies ? `${task.dependencyCount} linked task${task.dependencyCount === 1 ? "" : "s"}` : "None");
  [module, state, complexity, priority, assignee, deps].forEach((cell, index) => cell.dataset.label = ["Module", "State", "Complexity", "Priority", "Assignee", "Dependencies"][index]);
  title.append(taskLinkButton(task), el("span", "task-id mono", task.id)); state.append(statusBadge(task.state)); row.append(title, module, state, complexity, priority, assignee, deps); rows.append(row);
 });
}
function queryForCatalog(cursor = null) {
 const params = new URLSearchParams({ limit: "100" });
 const pairs = { module: "module-filter", state: "status-filter", priority: "priority-filter", complexity: "complexity-filter", assignee: "assignee-filter", availability: "availability-filter", dependencies: "dependencies-filter", q: "task-search" };
 for (const [key, selector] of Object.entries(pairs)) { const value = $("#" + selector).value.trim(); if (value && !(key === "availability" && value === "all")) params.set(key, value); }
 if (cursor) params.set("cursor", cursor);
 return params.toString();
}
async function loadCatalog(reset = true) {
 if (!dashboard) return;
 const request = ++catalogRequest;
 if (reset) { catalog = []; catalogCursor = null; lastCatalogQuery = queryForCatalog(); }
 try {
  const query = reset ? lastCatalogQuery : queryForCatalog(catalogCursor), result = await api(`/api/tasks?${query}`);
  if (request !== catalogRequest) return;
  catalog = reset ? result.tasks : [...catalog, ...result.tasks.filter(task => !catalog.some(item => item.id === task.id))];
  catalogCursor = result.nextCursor; renderCatalog();
 } catch (error) { if (request === catalogRequest) { $("#filter-note").textContent = error.message; notice(error.message); } }
}
function renderChart(history = {}) {
 const svg = $("#integration-chart"), total = Number(dashboard?.summary?.integrated || 0); svg.replaceChildren();
 const allRows = (history.daily || []).map(row => ({ day: Math.floor(Number(row.day) / 86400), count: Number(row.count) })).sort((a,b)=>a.day-b.day);
 let startDay, endDay = Math.floor(Date.now() / 86400000), base = 0, increments = [];
 if (range === "all") { startDay = allRows[0]?.day ?? endDay; base = Math.max(0,total-allRows.reduce((sum,row)=>sum+row.count,0)); }
 else { const days = Number(range); startDay = endDay - days + 1; base = Math.max(0,total-allRows.filter(row=>row.day>=startDay&&row.day<=endDay).reduce((sum,row)=>sum+row.count,0)); }
 const daily = new Map(allRows.filter(row => row.day >= startDay && row.day <= endDay).map(row => [row.day,row.count]));
 if (endDay - startDay > 1499) startDay = endDay - 1499;
 let cumulative = base;
 for (let day = startDay; day <= endDay; day++) { const value = daily.get(day) || 0; cumulative += value; increments.push({ day, count: value, cumulative }); }
 const rangeTotal = increments.reduce((sum,row)=>sum+row.count,0); $("#range-total").textContent = count(rangeTotal); $("#cumulative-total").textContent = count(total);
 const width=Math.max(320,svg.clientWidth||720),height=240,left=width<500?44:58,right=width<500?10:18,top=18,bottom=42,plotW=width-left-right,plotH=height-top-bottom;
 svg.setAttribute("viewBox",`0 0 ${width} ${height}`);
 if (!total || !allRows.length) { svg.append(elSvg("text", { x: width/2, y: 110, "text-anchor":"middle", class:"chart-empty" }, "No integrations have been recorded yet.")); svg.setAttribute("aria-label","No integration history recorded"); return; }
 const maxValue=Math.max(1,...increments.map(point=>point.cumulative)), yMax=Math.max(1,Math.ceil(maxValue/4)*4), xAt=index=>left+(increments.length<=1?0:index/(increments.length-1)*plotW), yAt=value=>top+plotH-(value/yMax)*plotH;
 for(let tick=0;tick<=4;tick++){const value=Math.round(yMax*tick/4),y=yAt(value);svg.append(elSvg("line",{x1:left,x2:width-right,y1:y,y2:y,class:"chart-grid"}));svg.append(elSvg("text",{x:left-10,y:y+3,"text-anchor":"end",class:"chart-axis"},String(value)));}
 const path=[]; if(increments.length){path.push(`M${xAt(0)} ${yAt(base)}`); increments.forEach((point,index)=>{path.push(`H${xAt(index)} V${yAt(point.cumulative)}`); if(index<increments.length-1) path.push(`H${xAt(index+1)}`);});}
 svg.append(elSvg("path",{d:path.join(" "),class:"chart-step-area",fill:"none"}));
 const tickCount=Math.min(6,Math.max(2,Math.floor(svg.clientWidth/100)));
 for(let i=0;i<tickCount;i++){const index=Math.round(i*(increments.length-1)/Math.max(1,tickCount-1)),point=increments[index],date=new Date(point.day*86400000),label=shortDate(point.day*86400);svg.append(elSvg("text",{x:xAt(index),y:height-15,"text-anchor":"middle",class:"chart-label"},range==="all"?new Intl.DateTimeFormat("en",{month:"short",year:"2-digit",timeZone:"UTC"}).format(date):label));}
 increments.forEach((point,index)=>{if(!point.count)return;const circle=elSvg("circle",{cx:xAt(index),cy:yAt(point.cumulative),r:4,class:"chart-point chart-point-active",tabindex:0});circle.append(elSvg("title",{},`${new Date(point.day*86400000).toISOString().slice(0,10)} · ${point.count} integration${point.count===1?"":"s"} that day · ${point.cumulative} cumulative`));svg.append(circle);});
 svg.append(elSvg("path",{d:path.join(" "),class:"chart-step-line"})); svg.setAttribute("aria-label",`Cumulative integrations from ${new Date(startDay*86400000).toISOString().slice(0,10)} to today. ${rangeTotal} integrations in this period, ${total} total.`);
}
function elSvg(tag, attrs = {}, text = "") { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, String(value))); if (text) node.textContent = text; return node; }
function rankingParams(cursor=null) { const query=new URLSearchParams({limit:"10",measure:$("#ranking-measure").value,module:$("#ranking-module").value,period:$("#ranking-period").value});if(cursor)query.set("cursor",cursor);return query.toString(); }
async function loadRanking(reset=true) {
 const query=rankingParams(); if(reset){rankingCursor=null;rankingItems=[];rankingQuery=query;$("#ranking-more").hidden=true;}
 const params=new URLSearchParams(query);if(!reset&&rankingCursor)params.set("cursor",rankingCursor);
 const list=$("#contributors-list");if(reset)list.replaceChildren(el("li","loading","Loading ranking…"));
 try{const result=await api(`/api/ranking?${params}`);if(reset)rankingItems=result.items;else rankingItems=[...rankingItems,...result.items];rankingCursor=result.nextCursor;renderContributors(rankingItems);$("#ranking-more").hidden=!rankingCursor;}
 catch(error){list.replaceChildren(el("li","error-state",error.message));}
}
function renderContributors(people=[]) {
 const list=$("#contributors-list");list.replaceChildren();
 if(!people.length){list.append(el("li","empty-state","No verified contributions match these filters."));return;}
 people.forEach((person,index)=>{
  const item=el("li",`rank-row${index<3?` rank-top-${index+1}`:""}`),order=el("span",`rank-number${index<3?` rank-place-${index+1}`:""}`,String(index+1).padStart(2,"0")),profile=el("a","profile-link"),avatarUrl=safeAvatarUrl(person.avatarUrl);
  profile.href=`#contributor/${encodeURIComponent(person.login)}`;profile.setAttribute("aria-label",`Open profile for ${person.name||person.login}`);
  if(avatarUrl){const avatar=el("img","avatar");avatar.src=avatarUrl;avatar.alt="";avatar.loading="lazy";avatar.width=36;avatar.height=36;profile.append(avatar);}else{const avatar=el("span","avatar avatar-fallback",initials(person.name||person.login));avatar.style.setProperty("--avatar-hue",String(loginHue(person.login)));avatar.setAttribute("aria-hidden","true");profile.append(avatar);}
  const info=el("span","person-info"),identity=el("a","person-name",person.name||person.login),handle=el("span","person-handle",`@${person.login}`);identity.href=profile.href;info.append(identity,handle);
  const awards=(person.recognitions||[]).slice(0,2);if(awards.length){const chips=el("span","rank-awards");awards.forEach(award=>chips.append(el("span","rank-award",AWARDS[award.code]||"Recognition")));info.append(chips);}
  const value=el("strong","rank-count mono",count(person.metric)),label=el("span","rank-label",$("#ranking-measure").value==="reviews"?"reviews":"integrated");item.append(order,profile,info,value,label);list.append(item);
 });
}
function initials(value) { return String(value || "?").trim().split(/\s+/).slice(0, 2).map(part => Array.from(part)[0]?.toUpperCase() || "").join("").slice(0, 2) || "?"; }
function loginHue(value) { let hash = 0; for (const character of String(value || "rustkore")) hash = (hash * 31 + character.charCodeAt(0)) | 0; return Math.abs(hash) % 360; }
let reservationTimer=0,reservationExpiryTimer=0,reservationInitialItems=[],reservationInitialNextCursor=null,reservationStack=[],reservationPageStart=null;
function renderAgents(agents=[],nextCursor=null) {
 const list=$("#active-agents");list.replaceChildren();$("#active-count").textContent=count(dashboard?.summary?.activeAgents??agents.length);
 if(!agents.length){list.append(el("li","empty-state","No active reservations at this time."));$("#active-more").hidden=true;$("#active-previous").hidden=true;clearTimeout(reservationExpiryTimer);return;}
 agents.slice(0,10).forEach(agent=>{
  const item=el("li","agent-row"),avatarUrl=safeAvatarUrl(agent.avatarUrl);if(avatarUrl){const avatar=el("img","agent-avatar");avatar.src=avatarUrl;avatar.alt="";avatar.loading="lazy";avatar.width=32;avatar.height=32;item.append(avatar);}else{const avatar=el("span","agent-avatar avatar-fallback",initials(agent.contributorName||agent.login));avatar.style.setProperty("--avatar-hue",String(loginHue(agent.login)));avatar.setAttribute("aria-hidden","true");item.append(avatar);}
  const main=el("div","agent-main"),identity=el("div","agent-identity");identity.append(el("strong","",agent.agentName||"AI Agent"),el("span","",`@${agent.login||"contributor"}`));const taskRef=agent.taskId.match(/^demo-task-(\d+)$/)?.[1],task=el("button","agent-task",`${taskRef?`#${taskRef}`:agent.taskId.slice(0,8)} · ${agent.title}`);task.type="button";task.title=`${agent.taskId} · ${agent.title}`;task.addEventListener("click",()=>navigateToTask(agent.taskId));main.append(identity,task,el("span","quiet-label",agent.module||"Unassigned module"));
  const timing=el("div","agent-timing"),reserved=el("time","",`Reserved ${timeAgo(agent.reservedAt)}`),remaining=el("time","lease-time","");remaining.dataset.leaseUntil=String(agent.leaseUntil);timing.append(reserved,remaining);item.append(main,timing);list.append(item);
 });
 clearTimeout(reservationExpiryTimer);const nearest=Math.min(...agents.map(agent=>Number(agent.leaseUntil)).filter(value=>value>Math.floor(Date.now()/1000)));if(Number.isFinite(nearest))reservationExpiryTimer=setTimeout(()=>refreshDashboard(true),Math.max(1000,(nearest-Math.floor(Date.now()/1000))*1000+100));
 const update=()=>{$$(".lease-time").forEach(node=>{const seconds=Number(node.dataset.leaseUntil)-Math.floor(Date.now()/1000);if(seconds<=0){node.closest(".agent-row")?.remove();node.textContent="Expired";}else node.textContent=`${Math.floor(seconds/60)}m ${seconds%60}s left`;});};update();clearInterval(reservationTimer);reservationTimer=setInterval(update,15000);
 $("#active-more").hidden=!nextCursor;$("#active-more").dataset.cursor=nextCursor||"";const previous=$("#active-previous");previous.hidden=reservationStack.length===0;
}
async function loadMoreReservations(button){const cursor=button.dataset.cursor;if(!cursor)return;button.disabled=true;reservationStack.push(reservationPageStart);reservationPageStart=cursor;try{const result=await api(`/api/reservations?limit=10&cursor=${encodeURIComponent(cursor)}`);renderAgents(result.items,result.nextCursor);}catch(error){reservationPageStart=reservationStack.pop()??null;notice(error.message);}finally{button.disabled=false;}}
async function loadPreviousReservations(button){button.disabled=true;const cursor=reservationStack.pop();if(cursor===null||cursor===undefined){reservationPageStart=null;renderAgents(reservationInitialItems,reservationInitialNextCursor);button.disabled=false;return;}reservationPageStart=cursor;try{const result=await api(`/api/reservations?limit=10&cursor=${encodeURIComponent(cursor)}`);renderAgents(result.items,result.nextCursor);}catch(error){reservationStack.push(cursor);notice(error.message);}finally{button.disabled=false;}}
function eventDay(timestamp){return new Intl.DateTimeFormat("en",{weekday:"short",month:"short",day:"numeric",year:"numeric",timeZone:"UTC"}).format(new Date(Number(timestamp)*1000));}
function renderActivity(items=[]) {
 const list=$("#activity-list");list.replaceChildren();if(!items.length){list.append(el("li","empty-state","Relevant task activity will appear here when work begins."));return;}
 let previousDay="";items.slice(0,10).forEach(item=>{
  const day=eventDay(item.createdAt);if(day!==previousDay){list.append(el("li","activity-day-label",day));previousDay=day;}
  const row=el("li","activity-row"),icon={"task.claimed":"↗","task.submitted":"↑","submission.accepted":"✓","submission.rejected":"↺","task.integrated":"◆"}[item.action]||"•",mark=el("span",`activity-mark mark-${String(item.action).replaceAll(".","-")}`,icon);mark.setAttribute("aria-hidden","true");const body=el("div","activity-main"),first=el("p","activity-copy");first.append(el("strong","",`@${item.actor||"contributor"}`),document.createTextNode(` ${ACTIVITY[item.action]||"updated work"} · `));const task=el("button","inline-task-link",item.title||"Task");task.type="button";task.addEventListener("click",()=>navigateToTask(item.taskId));first.append(task);body.append(first,el("span","activity-meta",`${item.module||"Module"}${item.agentName?` · ${item.agentName}`:""}`));const time=el("time","activity-time",timeAgo(item.createdAt));time.dateTime=new Date(Number(item.createdAt)*1000).toISOString();row.append(mark,body,time);list.append(row);
 });
}
function renderHistory(items=[]) {
 const list=$("#history-list");list.replaceChildren();if(!items.length){list.append(el("li","empty-state","No contributions have been submitted yet."));return;}
 items.slice(0,10).forEach(item=>{const row=el("li","contribution-row"),main=el("div","contribution-main"),task=el("button","inline-task-link",item.title);task.type="button";task.addEventListener("click",()=>navigateToTask(item.taskId));main.append(task,el("span","contribution-meta",`@${item.login||"contributor"} · ${item.module||"Module"} · ${contributionStatusLabel(item.status)}`));row.append(main);const link=safeGitHubUrl(item.pullRequestUrl);if(link){const pr=el("a","history-link");setLink(pr,link,"Pull request ↗");row.append(pr);}else if(/^[0-9a-f]{7,40}$/i.test(item.commitSha||"")){const commit=el("a","history-link");setLink(commit,`https://github.com/RustKore/RustKore/commit/${encodeURIComponent(item.commitSha)}`,"Commit ↗");row.append(commit);}const timestamp=item.integratedAt||item.createdAt,label=item.integratedAt?"Integrated":"Submitted";row.append(el("time","activity-time",`${label} ${timeAgo(timestamp)}`));list.append(row);});
}
function historyFilters(kind){const form=$(kind==="activity"?"#activity-filters":"#contribution-filters"),values=new FormData(form),params=new URLSearchParams({limit:"25"});for(const key of ["type","status","contributor","module","period"]){const value=String(values.get(key)||"");if(value&&value!=="all")params.set(key,value);}return params;}
async function loadPublicHistory(kind,cursor=null){
 const activity=kind==="activity",form=$(activity?"#activity-filters":"#contribution-filters"),list=$(activity?"#activity-page-list":"#contribution-page-list"),status=$(activity?"#activity-page-status":"#contribution-page-status"),older=$(activity?"#activity-older":"#contribution-older"),newer=$(activity?"#activity-newer":"#contribution-newer");
 const requestId=activity?++activityRequestSeq:++contributionRequestSeq;
 status.textContent="Loading history…";list.replaceChildren();older.disabled=true;newer.disabled=true;
 const params=historyFilters(kind);if(cursor)params.set("cursor",cursor);
 try{const result=await api(`${activity?"/api/activity":"/api/contributions"}?${params}`);if(requestId!==(activity?activityRequestSeq:contributionRequestSeq))return;status.textContent=result.items.length?`Showing ${result.items.length} records · 25 per page maximum`:"No records match these filters.";
  if(!result.items.length)list.append(el("li","empty-state","No records match the selected filters."));
  if(activity){let day="";result.items.forEach(item=>{const nextDay=eventDay(item.createdAt);if(nextDay!==day){list.append(el("li","activity-day-label",nextDay));day=nextDay;}const row=el("li","activity-row"),mark=el("span","activity-mark",({"task.claimed":"↗","task.submitted":"↑","submission.accepted":"✓","submission.rejected":"↺","task.integrated":"◆"})[item.action]||"•");mark.setAttribute("aria-hidden","true");const main=el("div","activity-main"),copy=el("p","activity-copy");copy.append(el("strong","","@"+(item.actor||"contributor")),document.createTextNode(` ${ACTIVITY[item.action]||"updated work"} · `));const task=el("button","inline-task-link",item.title);task.type="button";task.addEventListener("click",()=>navigateToTask(item.taskId));copy.append(task);main.append(copy,el("span","activity-meta",`${item.module}${item.agentName?` · ${item.agentName}`:""}`));const time=el("time","activity-time",timeAgo(item.createdAt));time.dateTime=new Date(item.createdAt*1000).toISOString();row.append(mark,main,time);list.append(row);});}
  else result.items.forEach(item=>{const row=el("li","contribution-row"),main=el("div","contribution-main"),task=el("button","inline-task-link",item.title);task.type="button";task.addEventListener("click",()=>navigateToTask(item.taskId));main.append(task,el("span","contribution-meta",`@${item.login} · ${item.module} · ${contributionStatusLabel(item.effectiveStatus)}`));row.append(main);const pr=safeGitHubUrl(item.pullRequestUrl);if(pr){const link=el("a","history-link");setLink(link,pr,"Pull request ↗");row.append(link);}const stamp=item.integratedAt||item.submittedAt;row.append(el("time","activity-time",`${item.integratedAt?"Integrated":"Submitted"} ${dateTime(stamp)}`));list.append(row);});
  if(activity){activityCursor=cursor;$("#activity-older").dataset.cursor=result.nextCursor||"";older.disabled=!result.nextCursor;newer.disabled=activityStack.length===0;}else{contributionCursor=cursor;$("#contribution-older").dataset.cursor=result.nextCursor||"";older.disabled=!result.nextCursor;newer.disabled=contributionStack.length===0;}
 }catch(error){if(requestId!==(activity?activityRequestSeq:contributionRequestSeq))return;status.textContent="History could not be loaded.";list.replaceChildren(el("li","error-state",error.message));}
}
function moveHistory(kind,direction){const activity=kind==="activity",stack=activity?activityStack:contributionStack,cursor=activity?activityCursor:contributionCursor;if(direction==="older"){if(!$(activity?"#activity-older":"#contribution-older").dataset.cursor)return;stack.push(cursor);loadPublicHistory(kind,$(activity?"#activity-older":"#contribution-older").dataset.cursor);}else{const previous=stack.pop();loadPublicHistory(kind,previous||null);}}
function openHistoryFromHash(hash){const activity=hash==="activity-history",contributions=hash==="contribution-history";$("#activity-history").hidden=!activity;$("#contribution-history").hidden=!contributions;if(activity){activityStack=[];loadPublicHistory("activity");}if(contributions){contributionStack=[];loadPublicHistory("contributions");}}
function renderDashboard(data) {
 const hadCatalog = catalog.length > 0;
 const catalogChanged = dashboard && (JSON.stringify(dashboard.tasks) !== JSON.stringify(data.tasks) || JSON.stringify(dashboard.summary) !== JSON.stringify(data.summary));
 dashboard = data; updateMetrics(data); renderModules(data.modules || []); renderModuleMap(data.modules || [], data.moduleDependencies || []); renderPipeline(data); renderChart(data.integrationHistory || {}); loadRanking(true); reservationInitialItems=data.activeAgents||[];reservationInitialNextCursor=data.activeReservationsNextCursor||null;reservationStack=[];reservationPageStart=null;renderAgents(reservationInitialItems,reservationInitialNextCursor); renderActivity(data.recentActivity || []); renderHistory(data.recentContributions || []);
 if (hadCatalog) { if (catalogChanged) loadCatalog(true); }
 else { catalog = data.tasks || []; catalogCursor = data.nextCursor || null; renderCatalog(); }
 if (account) renderAccount(account);
}
function fingerprint(data) { return JSON.stringify({ summary: data.summary, modules: data.modules, moduleDependencies: data.moduleDependencies, tasks: data.tasks, nextCursor: data.nextCursor, contributors: data.contributors, activeAgents: data.activeAgents, recentActivity: data.recentActivity, recentContributions: data.recentContributions, integrationHistory: data.integrationHistory, activeReservationsNextCursor: data.activeReservationsNextCursor }); }
function renderAccount(session) {
 const root = $("#account"), person = session.personal || {};
 root.hidden = false; $("#account-nav").hidden = false;
 const githubLink = $("#account-github-link"); githubLink.textContent = `@${session.githubLogin}`; githubLink.href = `https://github.com/${encodeURIComponent(session.githubLogin)}`; githubLink.target = "_blank"; githubLink.rel = "noreferrer";
 const measures = [["AI Agents", person.agents], ["Active credentials", person.activeCredentials], ["Reservations", person.reservations], ["Submissions", person.submissions], ["Integrated", person.integrated], ["Reviews", person.reviews]], metrics = $("#personal-metrics"); metrics.replaceChildren();
 measures.forEach(([name, value]) => { const item = el("div", "personal-metric"); item.append(el("span", "", name), el("strong", "mono", count(value))); metrics.append(item); });
 renderPersonalList("#personal-reservations", person.reservationsList || [], item => `${item.title} · ${item.module}`, "No current reservations.", item => navigateToTask(item.id));
 renderPersonalList("#personal-submissions", person.submissionsList || [], item => `${item.title} · ${statusLabel(item.status === "pending" ? "in_review" : item.status === "accepted" ? "approved" : item.status)} · ${timeAgo(item.createdAt)}`, "No submissions yet.", item => navigateToTask(item.taskId));
 const awards = $("#personal-recognitions"); awards.replaceChildren();
 if (!person.recognitions?.length) awards.append(el("li", "empty-state", "Recognitions appear here when maintainers award them."));
 (person.recognitions || []).forEach(award => awards.append(renderAward(award)));
 const caps = new Set(session.capabilities || []), isOwner = caps.has("admin"), canMaintain = isOwner || caps.has("maintain");
 if (canMaintain) { $("#admin-nav").hidden = false; $("#administration").hidden = false; }
 const scopeSelect = $("#token-form [name=scope]");
 scopeSelect.querySelector('[value="maintain"]').hidden = !canMaintain;
 scopeSelect.querySelector('[value="release"]').hidden = !(isOwner || caps.has("release"));
 scopeSelect.querySelector('[value="admin"]').hidden = !isOwner;
 $("#context-admin-block").hidden = !isOwner;
 $('[data-requires-owner]').forEach(tab => { tab.hidden = !isOwner; });
}
function renderPersonalList(selector, values, label, empty, onSelect) {
 const list = $(selector); list.replaceChildren();
 if (!values.length) { list.append(el("li", "empty-state", empty)); return; }
 values.forEach(value => { const item = el("li", "personal-row"), button = el("button", "inline-task-link", label(value)); button.type = "button"; button.addEventListener("click", () => onSelect(value)); item.append(button); list.append(item); });
}
function renderAward(award) {
 const item = el("li", "award-row"), label = AWARDS[award.code] || "Recognition"; item.append(el("strong", "award-title", label), el("span", "award-rationale", award.rationale || "Recognized contribution"));
 if (award.awardedAt) item.append(el("time", "activity-time", dateTime(award.awardedAt))); return item;
}
async function loadTokens() {
 const result = await api("/api/tokens"), list = $("#token-list"); list.replaceChildren();
 if (!result.tokens.length) list.append(el("li", "empty-state", "No MCP credentials have been created."));
 result.tokens.forEach(token => {
  const item = el("li", "token-row"), info = el("div", "token-info"); info.append(el("strong", "token-name", token.agentName || token.scope), el("span", "token-meta", `${token.scope} scope · created ${timeAgo(token.createdAt)}${token.revokedAt ? " · revoked" : ""}`)); item.append(info);
  if (!token.revokedAt) { const revoke = el("button", "button button-quiet", "Revoke"); revoke.type = "button"; revoke.addEventListener("click", async () => { revoke.disabled = true; try { await api(`/api/tokens/${encodeURIComponent(token.tokenId)}`, { method: "DELETE" }); notice("Credential revoked."); await loadSession(); } catch (error) { notice(error.message); revoke.disabled = false; } }); item.append(revoke); }
  else item.classList.add("revoked"); list.append(item);
 });
}
function createDependencyPicker(root, initial = [], excludeTaskId = null) {
 const selected=new Map(initial.filter(item=>item?.id&&item.id!==excludeTaskId).map(item=>[item.id,item]));let query="",cursor=null,request=0;
 const searchLabel=el("label","dependency-search-label","Search by ID, title or module");const search=el("input","dependency-search-input");search.type="search";search.maxLength=100;search.placeholder="Search tasks";searchLabel.append(search);
 const selectedBox=el("div","dependency-selected");selectedBox.setAttribute("aria-live","polite");
 const results=el("div","dependency-results");results.setAttribute("aria-label","Dependency search results");
 const more=el("button","button button-quiet dependency-more","Load 20 more");more.type="button";more.hidden=true;
 root.replaceChildren(searchLabel,selectedBox,results,more);
 const renderSelected=()=>{selectedBox.replaceChildren();if(!selected.size){selectedBox.append(el("span","field-help","No dependencies selected."));return;}for(const [id,item]of selected){const chip=el("span","dependency-chip"),name=el("span","",`${id} · ${item.title||"Task"} · ${item.module||"Module"}`),remove=el("button","dependency-remove","Remove");remove.type="button";remove.setAttribute("aria-label",`Remove dependency ${id}`);remove.addEventListener("click",()=>{selected.delete(id);renderSelected();renderCurrentResults();});chip.append(name,remove);selectedBox.append(chip);}};
 const renderCurrentResults=()=>{for(const row of results.querySelectorAll("[data-dependency-id]")){const checkbox=row.querySelector("input[type=checkbox]");checkbox.checked=selected.has(row.dataset.dependencyId);}};
 const renderPage=async (nextCursor=null,append=false)=>{const current=++request;if(!append){results.replaceChildren(el("p","field-help","Searching tasks…"));cursor=null;}more.disabled=true;try{const params=new URLSearchParams({limit:"20"});if(query)params.set("q",query);if(nextCursor)params.set("cursor",nextCursor);const page=await api(`/api/tasks?${params}`);if(current!==request)return;const tasks=(page.tasks||[]).filter(task=>task.id!==excludeTaskId);if(!append)results.replaceChildren();if(!tasks.length&&!append)results.append(el("p","field-help","No matching tasks."));tasks.forEach(task=>{const row=el("label","dependency-result"),checkbox=document.createElement("input");row.dataset.dependencyId=task.id;checkbox.type="checkbox";checkbox.checked=selected.has(task.id);const details=el("span","dependency-result-copy"),title=el("strong","",task.title),meta=el("span","",`${task.id} · ${task.module}`);details.append(title,meta);checkbox.addEventListener("change",()=>{if(checkbox.checked)selected.set(task.id,task);else selected.delete(task.id);renderSelected();});row.append(checkbox,details);results.append(row);});cursor=page.nextCursor||null;more.hidden=!cursor;}catch(error){if(current===request)results.replaceChildren(el("p","error-state",error.message));more.hidden=true;}finally{if(current===request)more.disabled=false;}};
 let timer=0;search.addEventListener("input",()=>{clearTimeout(timer);query=search.value.trim();timer=setTimeout(()=>renderPage(),180);});more.addEventListener("click",()=>{if(cursor)renderPage(cursor,true);});
 renderSelected();renderPage();
 return {getSelectedIds:()=>[...selected.keys()],clear:()=>{selected.clear();renderSelected();renderCurrentResults();},selected};
}
async function loadAdmin() {
 try {
  const isOwner = account?.capabilities?.includes("admin");
  if(!taskDependencyPicker) taskDependencyPicker=createDependencyPicker($("#task-form [data-dependency-picker]"));
  const [submissions, collaborators, context, catalog] = await Promise.all([
   api("/api/admin/submissions"), isOwner ? api("/api/admin/collaborators?limit=100") : Promise.resolve({collaborators:[]}),
   isOwner ? api("/api/admin/context") : Promise.resolve({content:""}), api("/api/admin/roadmap/catalog")
  ]);
  const submissionList = $("#submission-list"); submissionList.replaceChildren();
  if (!submissions.submissions.length) { const empty=el("li","admin-empty-state"),icon=el("span","admin-empty-icon");icon.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V3h13"/><path d="m16 3 5 5M8 12h8M8 16h8M8 8h3"/></svg>';empty.append(icon);const copy=el("div","","");copy.append(el("strong","","No pending submissions."),el("p","","Submitted contributions will appear here when they require review or integration."));empty.append(copy);submissionList.append(empty); }
  submissions.submissions.forEach(item => {
   const row = el("li", "admin-row"), main = el("div", "admin-row-main"); main.append(el("strong", "", `${item.taskTitle} · ${statusLabel(item.status === "pending" ? "in_review" : item.status === "accepted" ? "approved" : item.integratedAt ? "integrated" : "blocked")}`), el("span", "", `@${item.contributor} · ${item.agentName} · ${String(item.commitSha).slice(0, 8)}`));
   const pr = el("a", "admin-link"); const safe = safeGitHubUrl(item.pullRequestUrl); if (safe) { setLink(pr, safe, "Open pull request ↗"); main.append(pr); }
   const actions = el("div", "admin-actions");
   if (item.status === "accepted" && !item.integratedAt) { const button = el("button", "button button-small", "Verify integration"); button.type = "button"; button.addEventListener("click", async () => { button.disabled = true; try { await api(`/api/admin/submissions/${encodeURIComponent(item.id)}/integrate`, { method: "POST" }); notice("GitHub integration verified."); await refreshDashboard(true); await loadAdmin(); } catch (error) { notice(error.message); button.disabled = false; } }); actions.append(button); }
   else main.append(el("span", "token-meta", item.integratedAt ? `Integrated ${timeAgo(item.integratedAt)}` : item.reviewDecision ? `Review: ${item.reviewDecision}` : "Waiting for independent review"));
   row.append(main, actions); submissionList.append(row);
  });
  const people = $("#admin-collaborators"); people.replaceChildren();
  if (!collaborators.collaborators.length) people.append(el("li", "empty-state", "No GitHub contributors have joined yet."));
  collaborators.collaborators.forEach(person => {
   const row = el("li", "admin-row collaborator-admin-row"), identityArea=el("section","collaborator-area collaborator-identity"), identityHead=el("div","collaborator-identity-head"), avatarUrl=safeAvatarUrl(person.avatarUrl);
   if(avatarUrl){const avatar=el("img","collaborator-avatar");avatar.src=avatarUrl;avatar.alt="";avatar.width=36;avatar.height=36;identityHead.append(avatar);}else{const avatar=el("span","collaborator-avatar avatar-fallback",initials(person.name||person.login));avatar.setAttribute("aria-hidden","true");identityHead.append(avatar);}
   const profile=el("a","collaborator-login",`@${person.login}`);setLink(profile,`https://github.com/${encodeURIComponent(person.login)}`,`@${person.login}`);identityHead.append(profile);identityArea.append(el("h4","","Identity and contribution history"),identityHead,el("p","collaborator-stats",`${count(person.integratedCount)} integrated contributions · ${count(person.reviewCount)} reviews`));
   const accountArea=el("section","collaborator-area collaborator-account-area"),suspended=Boolean(person.suspendedAt),suspend=el("button",`button ${suspended?"button-quiet":"button-danger"}`,suspended?"Reactivate":"Suspend");suspend.type="button";suspend.addEventListener("click",()=>{if(suspended&&!confirm(`Reactivate @${person.login}?`))return;if(!suspended&&!confirm(`Suspend @${person.login}? Their active credentials and web sessions will be revoked.`))return;updatePerson(person,{suspended:!suspended});});accountArea.append(el("h4","","Account status"),el("p","collaborator-state",`Account · ${suspended?"Suspended":"Active"}`),el("p","field-help","Suspending blocks sign-in and revokes active sessions and credentials."),suspend);
   const recognitionArea=el("section","collaborator-area collaborator-recognitions"),awards=el("div","admin-awards"); (person.recognitions || []).forEach(award => awards.append(el("span", "award-chip", AWARDS[award.code] || "Recognition")));
   const form = document.createElement("form"); form.className = "recognition-form";
   const existing = new Set((person.recognitions || []).map(award => award.code)), available = Object.entries(AWARDS).filter(([code]) => !existing.has(code));
   recognitionArea.append(el("h4","","Permanent recognitions"),awards,el("p","field-help","Recognitions are permanent and do not grant permissions."));
   if (available.length) {
    const recognitionLabel=el("label","","Recognition"),select = document.createElement("select"); select.name = "code"; select.setAttribute("aria-label", `Recognition for ${person.login}`); available.forEach(([code, label]) => select.add(new Option(label, code)));recognitionLabel.append(select);
    const reasonLabel=el("label","","Reason"),rationale = document.createElement("input"); rationale.name = "rationale"; rationale.maxLength = 2000; rationale.required = true; reasonLabel.append(rationale);
    const grant = el("button", "button", "Award recognition"); grant.type = "submit";grant.disabled=true;rationale.addEventListener("input",()=>{grant.disabled=!rationale.value.trim();}); form.append(recognitionLabel, reasonLabel, grant);
    form.addEventListener("submit", async event => { event.preventDefault(); const values = new FormData(form), reason=String(values.get("rationale")||"").trim();if(!reason||!confirm(`Award ${select.selectedOptions[0]?.textContent||"this recognition"} to @${person.login}? Recognitions are permanent.`))return;grant.disabled=true;try { await api(`/api/admin/collaborators/${encodeURIComponent(person.id)}/recognitions`, { method: "POST", body: JSON.stringify({ code: values.get("code"), rationale: reason }) }); notice("Permanent recognition recorded."); await loadAdmin(); await refreshDashboard(true); } catch (error) { notice(error.message); grant.disabled = false; } });
   } else form.append(el("span", "quiet-label", "All currently permitted recognitions have been awarded."));
   recognitionArea.append(form);row.append(identityArea,accountArea,recognitionArea);people.append(row);
  });
  $("#context-content").value = context.content || "";
  const metadata=$("#roadmap-catalog-metadata");metadata.replaceChildren();[["Catalog version",catalog.catalogVersion||"—"],["Source revision",catalog.sourceRevision||"—"],["Last imported",catalog.importedAt?dateTime(catalog.importedAt):"—"],["Total requirements",catalog.totalRequirements??"—"]].forEach(([label,value])=>{const row=el("div","catalog-meta-row"),term=el("dt","",label),definition=el("dd");if(label==="Source revision"&&catalog.sourceRevision){const link=el("a","catalog-revision-link",`${String(value).slice(0,10)}…`);setLink(link,`https://github.com/RustKore/RustKore/commit/${encodeURIComponent(catalog.sourceRevision)}`,`${String(value).slice(0,10)}…`);link.title=String(value);definition.append(link);}else definition.textContent=String(value);row.append(term,definition);metadata.append(row);});
 } catch (error) { notice(error.message); }
}
async function updatePerson(person, patch) {
 try { await api(`/api/admin/collaborators/${encodeURIComponent(person.id)}`, { method: "PATCH", body: JSON.stringify(patch) }); notice("Contributor access updated."); await loadAdmin(); } catch (error) { notice(error.message); }
}
async function loadSession() {
 const session = await api("/api/me");
 if (!session.authenticated) {
  account = null; csrf = ""; $("#login-link").hidden = false; $("#logout-button").hidden = true; $("#account-label").textContent = "Public workspace";
  $("#account-nav").hidden = true; $("#admin-nav").hidden = true; $("#account").hidden = true; $("#administration").hidden = true; return;
 }
 account = session; csrf = session.csrfToken; $("#login-link").hidden = true; $("#logout-button").hidden = false; $("#account-label").textContent = `@${session.githubLogin}`;
 renderAccount(session); await loadTokens(); if ((session.capabilities || []).includes("maintain") || (session.capabilities || []).includes("admin")) await loadAdmin();
}
async function refreshDashboard(force = false) {
 try {
  const data = await api("/api/dashboard"); const next = fingerprint(data);
  $("#last-updated").textContent = `Updated ${new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(Number(data.lastUpdatedAt || Date.now() / 1000) * 1000))}`;
  if (force || next !== lastFingerprint) { lastFingerprint = next; renderDashboard(data); }
  refreshDelay = 60_000;
 } catch (error) { refreshDelay = Math.min(300_000, Math.max(30_000, refreshDelay * 2 + Math.random() * 10_000)); $("#last-updated").textContent = "Refresh paused · retry scheduled"; }
 finally { scheduleRefresh(refreshDelay); }
}
function scheduleRefresh(delay) { clearTimeout(refreshTimer); if (!document.hidden) refreshTimer = setTimeout(() => refreshDashboard(), delay); }
function navigateToTask(taskId) { location.hash = `task/${encodeURIComponent(taskId)}`; }
function selectModuleTasks(module) { $("#module-filter").value = module; loadCatalog(true); if(location.hash!=="#tasks") location.hash="tasks"; $("#tasks").scrollIntoView({behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth",block:"start"}); }
function handleLocation() {
 const hash = location.hash.slice(1), taskMatch = hash.match(/^task\/(.+)$/), contributorMatch = hash.match(/^contributor\/(.+)$/); openHistoryFromHash(hash);
 if (taskMatch) openTask(decodeURIComponent(taskMatch[1])); else if (contributorMatch) openContributor(decodeURIComponent(contributorMatch[1]));
 else { if ($("#task-dialog").open) $("#task-dialog").close(); if ($("#contributor-dialog").open) $("#contributor-dialog").close(); }
}
async function openTask(taskId) {
 const dialog = $("#task-dialog"), content = $("#dialog-content"); content.replaceChildren(el("p", "loading", "Loading task details…"));
 if (!dialog.open) dialog.showModal();
 try { const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`); renderTaskDetail(task); }
 catch (error) { content.replaceChildren(el("p", "empty-state", error.message)); }
}
function renderTaskDetail(task) {
 $("#dialog-state").className = `status status-${task.state}`; $("#dialog-state").textContent = statusLabel(task.state);
 const root = $("#dialog-content"); root.replaceChildren();
 const header = el("div", "detail-header"); header.append(el("p", "section-kicker", `${task.module || "Module"} · P${String(task.priority).padStart(2, "0")}`));
 const title = el("h2", "", task.title); title.id = "dialog-title"; header.append(title);
 const idRow = el("div", "task-id-row"), idCode = el("code", "mono", task.id), copyId = el("button", "copy-button", "Copy ID"), share = el("a", "copy-button", "Copyable link");
 copyId.type = "button"; copyId.addEventListener("click", () => copyText(task.id)); share.href = location.href; share.addEventListener("click", event => { event.preventDefault(); copyText(`${location.origin}/#task/${encodeURIComponent(task.id)}`); }); idRow.append(idCode, copyId, share); header.append(idRow);
 const meta = el("div", "detail-meta"); meta.append(el("span", "", `Complexity · ${task.complexity ? COMPLEXITY[task.complexity] : "Not assessed"}`), el("span", "", `Assignee · ${task.assignee ? `@${task.assignee} · ${task.agentName || "AI Agent"}` : "Unassigned"}`), el("span", "", `Created · ${dateTime(task.createdAt)}`)); if (task.leaseUntil) meta.append(el("span", "", `Reservation lease · ${dateTime(task.leaseUntil)}`));
 root.append(header, meta);
 const description = el("section", "detail-section"); description.append(el("h3", "", "Description"), el("p", "", task.description || "No description provided."));
 const criteria = el("section", "detail-section"); criteria.append(el("h3", "", "Acceptance criteria"), el("p", "", task.acceptanceCriteria || "No acceptance criteria recorded.")); root.append(description, criteria);
 root.append(renderTaskRelations("Dependencies", task.dependencies || []), renderTaskRelations("Dependent tasks", task.dependents || []));
 if (task.state === "blocked") { const waiting = (task.dependencies || []).filter(item => item.state !== "approved" && item.state !== "integrated"); root.append(el("p", "dependency-note", waiting.length ? `Blocked until ${waiting.map(item => item.title).join(", ")} is approved or integrated.` : "This task is waiting on its prerequisites.")); }
 if (task.submissions?.length) root.append(renderSubmissions(task.submissions));
 if (task.activity?.length) root.append(renderTaskActivity(task.activity));
 if ((account?.capabilities?.includes("maintain") || account?.capabilities?.includes("admin")) && ["available", "blocked"].includes(task.state)) root.append(renderTaskEditor(task));
}
function renderTaskRelations(title, items) {
 const section = el("section", "detail-section"), heading = el("h3", "", title), list = el("ul", "relation-list"); section.append(heading);
 if (!items.length) section.append(el("p", "quiet-label", "None recorded."));
 else { items.forEach(item => { const row = el("li", "relation-row"), button = el("button", "inline-task-link", item.title); button.type = "button"; button.addEventListener("click", () => navigateToTask(item.id)); row.append(button, statusBadge(item.state)); list.append(row); }); section.append(list); }
 return section;
}
function renderSubmissions(items) {
 const section = el("section", "detail-section"), list = el("ol", "detail-event-list"); section.append(el("h3", "", "Contributions and reviews"));
  items.forEach(item => { const row = el("li", "detail-event"), main = el("div", "detail-event-main"); main.append(el("strong", "", `${contributionStatusLabel(item.status === "integrated" ? "integrated" : item.status)} · ${dateTime(item.createdAt)}`), el("p", "", item.summary || "Contribution submitted for review."));
  const links = el("div", "detail-links"), pr = el("a", "copy-button"); setLink(pr, safeGitHubUrl(item.pullRequestUrl), "Pull request ↗"); if (pr.href) links.append(pr);
  if (item.commitSha) { const commit = el("a", "copy-button"); setLink(commit, `https://github.com/RustKore/RustKore/commit/${encodeURIComponent(item.commitSha)}`, `Commit ${item.commitSha.slice(0, 8)} ↗`); links.append(commit); }
  if (item.reviewDecision) main.append(el("span", "quiet-label", `Reviewed by @${item.reviewer || "reviewer"} · ${item.reviewDecision}`)); if (item.integratedAt) main.append(el("span", "quiet-label", `Integrated at ${dateTime(item.integratedAt)} · ${String(item.mergeCommitSha || "").slice(0, 8)}`)); row.append(main, links); list.append(row);
 }); section.append(list); return section;
}
function renderTaskActivity(items) {
 const section = el("section", "detail-section"), list = el("ol", "detail-event-list"); section.append(el("h3", "", "Task history"));
 items.forEach(item => { const row = el("li", "detail-history-row"), actor = item.actor ? `@${item.actor}` : "System", action = ({ "task.created": "created", "task.claimed": "reserved", "task.released": "returned to the queue", "task.submitted": "submitted a contribution", "submission.accepted": "approved", "submission.rejected": "requested changes", "task.integrated": "integrated", "task.updated": "updated" })[item.action] || item.action;
  row.append(el("span", "", `${actor} ${action}`), el("time", "", timeAgo(item.createdAt))); const link = safeGitHubUrl(item.pullRequestUrl); if (link) { const pr = el("a", "copy-button"); setLink(pr, link, "PR ↗"); row.append(pr); } else if (/^[0-9a-f]{7,40}$/i.test(item.commitSha || "")) { const commit = el("a", "copy-button"); setLink(commit, `https://github.com/RustKore/RustKore/commit/${encodeURIComponent(item.commitSha)}`, "Commit ↗"); row.append(commit); } list.append(row);
 }); section.append(list); return section;
}
function renderTaskEditor(task) {
 const section = el("section", "detail-section admin-edit-section"), form = document.createElement("form"); section.append(el("h3", "", "Edit task registry")); form.className = "admin-task-form task-edit-form";
 const input = (labelText, name, value, type = "text") => { const classes={title:"task-title-field",module:"task-module-field",priority:"task-priority-field"};const label = el("label", classes[name]||"", labelText), field = document.createElement("input"); field.name = name; field.value = value ?? ""; field.maxLength = name === "title" ? 200 : 100; field.type = type; if (type === "number") { field.min = "0"; field.max = "100"; } label.append(field);if(name==="module")label.append(el("span","field-help","Groups related development tasks in the Project Map."));if(name==="priority")label.append(el("span","field-help","Higher values receive higher scheduling priority."));return label; };
 const title = input("Title", "title", task.title), module = input("Module", "module", task.module), priority = input("Priority", "priority", task.priority, "number"), complexity = el("label", "task-complexity-field", "Complexity"), complexitySelect = document.createElement("select"); complexitySelect.name = "complexity"; [["", "Not assessed"], ...Object.entries(COMPLEXITY).map(([key, label]) => [key, label])].forEach(([value, label]) => complexitySelect.add(new Option(label, value, false, task.complexity === value))); complexity.append(complexitySelect,el("span","field-help","Estimated implementation effort."));
 const description = el("label", "wide-field", "Description"), descriptionField = document.createElement("textarea"); descriptionField.name = "description"; descriptionField.maxLength = 4000; descriptionField.value = task.description || ""; description.append(descriptionField);
 const criteria = el("label", "wide-field", "Acceptance criteria"), criteriaField = document.createElement("textarea"); criteriaField.name = "acceptanceCriteria"; criteriaField.maxLength = 4000; criteriaField.value = task.acceptanceCriteria || ""; criteria.append(criteriaField,el("span","field-help","Conditions and evidence required for approval."));
 const dependencies = el("div", "wide-field admin-field-group"), dependencyTitle=el("span","admin-field-label","Dependencies"), dependencyHelp=el("span","field-help","A task becomes available when every dependency is approved or integrated."),dependencyRoot=el("div","dependency-picker");dependencyRoot.setAttribute("role","group");dependencyRoot.setAttribute("aria-label","Task dependencies");dependencies.append(dependencyTitle,dependencyHelp,dependencyRoot);
 const save = el("button", "button task-create-button", "Save task changes"); save.type = "submit"; form.append(title, module, priority, complexity, dependencies, description, criteria, save);
 const picker=createDependencyPicker(dependencyRoot,task.dependencies||[],task.id);
 form.addEventListener("submit", async event => { event.preventDefault(); const data = new FormData(form); save.disabled = true; try { await api(`/api/admin/tasks/${encodeURIComponent(task.id)}`, { method: "PATCH", body: JSON.stringify({ title: data.get("title"), module: data.get("module"), priority: Number(data.get("priority")), complexity: data.get("complexity"), description: data.get("description"), acceptanceCriteria: data.get("acceptanceCriteria"), dependencies: picker.getSelectedIds() }) }); notice("Task updated."); await refreshDashboard(true); await openTask(task.id); } catch (error) { notice(error.message); save.disabled = false; } });
 section.append(form); return section;
}
async function openContributor(login) {
 const dialog = $("#contributor-dialog"), root = $("#profile-content"); root.replaceChildren(el("p", "loading", "Loading contributor profile…")); if (!dialog.open) dialog.showModal();
 try { const profile = await api(`/api/contributors/${encodeURIComponent(login)}`); renderContributorProfile(profile); } catch (error) { root.replaceChildren(el("p", "empty-state", error.message)); }
}
function renderContributorProfile(person) {
 const root = $("#profile-content"); root.replaceChildren();
 const head = el("div", "profile-header"), avatarUrl = safeAvatarUrl(person.avatarUrl);
 if (avatarUrl) { const avatar = el("img", "profile-avatar"); avatar.src = avatarUrl; avatar.alt = ""; avatar.width = 64; avatar.height = 64; head.append(avatar); }
 else { const avatar = el("span", "profile-avatar avatar-fallback", initials(person.name || person.login)); avatar.style.setProperty("--avatar-hue", String(loginHue(person.login))); avatar.setAttribute("aria-hidden", "true"); head.append(avatar); }
 const identity = el("div", "profile-identity"), name = el("h2", "", person.name || person.login); name.id = "profile-title"; identity.append(name, el("span", "", `@${person.login} · Contributor`)); const github = el("a", "copy-button"); setLink(github, `https://github.com/${encodeURIComponent(person.login)}`, "GitHub profile ↗"); identity.append(github); head.append(identity); root.append(head);
 const metrics = el("div", "profile-metrics"); [["Joined", new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(Number(person.joinedAt) * 1000))], ["Integrated", count(person.integratedCount)], ["Reviews", count(person.reviewCount)]].forEach(([label, value]) => { const item = el("div", "personal-metric"); item.append(el("span", "", label), el("strong", "", value)); metrics.append(item); }); root.append(metrics);
 const awards = el("section", "detail-section"); awards.append(el("h3", "", "Permanent recognition")); const awardList = el("ul", "recognition-list"); if (!(person.recognitions || []).length) awardList.append(el("li", "empty-state", "No recognitions recorded yet.")); (person.recognitions || []).forEach(award => awardList.append(renderAward(award))); awards.append(awardList); root.append(awards);
 const modules = el("section", "detail-section"); modules.append(el("h3", "", "Module contributions"));
 if (!(person.modules || []).length) modules.append(el("p", "empty-state", "No integrated module contributions yet."));
 (person.modules || []).forEach(item => { const row = el("div", "profile-module-row"), label = el("a", "inline-task-link", item.module); label.href = `#tasks`; label.addEventListener("click", () => { $("#module-filter").value = item.module; loadCatalog(true); }); row.append(label, el("strong", "mono", count(item.integratedCount))); modules.append(row); }); root.append(modules);
 const contributions = el("section", "detail-section"); contributions.append(el("h3", "", "Integrated work")); const list = el("ol", "detail-event-list");
 if (!(person.contributions || []).length) list.append(el("li", "empty-state", "Integrated contributions will appear here."));
 (person.contributions || []).forEach(item => { const row = el("li", "detail-event"), main = el("div", "detail-event-main"), task = el("button", "inline-task-link", item.title); task.type = "button"; task.addEventListener("click", () => navigateToTask(item.taskId)); main.append(task, el("span", "quiet-label", `${item.module} · ${dateTime(item.integratedAt)}`)); const link = el("a", "copy-button"); setLink(link, safeGitHubUrl(item.pullRequestUrl), "Pull request ↗"); row.append(main); if (link.href) row.append(link); list.append(row); }); contributions.append(list); root.append(contributions);
 const reviews = el("section", "detail-section"); reviews.append(el("h3", "", "Independent reviews")); const reviewList = el("ol", "detail-event-list");
 if (!(person.reviews || []).length) reviewList.append(el("li", "empty-state", "No reviews recorded yet."));
 (person.reviews || []).forEach(item => { const row = el("li", "detail-event"), main = el("div", "detail-event-main"), task = el("button", "inline-task-link", item.title); task.type = "button"; task.addEventListener("click", () => navigateToTask(item.taskId)); main.append(task, el("span", "quiet-label", `${item.decision} · ${dateTime(item.reviewedAt)}`)); row.append(main); const link = el("a", "copy-button"); setLink(link, safeGitHubUrl(item.pullRequestUrl), "Pull request ↗"); if (link.href) row.append(link); reviewList.append(row); }); reviews.append(reviewList); root.append(reviews);
}
async function copyText(value) { try { await navigator.clipboard.writeText(value); notice("Copied to clipboard."); } catch { notice("Clipboard access is unavailable in this browser."); } }

$("#module-filter").addEventListener("change", () => loadCatalog(true));
["status-filter", "priority-filter", "complexity-filter", "assignee-filter", "availability-filter", "dependencies-filter"].forEach(id => $("#" + id).addEventListener("change", () => loadCatalog(true)));
let searchTimer = 0; $("#task-search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => loadCatalog(true), 280); });
$("#clear-filters").addEventListener("click", () => { ["task-search", "module-filter", "status-filter", "priority-filter", "complexity-filter", "assignee-filter", "dependencies-filter"].forEach(id => { $("#" + id).value = ""; }); $("#availability-filter").value = "all"; loadCatalog(true); });
$("#load-more").addEventListener("click", async event => { const button = event.currentTarget; button.disabled = true; button.textContent = "Loading…"; await loadCatalog(false); button.disabled = false; button.textContent = "Load more tasks"; });
$$('[data-module-view]').forEach(button => button.addEventListener("click", () => { $$('[data-module-view]').forEach(item => item.setAttribute("aria-pressed", String(item === button))); const table = button.dataset.moduleView === "table"; $("#module-map-view").hidden = table; $("#module-table-view").hidden = !table; }));
function selectAdminTab(tab, focus=false){const tabs=$$('[data-admin-tab]');tabs.forEach(item=>{const active=item.dataset.adminTab===tab;item.setAttribute("aria-selected",String(active));item.tabIndex=active?0:-1;if(active&&focus)item.focus();});$$('[data-admin-panel]').forEach(panel=>{panel.hidden=panel.dataset.adminPanel!==tab;});}
$$('[data-admin-tab]').forEach((button,index,buttons)=>{button.addEventListener("click",()=>selectAdminTab(button.dataset.adminTab));button.addEventListener("keydown",event=>{const current=buttons.indexOf(button);let next=null;if(event.key==="ArrowRight")next=(current+1)%buttons.length;else if(event.key==="ArrowLeft")next=(current+buttons.length-1)%buttons.length;else if(event.key==="Home")next=0;else if(event.key==="End")next=buttons.length-1;if(next!==null){event.preventDefault();selectAdminTab(buttons[next].dataset.adminTab,true);}});});
$$('[data-module-sort]').forEach(button=>button.addEventListener("click",()=>{const key=button.dataset.moduleSort;if(moduleSort===key)moduleSortDirection*=-1;else{moduleSort=key;moduleSortDirection=1;}renderModuleTable(dashboard?.modules||[],dashboard?.moduleDependencies||[]);}));
$$('[data-task-view]').forEach(button => button.addEventListener("click", () => { $$('[data-task-view]').forEach(item => item.setAttribute("aria-pressed", String(item === button))); const table = button.dataset.taskView === "table"; $("#task-map-view").hidden = table; $("#task-table-view").hidden = !table; }));
$$('[data-range]').forEach(button => button.addEventListener("click", () => { range = button.dataset.range; $$('[data-range]').forEach(item => item.setAttribute("aria-pressed", String(item === button))); renderChart(dashboard?.integrationHistory || {}); }));
$("#ranking-measure").addEventListener("change", () => loadRanking(true)); $("#ranking-module").addEventListener("change", () => loadRanking(true)); $("#ranking-period").addEventListener("change", () => loadRanking(true));
$("#ranking-more").addEventListener("click", async event=>{const button=event.currentTarget;button.disabled=true;const params=new URLSearchParams(rankingQuery);if(rankingCursor)params.set("cursor",rankingCursor);try{const result=await api(`/api/ranking?${params}`);rankingItems=[...rankingItems,...result.items];rankingCursor=result.nextCursor;renderContributors(rankingItems);button.hidden=!rankingCursor;}catch(error){notice(error.message);}finally{button.disabled=false;}});
$("#active-more").addEventListener("click",event=>loadMoreReservations(event.currentTarget));$("#active-previous").addEventListener("click",event=>loadPreviousReservations(event.currentTarget));
["activity-filters","contribution-filters"].forEach(id=>{const form=$("#"+id);form.addEventListener("change",()=>{if(location.hash===(id==="activity-filters"?"#activity-history":"#contribution-history")){id==="activity-filters"?(activityStack=[]):(contributionStack=[]);loadPublicHistory(id==="activity-filters"?"activity":"contributions");}});form.addEventListener("submit",event=>event.preventDefault());form.querySelectorAll("input").forEach(input=>input.addEventListener("keydown",event=>{if(event.key==="Enter"){event.preventDefault();form.dispatchEvent(new Event("change"));}}));});
$("#activity-older").addEventListener("click",()=>moveHistory("activity","older"));$("#activity-newer").addEventListener("click",()=>moveHistory("activity","newer"));$("#contribution-older").addEventListener("click",()=>moveHistory("contributions","older"));$("#contribution-newer").addEventListener("click",()=>moveHistory("contributions","newer"));
$$('[data-copy]').forEach(button => button.addEventListener("click", () => copyText(button.dataset.copy)));
$$('[data-copy-target]').forEach(button => button.addEventListener("click", () => copyText($("#" + button.dataset.copyTarget).textContent)));
$("#token-form").addEventListener("submit", async event => {
 event.preventDefault(); const form = new FormData(event.currentTarget), button = $("button[type=submit]", event.currentTarget); button.disabled = true;
 try { const token = await api("/api/tokens", { method: "POST", body: JSON.stringify({ name: form.get("name"), scope: form.get("scope") }) }), box = $("#new-token");
  box.replaceChildren(el("p", "", `Credential “${token.name}” created. Copy it now; it will not be shown again.`), el("code", "mono", token.token)); const copy = el("button", "button button-quiet", "Copy token"); copy.type = "button"; copy.addEventListener("click", () => copyText(token.token)); box.append(copy); box.hidden = false; event.currentTarget.reset(); await loadSession();
 } catch (error) { notice(error.message); } finally { button.disabled = false; }
});
$("#logout-button").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST" }); location.reload(); } catch (error) { notice(error.message); } });
$("#task-form").addEventListener("submit", async event => { event.preventDefault(); const values = new FormData(event.currentTarget), button = $("button[type=submit]", event.currentTarget); button.disabled = true;
 try { await api("/api/admin/tasks", { method: "POST", body: JSON.stringify({ title: values.get("title"), module: values.get("module"), priority: Number(values.get("priority")), complexity: values.get("complexity"), dependencies: taskDependencyPicker?.getSelectedIds()||[], description: values.get("description"), acceptanceCriteria: values.get("acceptanceCriteria") }) }); event.currentTarget.reset(); taskDependencyPicker?.clear(); notice("Task registered."); await refreshDashboard(true); await loadAdmin(); }
 catch (error) { notice(error.message); } finally { button.disabled = false; }
});

const catalogFile=$("#roadmap-catalog-file"),catalogBrowse=$("#catalog-browse"),catalogFileName=$("#catalog-file-name"),catalogImportButton=$("#catalog-import-button"),catalogImportStatus=$("#catalog-import-status");
function updateCatalogFile(){const file=catalogFile.files?.[0];catalogFileName.textContent=file?.name||"No file selected";catalogFileName.title=file?.name||"No file selected";catalogImportButton.disabled=!file;}
catalogBrowse.addEventListener("click",()=>catalogFile.click());catalogFile.addEventListener("change",updateCatalogFile);catalogFile.addEventListener("cancel",updateCatalogFile);
$("#roadmap-import-form").addEventListener("submit", async event => { event.preventDefault(); const file = catalogFile.files?.[0]; if (!file) return; const button = catalogImportButton; button.disabled = true;button.textContent="Importing…";catalogImportStatus.textContent="Validating and importing catalog…"; try { const catalog = JSON.parse(await file.text()); const result = await api("/api/admin/roadmap/import", { method: "POST", body: JSON.stringify(catalog) }); const message=result.unchanged?"Catalog is already current.":`Imported ${result.featureCount} requirements.`;catalogImportStatus.textContent=message;notice(message);await loadAdmin(); } catch (error) { catalogImportStatus.textContent=error instanceof SyntaxError ? "Catalog file is not valid JSON." : error.message; } finally { button.textContent="Validate and import catalog";button.disabled = !catalogFile.files?.[0]; } });
$("#context-form").addEventListener("submit", async event => { event.preventDefault(); const button = $("button[type=submit]", event.currentTarget); button.disabled = true; try { await api("/api/admin/context", { method: "PUT", body: JSON.stringify({ content: $("#context-content").value }) }); notice("Shared project context saved."); } catch (error) { notice(error.message); } finally { button.disabled = false; } });
$("#dialog-close").addEventListener("click", () => { $("#task-dialog").close(); location.hash = "tasks"; });
$$('[data-close-dialog]').forEach(button => button.addEventListener("click", () => { $("#" + button.dataset.closeDialog).close(); location.hash = "contributors"; }));
$("#task-dialog").addEventListener("cancel", () => { location.hash = "tasks"; }); $("#contributor-dialog").addEventListener("cancel", () => { location.hash = "contributors"; });
window.addEventListener("hashchange", handleLocation);
document.addEventListener("visibilitychange", () => { clearTimeout(refreshTimer); if (!document.hidden) refreshDashboard(); });
async function boot() {
 if (["localhost", "127.0.0.1"].includes(location.hostname)) $("#local-data-banner").hidden = false;
 try { const data = await api("/api/dashboard"); lastFingerprint = fingerprint(data); renderDashboard(data); }
 catch (error) { $("#project-map-groups").replaceChildren(el("p", "error-state", `Project data could not be loaded. ${error.message}`)); $("#last-updated").textContent = "Unavailable"; }
 try { await loadSession(); } catch (error) { notice(error.message); }
 handleLocation(); scheduleRefresh(refreshDelay);
}
boot();
