import { realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export type AgentsFile = {
	filepath: string;
	content: string;
	truncated?: boolean;
	originalBytes?: number;
	injectedBytes?: number;
};

const AGENTS_FILENAMES = ["AGENTS.md"];
const DESIGN_FILENAMES = ["DESIGN.md"];
export const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024;
export const DEFAULT_MAX_BYTES_PER_READ = 128 * 1024;
const REPLACEMENT_CHAR = "\uFFFD";

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

export async function resolveContainedPath(filepath: string, cwd: string) {
	const root = path.resolve(cwd);
	const target = path.resolve(cwd, filepath);

	try {
		const canonicalRoot = await realpath(root);
		const canonicalTarget = await realpath(target);
		if (canonicalTarget === canonicalRoot) return null;
		if (!isWithinRoot(canonicalTarget, canonicalRoot)) return null;
		return { root: canonicalRoot, target: canonicalTarget };
	} catch {
		return null;
	}
}

export type TruncationResult = {
	content: string;
	truncated: boolean;
	originalBytes: number;
	injectedBytes: number;
};

export function truncateForContext(content: string, maxBytes: number, filepath?: string): TruncationResult {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(content);
	if (bytes.byteLength <= maxBytes) {
		return { content, truncated: false, originalBytes: bytes.byteLength, injectedBytes: bytes.byteLength };
	}

	const decoder = new TextDecoder("utf-8", { fatal: false });
	let decoded = decoder.decode(bytes.subarray(0, Math.max(0, maxBytes)));
	while (decoded.endsWith(REPLACEMENT_CHAR)) {
		decoded = decoded.slice(0, -1);
	}

	const notice = filepath
		? `\n\n[Note: Content was truncated to save context window space. For full context, please read the file directly: ${filepath}]`
		: "";
	const truncatedContent = `${decoded}${notice}`;
	return {
		content: truncatedContent,
		truncated: true,
		originalBytes: bytes.byteLength,
		injectedBytes: encoder.encode(truncatedContent).byteLength,
	};
}

type CollectOptions = {
	filenames?: string[];
	maxBytesPerFile?: number;
	maxBytesPerRead?: number;
};

/**
 * Walk from the target file's directory up to (but not including) the project root,
 * collecting any files matching the given filenames at each level.
 * The target file itself is always skipped. Results are closest-first to match OpenCode:
 * the most specific directory instructions are injected before broader ones.
 */
export async function collectRecursive(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
	filenamesOrOptions: string[] | CollectOptions = AGENTS_FILENAMES,
): Promise<AgentsFile[]> {
	const options = Array.isArray(filenamesOrOptions) ? { filenames: filenamesOrOptions } : filenamesOrOptions;
	const filenames = options.filenames ?? AGENTS_FILENAMES;
	const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
	let remainingBytes = options.maxBytesPerRead ?? DEFAULT_MAX_BYTES_PER_READ;
	const root = path.resolve(cwd);
	const target = path.resolve(cwd, filepath);
	let current = path.dirname(target);
	const results: AgentsFile[] = [];

	while (current !== root && isWithinRoot(current, root) && remainingBytes > 0) {
		for (const filename of filenames) {
			const candidate = path.resolve(path.join(current, filename));
			if (candidate === target) continue;
			const rawContent = await readText(candidate);
			if (rawContent) {
				const truncated = truncateForContext(rawContent, Math.min(maxBytesPerFile, remainingBytes), candidate);
				results.push({
					filepath: candidate,
					content: truncated.content,
					truncated: truncated.truncated,
					originalBytes: truncated.originalBytes,
					injectedBytes: truncated.injectedBytes,
				});
				remainingBytes -= truncated.injectedBytes;
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
