import { describe, expect, it } from "vitest";
import { ALPHA_FLOW_NODES, ALPHA_FLOW_PATHS, alphaReadiness, buildDonutSegments, buildIsometricMilestones, deriveStateCounts, parseOrthogonalPath, projectIsometric, verifiedPercentage } from "../public/roadmap-visual.js";

describe("Feature Roadmap visual data", () => {
	it("derives donut counts and verified coverage from the live category-by-milestone data", () => {
		const roadmap = { summary: { total: 10 }, coverage: [
			{ total: 6, verified: 2, testing: 1, developing: 1, planned: 2 },
			{ total: 4, verified: 0, testing: 1, developing: 0, planned: 3 },
		] };
		const counts = deriveStateCounts(roadmap);
		expect(counts).toEqual({ verified: 2, testing: 2, developing: 1, planned: 5, total: 10 });
		expect(verifiedPercentage(counts)).toBe(20);
		expect(buildDonutSegments(counts).map(({ state }) => state)).toEqual(["verified", "testing", "developing", "planned"]);
		expect(buildDonutSegments(counts)).toHaveLength(4);
	});

	it("keeps zero states out of the donut and handles an empty catalog", () => {
		const empty = deriveStateCounts({ coverage: [] });
		expect(empty).toEqual({ verified: 0, testing: 0, developing: 0, planned: 0, total: 0 });
		expect(verifiedPercentage(empty)).toBe(0);
		expect(buildDonutSegments(empty)).toEqual([]);
		const allPlanned = deriveStateCounts({ coverage: [{ total: 3, verified: 0, testing: 0, developing: 0, planned: 3 }] });
		expect(buildDonutSegments(allPlanned).map((segment) => segment.state)).toEqual(["planned"]);
		expect(buildDonutSegments(allPlanned)[0].length).toBeCloseTo(2 * Math.PI * 78);
	});

	it("uses the cumulative Alpha release readiness record", () => {
		expect(alphaReadiness([{ id: "prototype", readiness: { verified: 1, total: 5 } }, { id: "alpha", readiness: { verified: 4, total: 16 } }])).toEqual({ verified: 4, total: 16 });
		expect(alphaReadiness([])).toEqual({ verified: 0, total: 0 });
	});

	it("projects all six isometric platforms from the same axes and keeps them inside the viewBox", () => {
		const platforms = buildIsometricMilestones();
		expect(platforms).toHaveLength(6);
		const points = platforms.flatMap((platform) => [...platform.top, ...platform.xFace, ...platform.yFace, platform.route, ...Object.values(platform.flag)]);
		for (const point of points) {
			expect(point.x).toBeGreaterThanOrEqual(0); expect(point.x).toBeLessThanOrEqual(420);
			expect(point.y).toBeGreaterThanOrEqual(0); expect(point.y).toBeLessThanOrEqual(280);
		}
		const projectedX = projectIsometric({ x: 20, y: 24, z: 50 }), projectedY = projectIsometric({ x: 20, y: 44, z: 50 }), projectedVertical = projectIsometric({ x: 20, y: 24, z: 41 });
		expect((projectedX.y - projectIsometric({ x: 0, y: 24, z: 50 }).y) / (projectedX.x - projectIsometric({ x: 0, y: 24, z: 50 }).x)).toBeCloseTo(Math.tan(Math.PI / 6));
		expect((projectedY.y - projectedX.y) / (projectedY.x - projectedX.x)).toBeCloseTo(-Math.tan(Math.PI / 6));
		expect(projectedVertical.x).toBe(projectedX.x); expect(projectedVertical.y).toBe(projectedX.y + 9);
		const routeY = platforms.map((platform) => platform.route.y);
		expect(routeY.every((value, index) => index === 0 || value < routeY[index - 1])).toBe(true);
		for (const platform of platforms) expect(platform.top).toHaveLength(4);
	});

	it("preserves the specified Alpha flow geometry and routes only orthogonally around nodes", () => {
		expect(ALPHA_FLOW_NODES.map(({ id, x, y, width, height, radius }) => ({ id, x, y, width, height, radius }))).toEqual([
			{ id: "connect", x: 10, y: 16, width: 100, height: 52, radius: 5 },
			{ id: "navigate", x: 130, y: 16, width: 100, height: 52, radius: 5 },
			{ id: "combat", x: 250, y: 16, width: 100, height: 52, radius: 5 },
			{ id: "skills", x: 250, y: 126, width: 100, height: 52, radius: 5 },
			{ id: "loot", x: 130, y: 126, width: 100, height: 52, radius: 5 },
			{ id: "recover", x: 10, y: 126, width: 100, height: 52, radius: 5 },
		]);
		expect(ALPHA_FLOW_PATHS.map((path) => path.d)).toEqual(["M110 42 H130", "M230 42 H250", "M300 68 V126", "M250 152 H230", "M130 152 H110", "M60 126 V96 H180 V68"]);
		for (const path of ALPHA_FLOW_PATHS) {
			const points = parseOrthogonalPath(path.d);
			for (let index = 1; index < points.length; index++) expect(points[index].x === points[index - 1].x || points[index].y === points[index - 1].y).toBe(true);
			const source = ALPHA_FLOW_NODES.find((node) => node.id === path.from)!;
			const destination = ALPHA_FLOW_NODES.find((node) => node.id === path.to)!;
			for (let index = 1; index < points.length; index++) {
				for (const node of ALPHA_FLOW_NODES.filter((item) => item.id !== source.id && item.id !== destination.id)) {
					const a = points[index - 1], b = points[index], left = node.x, right = node.x + node.width, top = node.y, bottom = node.y + node.height;
					const crossesInterior = a.y === b.y ? a.y > top && a.y < bottom && Math.max(Math.min(a.x, b.x), left) < Math.min(Math.max(a.x, b.x), right) : a.x === b.x && a.x > left && a.x < right && Math.max(Math.min(a.y, b.y), top) < Math.min(Math.max(a.y, b.y), bottom);
					expect(crossesInterior, `${path.from} → ${path.to} crosses ${node.id}`).toBe(false);
				}
			}
		}
	});

	it("does not share flow segments between connectors", () => {
		const segments = ALPHA_FLOW_PATHS.flatMap((path) => { const points = parseOrthogonalPath(path.d); return points.slice(1).map((point, index) => ({ from: path.from, a: points[index], b: point })); });
		for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
			const a = segments[i], b = segments[j];
			const horizontalOverlap = a.a.y === a.b.y && b.a.y === b.b.y && a.a.y === b.a.y && Math.max(Math.min(a.a.x, a.b.x), Math.min(b.a.x, b.b.x)) < Math.min(Math.max(a.a.x, a.b.x), Math.max(b.a.x, b.b.x));
			const verticalOverlap = a.a.x === a.b.x && b.a.x === b.b.x && a.a.x === b.a.x && Math.max(Math.min(a.a.y, a.b.y), Math.min(b.a.y, b.b.y)) < Math.min(Math.max(a.a.y, a.b.y), Math.max(b.a.y, b.b.y));
			expect(horizontalOverlap || verticalOverlap, `Shared segment between ${a.from} and ${b.from}`).toBe(false);
		}
	});
});
