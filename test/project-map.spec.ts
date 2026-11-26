import { describe, expect, it } from "vitest";
import "../public/project-map.js";

const map = (globalThis as any).RustKoreProjectMap as {
	buildProjectMap: (modules: any[], relations: any[]) => any;
	trimPathEnd: (points: Array<{ x: number; y: number }>, distance: number) => Array<{ x: number; y: number }>;
	marker: Record<string, unknown>;
	constants: Record<string, number>;
};

const module = (name: string) => ({ module: name, total: 10, integrated: 4 });
const relation = (prerequisite: string, dependent: string, taskDependencies = 1) => ({ module: dependent, dependsOnModule: prerequisite, taskDependencies });
const fixtureModules = ["Core", "Protocol", "Runtime", "Tooling", "Networking"].map(module);
const fixtureRelations = [relation("Core", "Protocol"), relation("Protocol", "Runtime"), relation("Networking", "Runtime")];

function segments(points: Array<{ x: number; y: number }>) { return points.slice(1).map((point, i) => [points[i], point]); }
function intersectsInterior(a: any, b: any, node: any) {
	if (a.y === b.y) return a.y > node.y && a.y < node.y + 92 && Math.max(Math.min(a.x, b.x), node.x) < Math.min(Math.max(a.x, b.x), node.x + 240);
	return a.x > node.x && a.x < node.x + 240 && Math.max(Math.min(a.y, b.y), node.y) < Math.min(Math.max(a.y, b.y), node.y + 92);
}
function assertGeometry(model: any) {
	const nodes = model.nodes;
	for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
		const a = nodes[i], b = nodes[j];
		expect(a.x + 240 <= b.x || b.x + 240 <= a.x || a.y + 92 <= b.y || b.y + 92 <= a.y, `cards ${a.name}/${b.name} overlap`).toBe(true);
	}
	for (const edge of model.edges) {
		expect(edge.markerEnd).toBe("url(#project-map-arrow)");
		const line = segments(edge.points), last = line.at(-1)!;
		expect(last[0].x === last[1].x || last[0].y === last[1].y).toBe(true);
		const source=nodes.find((node:any)=>node.name===edge.source),target=nodes.find((node:any)=>node.name===edge.target),start=edge.points[0],end=edge.points.at(-1);
		expect(start.x===source.x||start.x===source.x+240||start.y===source.y||start.y===source.y+92).toBe(true);
		expect(end.x===target.x||end.x===target.x+240||end.y===target.y||end.y===target.y+92).toBe(true);
		for (const [a, b] of line) for (const node of nodes) expect(intersectsInterior(a, b, node), `${edge.source} -> ${edge.target} crosses ${node.name}`).toBe(false);
		for (const point of edge.points) {
			expect(point.x).toBeGreaterThanOrEqual(model.viewBox.x);
			expect(point.x).toBeLessThanOrEqual(model.viewBox.x + model.viewBox.width);
			expect(point.y).toBeGreaterThanOrEqual(model.viewBox.y);
			expect(point.y).toBeLessThanOrEqual(model.viewBox.y + model.viewBox.height);
		}
	}
	for(const node of nodes){expect(node.x).toBeGreaterThanOrEqual(model.viewBox.x);expect(node.y).toBeGreaterThanOrEqual(model.viewBox.y);expect(node.x+240).toBeLessThanOrEqual(model.viewBox.x+model.viewBox.width);expect(node.y+92).toBeLessThanOrEqual(model.viewBox.y+model.viewBox.height);}
	for (let i = 0; i < model.edges.length; i++) for (let j = i + 1; j < model.edges.length; j++) {
		for (const [a, b] of segments(model.edges[i].points)) for (const [c, d] of segments(model.edges[j].points)) {
			const shared = a.y === b.y && c.y === d.y && a.y === c.y
				? Math.max(Math.min(a.x,b.x),Math.min(c.x,d.x)) < Math.min(Math.max(a.x,b.x),Math.max(c.x,d.x))
				: a.x === b.x && c.x === d.x && a.x === c.x
					? Math.max(Math.min(a.y,b.y),Math.min(c.y,d.y)) < Math.min(Math.max(a.y,b.y),Math.max(c.y,d.y)) : false;
			expect(shared, `edges ${i}/${j} share a segment`).toBe(false);
		}
	}
}

