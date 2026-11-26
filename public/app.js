const $ = (selector, root = document) => root.querySelector(selector);
const el = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; if (value !== undefined) node.textContent = value; return node; };
let dashboard = null, csrf = "";
const notice = message => { const box=$("#notice");box.textContent=message;box.classList.add("show");clearTimeout(notice.timer);notice.timer=setTimeout(()=>box.classList.remove("show"),3500); };
async function api(path,options={}) {
 const headers=new Headers(options.headers||{}); if(options.body)headers.set("content-type","application/json");
 if(["POST","PATCH","PUT","DELETE"].includes(options.method)){headers.set("x-csrf-token",csrf);headers.set("origin",location.origin);}
 const response=await fetch(path,{...options,headers,credentials:"same-origin"}),data=response.status===204?{}:await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(data.error||"Falha na solicitação ("+response.status+")");return data;
}
const count=value=>Number(value||0).toLocaleString("pt-BR");
function renderDashboard(data){
 dashboard=data;const s=data.summary||{},total=Number(s.total||0),integrated=Number(s.integrated||0),pct=total?Math.round(integrated/total*100):0;
 $("#progress-percent").textContent=pct+"%";$("#progress-caption").textContent=count(integrated)+" de "+count(total)+" tarefas";
 $("#metric-total").textContent=count(total);$("#metric-available").textContent=count(s.available);$("#metric-blocked").textContent=count(s.blocked);$("#metric-reserved").textContent=count(s.reserved);$("#metric-review").textContent=count(s.inReview);$("#metric-approved").textContent=count(s.approved);$("#metric-integrated").textContent=count(integrated);
 const modules=$("#modules");modules.replaceChildren();const select=$("#module-filter"),selected=select.value;select.replaceChildren(new Option("Todos os módulos",""));
 for(const item of data.modules||[]){const progress=Number(item.total)?Math.round(Number(item.integrated)/Number(item.total)*100):0,card=el("article","module-card"),head=el("div","module-head");
 head.append(el("span","",item.module),el("span","",progress+"%"));const meta=el("div","module-meta");meta.append(el("span","",count(item.integrated)+" integradas"),el("span","",count(item.total)+" tarefas"));
 const track=el("div","progress-track"),bar=el("span");bar.style.width=progress+"%";track.append(bar);card.append(head,meta,track);modules.append(card);select.add(new Option(item.module,item.module));}
 select.value=selected;renderTasks(data.tasks||[]);
 const list=$("#contributors-list");list.replaceChildren();if(!(data.contributors||[]).length)list.append(el("li","loading","As primeiras integrações aparecerão aqui."));
 (data.contributors||[]).forEach((person,index)=>{const li=el("li"),number=el("span","rank-number",String(index+1).padStart(2,"0")),avatar=person.avatarUrl?el("img","avatar"):el("span","avatar",(person.login||"?").slice(0,1).toUpperCase());
 if(person.avatarUrl){avatar.src=person.avatarUrl;avatar.alt="";avatar.loading="lazy";}const info=el("span","person-info");info.append(el("strong","",person.name||person.login||"Colaborador"),el("span","","@"+(person.login||"github")));
 li.append(number,avatar,info,el("strong","rank-count",count(person.integratedCount)));list.append(li);});
 const active=$("#active-agents");active.replaceChildren();$("#active-count").textContent=count((data.activeAgents||[]).length);if(!(data.activeAgents||[]).length)active.append(el("li","loading","Nenhum agente ativo neste momento."));
 (data.activeAgents||[]).forEach(agent=>{const li=el("li"),dot=el("span","active-indicator"),info=el("span","active-info");info.append(el("strong","",agent.agentName),el("span","","@"+agent.login+" · "+agent.module));const task=el("a","",agent.title);task.href="#tasks";info.append(task);li.append(dot,info);active.append(li);});
 const history=$("#history-list");history.replaceChildren();if(!(data.recentContributions||[]).length)history.append(el("li","loading","Nenhuma contribuição enviada ainda."));
 (data.recentContributions||[]).forEach(item=>{const li=el("li"),label=({pending:"Em revisão",accepted:"Aprovada",rejected:"Rejeitada",integrated:"Integrada"})[item.status]||item.status;li.append(el("span","",item.title+" · @"+item.login+" · "+label));
  if(item.pullRequestUrl){const link=el("a","history-sha","PR ↗");link.href=item.pullRequestUrl;link.target="_blank";link.rel="noreferrer";li.append(link);}li.append(el("time","history-time",timeAgo(item.createdAt)));history.append(li);});
}
function renderTasks(tasks){const module=$("#module-filter").value,visible=tasks.filter(t=>!module||t.module===module),rows=$("#task-rows");rows.replaceChildren();
 if(!visible.length){const tr=el("tr"),td=el("td","loading","Nenhuma tarefa corresponde a este filtro.");td.colSpan=5;tr.append(td);rows.append(tr);}
 visible.forEach(task=>{const tr=document.createElement("tr"),titleCell=document.createElement("td"),title=el("span","task-title");title.append(el("strong","",task.title),el("span","",task.description||""));titleCell.append(title);
 const moduleCell=el("td","module-tag",task.module),stateCell=document.createElement("td"),key=task.state||task.status,state=el("span","status status-"+key,({available:"Disponível",blocked:"Bloqueada",reserved:"Reservada",in_review:"Em revisão",approved:"Aprovada",integrated:"Integrada"})[key]||key);
 if(key==="blocked"){state.title="Aguardando a aprovação de tarefas dependentes";state.setAttribute("aria-label","Bloqueada: aguardando tarefas dependentes");}stateCell.append(state);
 const assignee=el("td","assignee",task.assignee?"@"+task.assignee+" · "+(task.agentName||"agente"):"—"),priority=el("td","priority","P"+String(task.priority).padStart(2,"0"));tr.append(titleCell,moduleCell,stateCell,assignee,priority);rows.append(tr);});
 $("#task-count").textContent="Exibindo "+visible.length+" de "+((dashboard&&dashboard.tasks)||[]).length+" tarefas públicas";
}
function timeAgo(timestamp){if(!timestamp)return"";const seconds=Math.max(0,Math.floor(Date.now()/1000-Number(timestamp)));if(seconds<60)return"agora";if(seconds<3600)return"há "+Math.floor(seconds/60)+" min";if(seconds<86400)return"há "+Math.floor(seconds/3600)+" h";return"há "+Math.floor(seconds/86400)+" d";}
async function loadTokens(){const result=await api("/api/tokens"),list=$("#token-list");list.replaceChildren();if(!result.tokens.length)list.append(el("li","loading","Nenhuma credencial MCP criada."));
 result.tokens.forEach(token=>{const li=el("li","token-row"),info=el("div");info.append(el("div","token-name",token.agentName||token.role),el("div","token-meta",token.role+" · criada "+timeAgo(token.createdAt)+(token.revokedAt?" · revogada":"")));li.append(info);
 if(!token.revokedAt){const button=el("button","button button-quiet","Revogar");button.type="button";button.addEventListener("click",async()=>{try{await api("/api/tokens/"+encodeURIComponent(token.tokenId),{method:"DELETE"});notice("Credencial revogada.");await loadTokens();}catch(e){notice(e.message);}});li.append(button);}else li.classList.add("revoked");list.append(li);});
}
async function loadAdmin(){const values=await Promise.all([api("/api/admin/submissions"),api("/api/admin/collaborators")]),submissions=$("#submission-list");submissions.replaceChildren();
 if(!values[0].submissions.length)submissions.append(el("li","loading","Nenhuma submissão cadastrada."));
 values[0].submissions.forEach(item=>{const li=el("li","admin-row"),main=el("div","admin-row-main");main.append(el("strong","",item.taskTitle+" · "+item.status),el("span","",item.contributor+" / "+item.agentName+" · "+item.commitSha.slice(0,8)));
 if(item.pullRequestUrl){const link=el("a","",item.pullRequestUrl);link.href=item.pullRequestUrl;link.target="_blank";link.rel="noreferrer";main.append(link);}const actions=el("div","admin-actions");
 if(item.status==="accepted"&&!item.integratedAt){const button=el("button","button","Registrar integração");button.type="button";button.addEventListener("click",async()=>{try{await api("/api/admin/submissions/"+encodeURIComponent(item.id)+"/integrate",{method:"POST"});notice("Integração confirmada pelo GitHub.");await refresh();}catch(e){notice(e.message);}});actions.append(button);}
 else main.append(el("span","",item.integratedAt?"Integrada "+timeAgo(item.integratedAt):item.reviewDecision?"Revisão: "+item.reviewDecision:"Aguardando revisão MCP"));li.append(main,actions);submissions.append(li);});
 const people=$("#admin-collaborators");people.replaceChildren();values[1].collaborators.forEach(person=>{const li=el("li","admin-row"),main=el("div","admin-row-main");main.append(el("strong","","@"+person.login),el("span","",count(person.integratedCount)+" integrações"+(person.suspendedAt?" · suspenso":"")));
 const actions=el("div","admin-actions"),review=el("button","button button-quiet",person.reviewerEnabled?"Remover revisor":"Tornar revisor"),suspend=el("button","button button-quiet",person.suspendedAt?"Reativar":"Suspender");review.type=suspend.type="button";
 review.addEventListener("click",()=>updatePerson(person,{reviewerEnabled:!Boolean(person.reviewerEnabled)}));suspend.addEventListener("click",()=>updatePerson(person,{suspended:!person.suspendedAt}));actions.append(review,suspend);li.append(main,actions);people.append(li);});
}
async function updatePerson(person,patch){try{await api("/api/admin/collaborators/"+encodeURIComponent(person.id),{method:"PATCH",body:JSON.stringify(patch)});notice("Colaborador atualizado.");await loadAdmin();}catch(e){notice(e.message);}}
async function refresh(){try{renderDashboard(await api("/api/dashboard"));}catch(e){notice(e.message);}
 try{const session=await api("/api/me");if(session.authenticated){csrf=session.csrfToken;$("#login-link").hidden=true;$("#logout-button").hidden=false;$("#account-label").textContent="@"+session.githubLogin;$("#account-panel").hidden=false;$("#account-github").textContent="@"+session.githubLogin;
 const roles=$("#token-form select[name=role]");roles.querySelector('[value="reviewer"]').hidden=!(session.isAdmin||session.reviewerEnabled);roles.querySelector('[value="admin"]').hidden=!session.isAdmin;await loadTokens();if(session.isAdmin){$("#admin-panel").hidden=false;await loadAdmin();}}
 else{csrf="";$("#login-link").hidden=false;$("#logout-button").hidden=true;$("#account-label").textContent="Acesso aberto";}}
 catch(e){notice(e.message);}}
