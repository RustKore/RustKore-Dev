export const ROADMAP_STATES = ["verified", "testing", "developing", "planned"];

export function deriveStateCounts(roadmap) {
	const counts = { verified: 0, testing: 0, developing: 0, planned: 0 };
	for (const cell of roadmap?.coverage ?? []) {
		for (const state of ROADMAP_STATES) counts[state] += Number(cell?.[state] ?? 0);
	}
	return { ...counts, total: ROADMAP_STATES.reduce((sum, state) => sum + counts[state], 0) };
}

export function verifiedPercentage(counts) {
	return counts.total > 0 ? Math.round((counts.verified / counts.total) * 100) : 0;
}

export function buildDonutSegments(counts, radius = 78) {
	const circumference = 2 * Math.PI * radius;
	if (!counts.total) return [];
	let offset = 0;
	return ROADMAP_STATES.flatMap((state) => {
		const value = Number(counts[state] ?? 0);
		if (!value) return [];
		const length = (value / counts.total) * circumference;
		const segment = { state, value, length, offset: -offset, remainder: circumference - length };
		offset += length;
		return [segment];
	});
}

export function alphaReadiness(milestones = []) {
	const alpha = milestones.find((milestone) => milestone.id === "alpha");
	return alpha ? { verified: Number(alpha.readiness?.verified ?? 0), total: Number(alpha.readiness?.total ?? 0) } : { verified: 0, total: 0 };
}

export function validateAcceptanceEdit({ state, evidenceUrl, reason, currentState }) {
	if (!["planned", "testing", "verified"].includes(state)) return "Choose Planned, Testing, or Verified.";
	if (typeof reason !== "string" || reason.trim().length < 8 || reason.length > 800) return "Provide a reason between 8 and 800 characters.";
	if (currentState === "verified" && state === "planned") return "Move this criterion to Testing before returning it to Planned.";
	if (state === "verified") {
		if (typeof evidenceUrl !== "string" || evidenceUrl.length > 2048) return "Evidence URL must be at most 2048 characters.";
		try {
			const url = new URL(evidenceUrl);
			if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".") || url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(url.hostname) || url.hostname.startsWith("[")) throw new Error();
		} catch { return "Verified criteria require public HTTPS evidence without embedded credentials."; }
	}
	return "";
}

export const ALPHA_FLOW_NODES = [
	{ id: "connect", label: "Connect", x: 10, y: 16, icon: "network" },
	{ id: "navigate", label: "Navigate", x: 130, y: 16, icon: "route" },
	{ id: "combat", label: "Combat", x: 250, y: 16, icon: "swords" },
	{ id: "skills", label: "Use skills", x: 250, y: 126, icon: "zap" },
	{ id: "loot", label: "Collect loot", x: 130, y: 126, icon: "package" },
	{ id: "recover", label: "Recover HP/SP", x: 10, y: 126, icon: "heart-pulse" },
].map((node) => ({ ...node, width: 100, height: 52, radius: 5 }));

export const ALPHA_FLOW_PATHS = [
	{ from: "connect", to: "navigate", d: "M110 42 H130" },
	{ from: "navigate", to: "combat", d: "M230 42 H250" },
	{ from: "combat", to: "skills", d: "M300 68 V126" },
	{ from: "skills", to: "loot", d: "M250 152 H230" },
	{ from: "loot", to: "recover", d: "M130 152 H110" },
	{ from: "recover", to: "navigate", d: "M60 126 V96 H180 V68" },
];

const cos30 = Math.cos(Math.PI / 6);
const sin30 = Math.sin(Math.PI / 6);

export function projectIsometric({ x, y, z }, origin = { x: 48, y: 195 }) {
	return { x: origin.x + (x - y) * cos30, y: origin.y + (x + y) * sin30 - z };
}

export function buildIsometricMilestones() {
	const count = 6, width = 36, depth = 28, height = 9, startX = 22, startY = 24, stepX = 68, stepZ = 59;
	return Array.from({ length: count }, (_, index) => {
		const x = startX + index * stepX, y = startY, z = index * stepZ;
		const top3d = [
			{ x, y, z: z + height },
			{ x: x + width, y, z: z + height },
			{ x: x + width, y: y + depth, z: z + height },
			{ x, y: y + depth, z: z + height },
		];
		const bottom3d = top3d.map((point) => ({ ...point, z: z }));
		const route3d = { x: x + width / 2, y: y + depth / 2, z: z + height };
		const flag3d = {
			poleTop: { x: route3d.x, y: route3d.y, z: route3d.z + 26 },
			outerTop: { x: route3d.x + 10, y: route3d.y, z: route3d.z + 21 },
			outerBottom: { x: route3d.x, y: route3d.y, z: route3d.z + 15 },
		};
		return {
			index,
			top: top3d.map((point) => projectIsometric(point)),
			xFace: [top3d[0], top3d[1], bottom3d[1], bottom3d[0]].map((point) => projectIsometric(point)),
			yFace: [top3d[1], top3d[2], bottom3d[2], bottom3d[1]].map((point) => projectIsometric(point)),
			route: projectIsometric(route3d),
			flag: Object.fromEntries(Object.entries(flag3d).map(([key, point]) => [key, projectIsometric(point)])),
		};
	});
}

export function parseOrthogonalPath(d) {
	const tokens = d.match(/[MHV]|-?\d+(?:\.\d+)?/g) ?? [];
	let cursor = 0, point = null, prior = null;
	const points = [];
	while (cursor < tokens.length) {
		const command = tokens[cursor++];
		if (command === "M" || command === "H" || command === "V") {
			const a = Number(tokens[cursor++]);
			if (command === "M") {
				const b = Number(tokens[cursor++]); point = { x: a, y: b };
				if (prior) points.push(point); else points.push(point);
			} else if (point && command === "H") point = { x: a, y: point.y };
			else if (point && command === "V") point = { x: point.x, y: a };
			if (command !== "M" && point) points.push(point);
			prior = command;
		} else throw new Error(`Unsupported path command: ${command}`);
	}
	return points;
}