describe("Project Map geometry", () => {
	it("matches the required five-module fixture exactly", () => {
		const model = map.buildProjectMap(fixtureModules, fixtureRelations), coordinates = Object.fromEntries(model.nodes.map((node: any) => [node.name, [node.x, node.y]]));
		expect(coordinates).toEqual({ Core: [24,24], Networking: [336,152], Protocol: [336,24], Runtime: [648,24], Tooling: [24,152] });
		expect(Object.fromEntries(model.edges.map((edge: any) => [`${edge.source} -> ${edge.target}`, edge.d]))).toEqual({
			"Core -> Protocol": "M264 70 H336",
			"Networking -> Runtime": "M576 198 H768 V116",
			"Protocol -> Runtime": "M576 70 H648",
		});
		assertGeometry(model);
	});

	it("keeps the arrow anchored to the destination while ending the dashed stroke before its head", () => {
		const model=map.buildProjectMap(fixtureModules,fixtureRelations);
		for(const edge of model.edges){
			const strokeEnd=map.trimPathEnd(edge.points,map.constants.MARKER_LENGTH+map.constants.ARROW_GAP).at(-1)!;
			const arrowTip=edge.points.at(-1)!;
			const gap=Math.abs(arrowTip.x-strokeEnd.x)+Math.abs(arrowTip.y-strokeEnd.y);
			expect(edge.markerEnd).toBe("url(#project-map-arrow)");
			expect(edge.strokeD).not.toBe(edge.d);
			expect(gap).toBe(map.constants.MARKER_LENGTH+map.constants.ARROW_GAP);
		}
		expect(Object.fromEntries(model.edges.map((edge:any)=>[`${edge.source} -> ${edge.target}`,[edge.d,edge.strokeD]]))).toEqual({
			"Core -> Protocol":["M264 70 H336","M264 70 H322"],
			"Networking -> Runtime":["M576 198 H768 V116","M576 198 H768 V130"],
			"Protocol -> Runtime":["M576 70 H648","M576 70 H634"],
		});
	});

	it("derives one directed connector for each distinct cross-module D1 relation", () => {
		const d1Rows = [relation("Core", "Protocol", 2), relation("Core", "Protocol", 1), relation("Protocol", "Protocol"), relation("Unknown", "Runtime"), relation("Protocol", "Runtime", 3)];
		const result = map.buildProjectMap(fixtureModules, d1Rows);
		expect(result.edges.map((edge: any) => `${edge.source}->${edge.target}`)).toEqual(["Core->Protocol", "Protocol->Runtime"]);
		expect(result.edges.find((edge: any) => edge.source === "Core").taskDependencies).toBe(2);
	});

	it("places independent modules without inventing relations and handles reciprocal module dependencies", () => {
		const independent = map.buildProjectMap([module("Delta"), module("Alpha"), module("Beta")], []);
		expect(independent.nodes.map((node: any) => node.name)).toEqual(["Alpha", "Beta", "Delta"]);
		expect(independent.edges).toHaveLength(0);
		const reciprocal = map.buildProjectMap([module("Alpha"), module("Beta"), module("Gamma")], [relation("Alpha", "Beta"), relation("Beta", "Alpha"), relation("Gamma", "Beta")]);
		expect(reciprocal.edges).toHaveLength(3);
		assertGeometry(reciprocal);
	});

	it("keeps branched dependency groups compact and their connectors disjoint", () => {
		const modules=Array.from({length:20},(_,i)=>module(`Module ${String(i+1).padStart(2,"0")}`)),relations:any[]=[];
		for(let base=0;base<20;base+=4){const [a,b,c,d]=modules.slice(base,base+4).map(item=>item.module);relations.push(relation(a,b),relation(a,c),relation(b,d),relation(c,d));}
		const model=map.buildProjectMap(modules,relations);expect(model.edges).toHaveLength(20);assertGeometry(model);
	});

	it("keeps same-row fan-out lanes aligned at the destination edge", () => {
		const result=map.buildProjectMap([module("A"),module("B"),module("C")],[relation("A","B"),relation("A","C"),relation("B","C")]);
		const direct=result.edges.find((edge:any)=>edge.source==="A"&&edge.target==="B");
		expect(direct.points).toHaveLength(2);
		expect(direct.points[0].y).toBe(direct.points.at(-1).y);
		const routed=result.edges.find((edge:any)=>edge.source==="A"&&edge.target==="C");
		expect(routed.points[0].y).toBe(routed.points.at(-1).y);
		expect(routed.points.at(-1).y).not.toBe(result.nodes.find((node:any)=>node.name==="C").y+46);
		assertGeometry(result);
	});

	for (const size of [1, 5, 10, 20, 50]) it(`keeps ${size} modules valid`, () => {
		const modules = Array.from({ length: size }, (_, i) => module(`Module-${String(i).padStart(2, "0")}`));
		const relations = modules.slice(1).map((item, i) => relation(modules[i].module, item.module));
		const model = map.buildProjectMap(modules, relations);
		expect(model.nodes).toHaveLength(size); expect(model.edges).toHaveLength(Math.max(0, size - 1));
		assertGeometry(model);
	});

	it("defines the exact single marker whose auto orientation follows the last segment", () => {
		expect(map.marker).toEqual({ viewBox:"0 0 11 11", markerWidth:11, markerHeight:11, markerUnits:"userSpaceOnUse", refX:11, refY:5.5, orient:"auto", path:"M0 0 L11 5.5 L0 11Z", fill:"#c88056" });
	});
});