$("#module-filter").addEventListener("change",()=>renderTasks((dashboard&&dashboard.tasks)||[]));
$("#token-form").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);try{const token=await api("/api/tokens",{method:"POST",body:JSON.stringify({name:form.get("name"),role:form.get("role")})}),box=$("#new-token");box.replaceChildren(el("p",""));box.firstChild.textContent="Credencial de "+token.name+" criada. Copie agora: ela não será exibida novamente.";box.append(el("code","",token.token));const copy=el("button","button button-quiet","Copiar token");copy.type="button";copy.addEventListener("click",async()=>{await navigator.clipboard.writeText(token.token);notice("Token copiado.");});box.append(copy);box.hidden=false;event.currentTarget.reset();await loadTokens();}catch(e){notice(e.message);}});
$("#logout-button").addEventListener("click",async()=>{try{await api("/api/logout",{method:"POST"});location.reload();}catch(e){notice(e.message);}});
$("#task-form").addEventListener("submit",async event=>{event.preventDefault();const form=new FormData(event.currentTarget);try{await api("/api/admin/tasks",{method:"POST",body:JSON.stringify({title:form.get("title"),module:form.get("module"),priority:Number(form.get("priority")),description:form.get("description"),acceptanceCriteria:form.get("acceptanceCriteria")})});event.currentTarget.reset();notice("Tarefa criada.");await refresh();}catch(e){notice(e.message);}});
refresh();setInterval(()=>api("/api/dashboard").then(renderDashboard).catch(()=>{}),30000);
