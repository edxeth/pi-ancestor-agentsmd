import path from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export type AgentsFile = {
	filepath: string;
	content: string;
};

const AGENTS_FILENAMES = ["AGENTS.md"];
const DESIGN_FILENAMES = ["DESIGN.md"];

export function hasNoContextFilesFlag(argv = process.argv) {
	return argv.includes("--no-context-files") || argv.includes("-nc");
}

export function isRootDesignMdEnabled() {
	return process.env.PI_ROOT_DESIGN_MD === "1";
}

export function isAncestorDesignMdEnabled() {
	return process.env.PI_ANCESTOR_DESIGN_MD === "1";
}

/** AGENTS.md ancestor injection — enabled by default, opt-out via PI_ANCESTOR_AGENTS_MD=0 */
export function isAncestorAgentsMdEnabled() {
	return process.env.PI_ANCESTOR_AGENTS_MD !== "0";
}

function isWithinRoot(dir: string, root: string) {
	const relative = path.relative(root, dir);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Walk from the target file's directory up to (but not including) the project root,
 * collecting any files matching the given filenames at each level.
 * The target file itself is always skipped.
 */
export async function collectRecursive(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
	filenames: string[] = AGENTS_FILENAMES,
): Promise<AgentsFile[]> {
	const root = path.resolve(cwd);
	const target = path.resolve(cwd, filepath);
	let current = path.dirname(target);
	const results: AgentsFile[] = [];

	while (current !== root && isWithinRoot(current, root)) {
		for (const filename of filenames) {
			const candidate = path.resolve(path.join(current, filename));
			if (candidate === target) continue;
			const content = await readText(candidate);
			if (content) {
				results.push({ filepath: candidate, content });
			}
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return results;
}

/** Kept for backward compatibility — delegates to collectRecursive with default filenames. */
export async function collectRecursiveAgents(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile[]> {
	return collectRecursive(filepath, cwd, readText, AGENTS_FILENAMES);
}

/** Collect ancestor DESIGN.md files walking up from the target file. */
export async function collectRecursiveDesign(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile[]> {
	return collectRecursive(filepath, cwd, readText, DESIGN_FILENAMES);
}

export function prependAgentsContent(
	content: (TextContent | ImageContent)[],
	agentsFiles: AgentsFile[],
	loadedPaths: Set<string>,
) {
	const additions: TextContent[] = [];

	for (const item of agentsFiles) {
		const resolved = path.resolve(item.filepath);
		if (loadedPaths.has(resolved)) continue;
		loadedPaths.add(resolved);
		additions.push({
			type: "text",
			text: `Instructions from: ${resolved}\n${item.content}`,
		});
	}

	if (additions.length === 0) {
		return { content, changed: false };
	}

	return {
		content: [...additions, ...content],
		changed: true,
	};
}
