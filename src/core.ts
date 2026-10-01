import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { formatInstructions } from "./instructions.js";

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

/** True when `dir` is `root` itself or lies underneath it. Pass canonical paths. */
export function isWithinRoot(dir: string, root: string) {
	const relative = path.relative(root, dir);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Climb from a missing path to its nearest existing ancestor, contained in the
 * canonical session root. Returns null when the ancestor escapes the root or the
 * filesystem root is reached.
 */
async function nearestExistingAncestor(target: string, canonicalRoot: string) {
	let current = path.dirname(target);
	for (;;) {
		const canonical = await realpath(current).catch(() => null);
		if (canonical !== null) return isWithinRoot(canonical, canonicalRoot) ? canonical : null;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export async function resolveContainedPath(filepath: string, cwd: string) {
	const root = path.resolve(cwd);
	const target = path.resolve(cwd, filepath);

	const canonicalRoot = await realpath(root).catch(() => null);
	if (canonicalRoot === null) return null;
	// A missing leaf (deleted target, glob, not-yet-created file) falls back to
	// the nearest existing ancestor so the applicable rules still resolve.
	const canonicalTarget =
		(await realpath(target).catch(() => null)) ?? (await nearestExistingAncestor(target, canonicalRoot));
	if (canonicalTarget === null) return null;
	if (canonicalTarget === canonicalRoot) return null;
	if (!isWithinRoot(canonicalTarget, canonicalRoot)) return null;
	return { root: canonicalRoot, target: canonicalTarget };
}

async function readContainedInstructionFile(
	candidate: string,
	root: string,
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile | undefined> {
	// Canonicalize the instruction file itself: a symlink resolving outside the
	// canonical session root is rejected instead of read.
	const canonical = await realpath(candidate).catch(() => null);
	if (canonical !== null && !isWithinRoot(canonical, root)) return undefined;

	const content = await readText(canonical ?? candidate);
	if (!content) return undefined;

	return { filepath: candidate, content };
}

async function collectDirectoryFiles(
	current: string,
	target: string,
	root: string,
	filenames: string[],
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile[]> {
	const files: AgentsFile[] = [];
	for (const filename of filenames) {
		const candidate = path.resolve(path.join(current, filename));
		if (candidate === target) continue;
		const file = await readContainedInstructionFile(candidate, root, readText);
		if (file) files.push(file);
	}
	return files;
}

/**
 * Walk from the target file's directory up to (but not including) the project root,
 * collecting any files matching the given filenames at each level.
 * The target file itself is always skipped. Results are closest-first to match OpenCode:
 * the most specific directory instructions are injected before broader ones.
 * File contents and the ancestor collection are never truncated by size.
 */
export async function collectRecursive(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
	filenamesOrOptions: string[] | { filenames?: string[] } = AGENTS_FILENAMES,
): Promise<AgentsFile[]> {
	const filenames = Array.isArray(filenamesOrOptions)
		? filenamesOrOptions
		: filenamesOrOptions.filenames ?? AGENTS_FILENAMES;
	const root = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
	const target = path.resolve(cwd, filepath);
	// Canonicalize the walk anchor so symlinked roots (e.g. /tmp on macOS) compare
	// consistently; fall back to the lexical path when it does not resolve.
	const canonicalTarget = await realpath(target).catch(() => target);
	// A trailing separator marks a directory target: start the walk at the
	// directory itself instead of its parent.
	let current = filepath.endsWith(path.sep) ? canonicalTarget : path.dirname(canonicalTarget);
	const results: AgentsFile[] = [];

	while (current !== root && isWithinRoot(current, root)) {
		const directory = await collectDirectoryFiles(
			current,
			canonicalTarget,
			root,
			filenames,
			readText,
		);
		results.push(...directory);

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
	return collectRecursive(filepath, cwd, readText, { filenames: AGENTS_FILENAMES });
}

/** Collect ancestor DESIGN.md files walking up from the target file. */
export async function collectRecursiveDesign(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile[]> {
	return collectRecursive(filepath, cwd, readText, { filenames: DESIGN_FILENAMES });
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
			text: formatInstructions(item),
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
