/* Project Map geometry and SVG renderer. Kept dependency-free so its layout and
 * routing can be tested independently of the dashboard and D1. */
(() => {
  const CARD_W = 240, CARD_H = 92, STEP_X = 312, STEP_Y = 128, MARGIN = 24;
  const ROUTE_PAD = 12, GRID = 2, MARKER_LENGTH = 11, ARROW_GAP = 3;
  const MARKER = Object.freeze({ viewBox: "0 0 11 11", markerWidth: 11, markerHeight: 11, markerUnits: "userSpaceOnUse", refX: 11, refY: 5.5, orient: "auto", path: "M0 0 L11 5.5 L0 11Z", fill: "#c88056" });
  const compare = (a, b) => a.localeCompare(b, "en");
  const key = (a, b) => `${a}\u0000${b}`;
  const cmpPath = (a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = compare(a[i], b[i]); if (c) return c; }
    return a.length - b.length;
  };
  function normalize(modules, relations) {
    const names = [...new Set(modules.map(item => String(item.module)).filter(Boolean))].sort(compare), known = new Set(names), edges = new Map();
    for (const relation of relations) {
      // API fields are dependent module (module) and prerequisite (dependsOnModule).
      const source = String(relation.dependsOnModule || ""), target = String(relation.module || "");
      if (!known.has(source) || !known.has(target) || source === target) continue;
      const id = key(source, target), previous = edges.get(id);
      if (!previous || Number(relation.taskDependencies || 0) > previous.taskDependencies) edges.set(id, { source, target, taskDependencies: Number(relation.taskDependencies || 0) });
    }
    return { names, edges: [...edges.values()].sort((a, b) => compare(a.source, b.source) || compare(a.target, b.target)) };
  }
  function stronglyConnected(names, edges) {
    const adjacency = new Map(names.map(name => [name, []]));
    edges.forEach(edge => adjacency.get(edge.source).push(edge.target)); adjacency.forEach(list => list.sort(compare));
    let index = 0; const indices = new Map(), low = new Map(), stack = [], onStack = new Set(), components = [];
    function visit(node) {
      indices.set(node, index); low.set(node, index++); stack.push(node); onStack.add(node);
      for (const next of adjacency.get(node)) {
        if (!indices.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
        else if (onStack.has(next)) low.set(node, Math.min(low.get(node), indices.get(next)));
      }
      if (low.get(node) === indices.get(node)) {
        const members = []; let member;
        do { member = stack.pop(); onStack.delete(member); members.push(member); } while (member !== node);
        components.push(members.sort(compare));
      }
    }
    names.forEach(name => { if (!indices.has(name)) visit(name); });
    return components.sort((a, b) => compare(a[0], b[0]));
  }
  function layout(names, edges, stepX = STEP_X, stepY = STEP_Y) {
    const components = stronglyConnected(names, edges), compOf = new Map();
    components.forEach((members, i) => members.forEach(name => compOf.set(name, i)));
    const outgoing = new Map(components.map((_, i) => [i, new Set()])), incoming = new Map(components.map((_, i) => [i, new Set()]));
    edges.forEach(edge => { const a = compOf.get(edge.source), b = compOf.get(edge.target); if (a !== b) { outgoing.get(a).add(b); incoming.get(b).add(a); } });
    const memo = new Map();
    function longest(component) {
      if (memo.has(component)) return memo.get(component);
      const choices = [...outgoing.get(component)].map(next => [component, ...longest(next)]);
      choices.sort((a, b) => b.length - a.length || cmpPath(a.map(i => components[i][0]), b.map(i => components[i][0])));
      const best = choices[0] || [component]; memo.set(component, best); return best;
    }
    const paths = components.map((_, i) => longest(i));
    paths.sort((a, b) => b.length - a.length || cmpPath(a.map(i => components[i][0]), b.map(i => components[i][0])));
    const main = paths[0] || [], positions = new Map(), occupied = new Set(), placedComponents = new Set();
    const cellKey = (c, r) => `${c},${r}`;
    const putComponent = (ci, col, row) => {
      const members = components[ci]; if (members.some((_, offset) => occupied.has(cellKey(col + offset, row)))) return false;
      members.forEach((name, offset) => { const c=col+offset,k=cellKey(c,row);positions.set(name,{x:MARGIN+c*stepX,y:MARGIN+row*stepY,col:c,row});occupied.add(k); });
      placedComponents.add(ci);return true;
    };
    let col = 0; main.forEach(ci => { putComponent(ci,col,0);col+=components[ci].length; });let maxColumns=Math.max(1,col);
    // First pull prerequisites of already placed modules below and close to
    // their dependents. Then place each remaining DAG path as a compact row.
    const componentTarget = ci => [...outgoing.get(ci)].filter(target => placedComponents.has(target)).map(target => components[target].map(name=>positions.get(name))).flat().filter(Boolean).sort((a,b)=>a.row-b.row||a.col-b.col)[0];
    while (placedComponents.size < components.length) {
      const remainingComponents=components.map((_,i)=>i).filter(i=>!placedComponents.has(i));
      const associated=remainingComponents.map(ci=>({ci,target:componentTarget(ci)})).filter(item=>item.target).sort((a,b)=>a.target.row-b.target.row||a.target.col-b.target.col||compare(components[a.ci][0],components[b.ci][0]));
      let placedAssociated=false;
      for(const item of associated){
        const width=components[item.ci].length,t=item.target,candidates=[t.col-width,t.col-width+1,t.col-1,t.col,t.col+1];
        for(const c of [...new Set(candidates)])if(c>=0&&putComponent(item.ci,c,t.row+1)){maxColumns=Math.max(maxColumns,c+width);placedAssociated=true;break;}
      }
      if(placedAssociated)continue;
      const unplaced=new Set(remainingComponents), memo=new Map();
      const remainingPath=ci=>{if(memo.has(ci))return memo.get(ci);const choices=[...outgoing.get(ci)].filter(next=>unplaced.has(next)).map(next=>[ci,...remainingPath(next)]);choices.sort((a,b)=>b.length-a.length||cmpPath(a.map(i=>components[i][0]),b.map(i=>components[i][0])));const best=choices[0]||[ci];memo.set(ci,best);return best;};
      const candidates=remainingComponents.map(remainingPath);candidates.sort((a,b)=>b.length-a.length||cmpPath(a.map(i=>components[i][0]),b.map(i=>components[i][0])));const path=candidates[0];
      const pathWidth=path.reduce((sum,ci)=>sum+components[ci].length,0);maxColumns=Math.max(maxColumns,pathWidth);
      let placed=false;for(let row=1;!placed;row++)for(let start=0;start<maxColumns;start++){
        let x=start,available=true;for(const ci of path){for(let offset=0;offset<components[ci].length;offset++)if(occupied.has(cellKey(x+offset,row))){available=false;break;}if(!available)break;x+=components[ci].length;}
        if(available){x=start;for(const ci of path){putComponent(ci,x,row);x+=components[ci].length;}placed=true;break;}
      }
    }
    return { positions, components, compOf, outgoing, incoming };
  }
  const within = (v, a, b) => v >= a && v <= b;
  function segmentHitsRect(a, b, rect) {
    if (a.y === b.y) return within(a.y, rect.y, rect.y + rect.h) && Math.max(Math.min(a.x, b.x), rect.x) < Math.min(Math.max(a.x, b.x), rect.x + rect.w);
    return within(a.x, rect.x, rect.x + rect.w) && Math.max(Math.min(a.y, b.y), rect.y) < Math.min(Math.max(a.y, b.y), rect.y + rect.h);
  }
  function segmentCrosses(a, b, c, d) {
    if (a.y === b.y && c.x === d.x) return within(c.x, Math.min(a.x, b.x), Math.max(a.x, b.x)) && within(a.y, Math.min(c.y, d.y), Math.max(c.y, d.y));
    if (a.x === b.x && c.y === d.y) return within(a.x, Math.min(c.x, d.x), Math.max(c.x, d.x)) && within(c.y, Math.min(a.y, b.y), Math.max(a.y, b.y));
    return false;
  }
  function overlaps(a, b, c, d) {
    if (a.y === b.y && c.y === d.y && a.y === c.y) return Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x)) < Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x));
    if (a.x === b.x && c.x === d.x && a.x === c.x) return Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y)) < Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y));
    return false;
  }
  function compress(points) {
    const out = [];
    for (const point of points) {
      while (out.length >= 2) {
        const a = out[out.length - 2], b = out[out.length - 1];
        if ((a.x === b.x && b.x === point.x) || (a.y === b.y && b.y === point.y)) out.pop(); else break;
      }
      out.push(point);
    }
    return out;
  }
  function pathD(points) {
    if (points.length < 2) return "";
    return points.slice(1).reduce((d, p, i) => d + (points[i].x === p.x ? ` V${p.y}` : ` H${p.x}`), `M${points[0].x} ${points[0].y}`);
  }
  function trimPathEnd(points, distance) {
    const trimmed=points.map(point=>({...point}));let remaining=distance;
    while(remaining>0&&trimmed.length>1){
      const end=trimmed.at(-1),before=trimmed.at(-2),length=Math.abs(end.x-before.x)+Math.abs(end.y-before.y);
      if(length<=remaining){remaining-=length;trimmed.pop();continue;}
      if(end.x!==before.x)end.x-=Math.sign(end.x-before.x)*remaining;
      else end.y-=Math.sign(end.y-before.y)*remaining;
      remaining=0;
    }
    return trimmed;
  }
  function choosePorts(edges, positions) {
    const ports = new Map(), byNodeSide = new Map();
    for (const edge of edges) {
      const a = positions.get(edge.source), b = positions.get(edge.target), dx = b.x - a.x, dy = b.y - a.y;
      let sourceSide, targetSide;
      if (Math.abs(dx) >= Math.abs(dy)) {
        sourceSide = dx >= 0 ? "right" : "left";
        targetSide = dx >= 0 ? (dy < 0 ? "bottom" : "left") : (dy < 0 ? "bottom" : "right");
      } else { sourceSide = dy >= 0 ? "bottom" : "top"; targetSide = dy >= 0 ? "top" : "bottom"; }
      ports.set(key(edge.source, edge.target), { sourceSide, targetSide });
      for (const [node, side] of [[edge.source, sourceSide], [edge.target, targetSide]]) {
        const k = key(node, side); if (!byNodeSide.has(k)) byNodeSide.set(k, []); byNodeSide.get(k).push(key(edge.source, edge.target));
      }
    }
    for (const [nodeSide, ids] of byNodeSide) {
      ids.sort(); const split = nodeSide.lastIndexOf("\u0000"), node = nodeSide.slice(0, split), side = nodeSide.slice(split + 1), p = positions.get(node);
      ids.forEach((id, i) => {
        const spread = Math.min(12, 72 / Math.max(1, ids.length - 1)), offset = Math.round(((i - (ids.length - 1) / 2) * spread) / GRID) * GRID;
        const port = side === "left" ? { x: p.x, y: p.y + CARD_H / 2 + offset } : side === "right" ? { x: p.x + CARD_W, y: p.y + CARD_H / 2 + offset } : side === "top" ? { x: p.x + CARD_W / 2 + offset, y: p.y } : { x: p.x + CARD_W / 2 + offset, y: p.y + CARD_H };
        const record = ports.get(id); if (id.startsWith(`${node}\u0000`)) record.source = port; else record.target = port;
      });
    }
    // Keep same-row horizontal fan-out lanes straight into their destinations.
    // Centering every target port independently creates an unnecessary final
    // elbow after the source has deliberately assigned a separate lane.
    const aligned=[];
    for (const edge of edges) {
      const record=ports.get(key(edge.source,edge.target)),source=positions.get(edge.source),target=positions.get(edge.target);
      const horizontal=(record.sourceSide==="right"&&record.targetSide==="left")||(record.sourceSide==="left"&&record.targetSide==="right");
      const reciprocal=ports.has(key(edge.target,edge.source));
      if(!horizontal||source.y!==target.y||reciprocal)continue;
      const lane=record.source.y,collision=edges.some(other=>{
        if(other===edge)return false;const candidate=ports.get(key(other.source,other.target));
        return candidate.sourceSide===record.targetSide&&candidate.source.x===record.target.x&&candidate.source.y===lane;
      });
      if(!collision)aligned.push(record);
    }
    aligned.forEach(record=>record.target={...record.target,y:record.source.y});
    return ports;
  }
  function routeAStar(start, goal, obstacles, routed, bounds) {
    const dirs = [[GRID,0,"R"],[-GRID,0,"L"],[0,GRID,"D"],[0,-GRID,"U"]];
    const stateKey = (x,y,d) => `${x},${y},${d}`;
    const allowedCorridor = (p, rect, port, side, owner) => {
      if (rect.name !== owner) return false;
      if (side === "left" || side === "right") return p.y === port.y && (side === "left" ? p.x <= port.x && p.x >= rect.x : p.x >= port.x && p.x <= rect.x + rect.w);
      return p.x === port.x && (side === "top" ? p.y <= port.y && p.y >= rect.y : p.y >= port.y && p.y <= rect.y + rect.h);
    };
    const blocked = (p) => obstacles.some(o => within(p.x,o.x,o.x+o.w) && within(p.y,o.y,o.y+o.h) && !allowedCorridor(p,o,start,start.side,start.owner) && !allowedCorridor(p,o,goal,goal.side,goal.owner));
    const heuristic = (x,y) => Math.abs(goal.x-x)+Math.abs(goal.y-y);
    const stateOrder = (a,b) => a.f-b.f || a.g-b.g || compare(a.d,b.d), open = [];
    const push = item => { let i=open.length;open.push(item);while(i){const parent=(i-1)>>1;if(stateOrder(open[parent],item)<=0)break;open[i]=open[parent];i=parent;}open[i]=item; };
    const pop = () => { const first=open[0],last=open.pop();if(open.length){let i=0;while(true){let child=i*2+1;if(child>=open.length)break;if(child+1<open.length&&stateOrder(open[child+1],open[child])<0)child++;if(stateOrder(last,open[child])<=0)break;open[i]=open[child];i=child;}open[i]=last;}return first; };
    push({ x:start.x,y:start.y,d:"",g:0,f:heuristic(start.x,start.y),prev:null });
    const best = new Map([[stateKey(start.x,start.y,""),0]]);
    let final = null, iterations = 0;
    while (open.length && iterations++ < 300000) {
      const current = pop();
      if (current.x === goal.x && current.y === goal.y) { final = current; break; }
      for (const [sx,sy,dir] of dirs) {
        const x=current.x+sx,y=current.y+sy;if(x<bounds.minX||x>bounds.maxX||y<bounds.minY||y>bounds.maxY)continue;
        const point={x,y}; if(blocked(point))continue;
        const segA={x:current.x,y:current.y},segB=point;
        if(routed.some(route=>route.some((p,i)=>i>0&&overlaps(segA,segB,route[i-1],p))))continue;
        let penalty=current.d&&current.d!==dir?40:0;
        for(const route of routed) for(let i=1;i<route.length;i++) if(segmentCrosses(segA,segB,route[i-1],route[i])) penalty+=200;
        const g=current.g+GRID+penalty,k=stateKey(x,y,dir);if(g>=(best.get(k)??Infinity))continue;
        best.set(k,g);push({x,y,d:dir,g,f:g+heuristic(x,y),prev:current});
      }
    }
    if (!final) return null;
    const points=[];for(let item=final;item;item=item.prev)points.push({x:item.x,y:item.y});return compress(points.reverse());
  }
  function routeEdges(names, edges, positions) {
    const ports = choosePorts(edges, positions), boxes = names.map(name => { const p=positions.get(name); return { name,x:p.x-ROUTE_PAD,y:p.y-ROUTE_PAD,w:CARD_W+ROUTE_PAD*2,h:CARD_H+ROUTE_PAD*2 }; });
    const routed=[]; const paths=[];
    const routingEdges=[...edges].sort((a,b)=>{
      const routeScore=edge=>{
        const port=ports.get(key(edge.source,edge.target)),from=port.source,to=port.target;
        const blockers=boxes.filter(box=>box.name!==edge.source&&box.name!==edge.target&&segmentHitsRect(from,to,box)).length;
        return [blockers,Math.abs(to.x-from.x)+Math.abs(to.y-from.y)];
      };
      const left=routeScore(a),right=routeScore(b);return right[0]-left[0]||right[1]-left[1]||compare(a.source,b.source)||compare(a.target,b.target);
    });
    for (const edge of routingEdges) {
      const port=ports.get(key(edge.source,edge.target)), sourceBox=boxes.find(b=>b.name===edge.source),targetBox=boxes.find(b=>b.name===edge.target);
      const start={...port.source,side:port.sourceSide,owner:edge.source},goal={...port.target,side:port.targetSide,owner:edge.target};
      // The compact direct case is both clearer and the required canonical geometry.
      const direct={x:start.x,y:start.y},directEnd={x:goal.x,y:goal.y};
      const sharesExistingSegment=routed.some(route=>route.some((point,index)=>index>0&&overlaps(direct,directEnd,route[index-1],point)));
      if(start.y===goal.y&&start.x<goal.x&&!sharesExistingSegment&&!boxes.some(b=>b.name!==edge.source&&b.name!==edge.target&&segmentHitsRect(start,goal,b))) {
        const points=[{x:start.x,y:start.y},{x:goal.x,y:goal.y}];routed.push(points);paths.push({...edge,points,d:pathD(points),strokeD:pathD(trimPathEnd(points,MARKER_LENGTH+ARROW_GAP)),markerEnd:"url(#project-map-arrow)"});continue;
      }
      const obstacles=boxes;
      let points=null, expansion=384;
      for(let attempt=0;attempt<4&&!points;attempt++,expansion*=2) {
        points=routeAStar(start,goal,obstacles,routed,{minX:Math.floor((Math.min(start.x,goal.x)-expansion)/GRID)*GRID,maxX:Math.ceil((Math.max(start.x,goal.x)+expansion)/GRID)*GRID,minY:Math.floor((Math.min(start.y,goal.y)-expansion)/GRID)*GRID,maxY:Math.ceil((Math.max(start.y,goal.y)+expansion)/GRID)*GRID});
      }
      if(!points) throw new Error(`Unable to route prerequisite edge ${edge.source} -> ${edge.target} without crossing a module card`);
      routed.push(points);paths.push({...edge,points,d:pathD(points),strokeD:pathD(trimPathEnd(points,MARKER_LENGTH+ARROW_GAP)),markerEnd:"url(#project-map-arrow)"});
    }
    return paths.sort((a,b)=>compare(a.source,b.source)||compare(a.target,b.target));
  }
  function buildProjectMap(modules, relations) {
    const { names, edges }=normalize(modules,relations);if(!names.length)return {nodes:[],edges:[],viewBox:{x:0,y:0,width:48,height:48},marker:MARKER};
    let model=null, paths=null, stepX=STEP_X,stepY=STEP_Y;
    for(let attempt=0;attempt<5;attempt++) {
      model=layout(names,edges,stepX,stepY);
      try { paths=routeEdges(names,edges,model.positions);break; } catch(error) { if(attempt===4)throw error;stepX+=96;stepY+=48; }
    }
    const nodes=names.map(name=>({name,...model.positions.get(name)}));let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const node of nodes){minX=Math.min(minX,node.x);minY=Math.min(minY,node.y);maxX=Math.max(maxX,node.x+CARD_W);maxY=Math.max(maxY,node.y+CARD_H);}
    for(const edge of paths){for(const point of edge.points){minX=Math.min(minX,point.x-11);minY=Math.min(minY,point.y-5.5);maxX=Math.max(maxX,point.x+11);maxY=Math.max(maxY,point.y+5.5);}}
    const viewBox={x:minX-MARGIN,y:minY-MARGIN,width:maxX-minX+MARGIN*2,height:maxY-minY+MARGIN*2};
    return {nodes,edges:paths,viewBox,marker:MARKER,card:{width:CARD_W,height:CARD_H},layout:{stepX,stepY}};
  }
  function svgEl(tag, attrs={}, text="") { const node=document.createElementNS("http://www.w3.org/2000/svg",tag);for(const [name,value] of Object.entries(attrs))node.setAttribute(name,String(value));if(text)node.textContent=text;return node; }
  function fitSvgLabel(node, value, maxWidth) {
    node.textContent=value;
    if (node.getComputedTextLength() <= maxWidth) return;
    let label=value;
    while(label.length && node.getComputedTextLength() > maxWidth) { label=label.slice(0,-1); node.textContent=`${label.trimEnd()}…`; }
  }
  function renderProjectMap(root, modules, relations, onSelect) {
    root.replaceChildren();if(!modules.length){const empty=document.createElement("p");empty.className="empty-state";empty.textContent="Modules will appear when tasks are registered.";root.append(empty);return {nodes:[],edges:[],viewBox:{x:0,y:0,width:48,height:48},marker:MARKER};}
    const model=buildProjectMap(modules,relations),svg=svgEl("svg",{viewBox:`${model.viewBox.x} ${model.viewBox.y} ${model.viewBox.width} ${model.viewBox.height}`,width:model.viewBox.width,height:model.viewBox.height,class:"module-map-svg",role:"group","aria-roledescription":"module dependency map","aria-label":"Module dependency map. Select a module to list its tasks."});
    const defs=svgEl("defs"),marker=svgEl("marker",{id:"project-map-arrow",viewBox:MARKER.viewBox,markerWidth:MARKER.markerWidth,markerHeight:MARKER.markerHeight,markerUnits:MARKER.markerUnits,refX:MARKER.refX,refY:MARKER.refY,orient:MARKER.orient});marker.append(svgEl("path",{d:MARKER.path,fill:MARKER.fill}));defs.append(marker);svg.append(defs);
    for(const edge of model.edges){const line=svgEl("path",{d:edge.strokeD,fill:"none",stroke:"#a18a78","stroke-width":2,"stroke-dasharray":"6 5","stroke-linejoin":"miter",class:"dependency-edge"});line.append(svgEl("title",{},`${edge.source} is a prerequisite for ${edge.target} (${edge.taskDependencies} task link${edge.taskDependencies===1?"":"s"})`));svg.append(line);svg.append(svgEl("path",{d:edge.d,fill:"none",stroke:"none","marker-end":"url(#project-map-arrow)","aria-hidden":"true","pointer-events":"none"}));}
    const byName=new Map(modules.map(item=>[String(item.module),item]));
    for(const node of model.nodes){const item=byName.get(node.name),total=Number(item.total||0),integrated=Number(item.integrated||0),percent=total?Math.round(integrated/total*100):0,g=svgEl("g",{class:"module-map-node",role:"button",tabindex:0,"aria-label":`${node.name}: ${percent}% integrated, ${integrated} of ${total} tasks. Select to see tasks.`});
      g.append(svgEl("rect",{x:node.x,y:node.y,width:CARD_W,height:CARD_H,rx:5,class:"module-node-box"}));
      const name=svgEl("text",{x:node.x+16,y:node.y+28,class:"module-node-name"});g.append(name);fitSvgLabel(name,node.name,148);
      g.append(svgEl("text",{x:node.x+224,y:node.y+28,"text-anchor":"end",class:`module-node-percent${percent===0?" module-node-percent-zero":""}`},`${percent}%`));
      g.append(svgEl("text",{x:node.x+16,y:node.y+53,class:"module-node-count"},`${integrated} of ${total} integrated`));
      g.append(svgEl("rect",{x:node.x+16,y:node.y+72,width:208,height:4,rx:2,class:"module-progress-track"}));
      g.append(svgEl("rect",{x:node.x+16,y:node.y+72,width:208*(total?integrated/total:0),height:4,rx:2,class:"module-progress-fill"}));
      const title=svgEl("title",{},`${node.name}: ${percent}% integrated; ${integrated} of ${total} tasks`);g.append(title);g.addEventListener("click",()=>onSelect?.(node.name));g.addEventListener("keydown",event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();onSelect?.(node.name);}});svg.append(g);
    }
    const viewport=document.createElement("div");viewport.className="module-map-viewport";viewport.append(svg);root.append(viewport);
    if(model.nodes.length===1){const note=document.createElement("p");note.className="module-map-single-note";note.textContent="Only one registered module. More modules will appear as tasks are added.";root.append(note);}
    const legend=document.createElement("div");legend.className="module-map-legend";const sample=svgEl("svg",{width:42,height:12,viewBox:"0 0 42 12","aria-hidden":"true"});sample.append(svgEl("path",{d:"M1 6 H39",fill:"none",stroke:"#a18a78","stroke-width":2,"stroke-dasharray":"6 5"}));legend.append(sample);const label=document.createElement("span");label.textContent="Prerequisite → Dependent";legend.append(label);root.append(legend);
    return model;
  }
  globalThis.RustKoreProjectMap={buildProjectMap,renderProjectMap,trimPathEnd,marker:MARKER,constants:{CARD_W,CARD_H,STEP_X,STEP_Y,MARGIN,MARKER_LENGTH,ARROW_GAP}};
})();
