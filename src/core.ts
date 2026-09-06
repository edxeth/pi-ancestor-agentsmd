import { access, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

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

/** Nested AGENTS.md manifest — enabled by default, opt-out via PI_NESTED_AGENTS_MANIFEST=0 */
export function isNestedAgentsManifestEnabled() {
	return process.env.PI_NESTED_AGENTS_MANIFEST !== "0";
}

const MANIFEST_SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".hg",
	".svn",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"venv",
	".venv",
	".cache",
	".next",
	".turbo",
]);
/** Maximum directory depth traversed for the startup manifest. */
export const MANIFEST_MAX_DEPTH = 4;
/** Maximum number of nested directories listed in the startup manifest. */
export const MANIFEST_MAX_ENTRIES = 32;

type ManifestQueueItem = { dir: string; depth: number };

type ManifestOptions = { maxDepth: number; maxEntries: number };

async function fileExists(filepath: string) {
	try {
		await access(filepath);
		return true;
	} catch {
		return false;
	}
}

function resolveManifestOptions(options: { maxDepth?: number; maxEntries?: number }): ManifestOptions {
	return {
		maxDepth: options.maxDepth ?? MANIFEST_MAX_DEPTH,
		maxEntries: options.maxEntries ?? MANIFEST_MAX_ENTRIES,
	};
}

function isManifestDirectory(entry: { isDirectory: () => boolean; name: string }) {
	return entry.isDirectory() && !entry.name.startsWith(".") && !MANIFEST_SKIP_DIRS.has(entry.name);
}

async function inspectManifestEntry(
	entry: { isDirectory: () => boolean; name: string },
	dir: string,
	depth: number,
	canonicalRoot: string,
	options: ManifestOptions,
	results: string[],
): Promise<ManifestQueueItem | undefined> {
	if (!isManifestDirectory(entry)) return undefined;

	const child = path.join(dir, entry.name);
	if (results.length < options.maxEntries && (await fileExists(path.join(child, "AGENTS.md")))) {
		results.push(path.relative(canonicalRoot, child));
	}

	return depth + 1 < options.maxDepth ? { dir: child, depth: depth + 1 } : undefined;
}

async function collectManifestLevel(
	item: ManifestQueueItem,
	canonicalRoot: string,
	options: ManifestOptions,
	results: string[],
): Promise<ManifestQueueItem[]> {
	const entries = await readdir(item.dir, { withFileTypes: true }).catch(() => []);
	const next: ManifestQueueItem[] = [];
	for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
		const child = await inspectManifestEntry(entry, item.dir, item.depth, canonicalRoot, options, results);
		if (child) next.push(child);
	}
	return next;
}

/**
 * Bounded walk collecting directories below the root that contain an AGENTS.md.
 * Used for the startup manifest so agents can discover nested rules even when
 * no tool input ever names those directories. Returns project-relative paths.
 */
export async function collectNestedAgentsDirs(
	root: string,
	options: { maxDepth?: number; maxEntries?: number } = {},
): Promise<string[]> {
	const manifestOptions = resolveManifestOptions(options);
	const canonicalRoot = await realpath(path.resolve(root)).catch(() => null);
	if (!canonicalRoot) return [];

	const results: string[] = [];
	let level: ManifestQueueItem[] = [{ dir: canonicalRoot, depth: 0 }];

	while (level.length > 0) {
		if (results.length >= manifestOptions.maxEntries) break;
		const next: ManifestQueueItem[] = [];
		for (const item of level) {
			next.push(...(await collectManifestLevel(item, canonicalRoot, manifestOptions, results)));
		}
		level = next;
	}

	return results;
}

function isWithinRoot(dir: string, root: string) {
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

type ResolvedCollectOptions = {
	filenames: string[];
	maxBytesPerFile: number;
	maxBytesPerRead: number;
};

function resolveCollectOptions(filenamesOrOptions: string[] | CollectOptions): ResolvedCollectOptions {
	const options = Array.isArray(filenamesOrOptions) ? { filenames: filenamesOrOptions } : filenamesOrOptions;
	return {
		filenames: options.filenames ?? AGENTS_FILENAMES,
		maxBytesPerFile: options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE,
		maxBytesPerRead: options.maxBytesPerRead ?? DEFAULT_MAX_BYTES_PER_READ,
	};
}

type InstructionFileResult = { file?: AgentsFile; remainingBytes: number };

async function readContainedInstructionFile(
	candidate: string,
	root: string,
	maxBytesPerFile: number,
	remainingBytes: number,
	readText: (filepath: string) => Promise<string>,
): Promise<InstructionFileResult> {
	// Canonicalize the instruction file itself: a symlink resolving outside the
	// canonical session root is rejected instead of read.
	const canonical = await realpath(candidate).catch(() => null);
	if (canonical !== null && !isWithinRoot(canonical, root)) return { remainingBytes };

	const rawContent = await readText(canonical ?? candidate);
	if (!rawContent) return { remainingBytes };

	const truncated = truncateForContext(rawContent, Math.min(maxBytesPerFile, remainingBytes), candidate);
	return {
		file: {
			filepath: candidate,
			content: truncated.content,
			truncated: truncated.truncated,
			originalBytes: truncated.originalBytes,
			injectedBytes: truncated.injectedBytes,
		},
		remainingBytes: remainingBytes - truncated.injectedBytes,
	};
}

async function collectDirectoryFiles(
	current: string,
	target: string,
	root: string,
	filenames: string[],
	maxBytesPerFile: number,
	remainingBytes: number,
	readText: (filepath: string) => Promise<string>,
): Promise<{ files: AgentsFile[]; remainingBytes: number }> {
	const files: AgentsFile[] = [];
	for (const filename of filenames) {
		const candidate = path.resolve(path.join(current, filename));
		if (candidate === target) continue;
		const result = await readContainedInstructionFile(candidate, root, maxBytesPerFile, remainingBytes, readText);
		if (result.file) files.push(result.file);
		remainingBytes = result.remainingBytes;
	}
	return { files, remainingBytes };
}

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
	const options = resolveCollectOptions(filenamesOrOptions);
	let remainingBytes = options.maxBytesPerRead;
	const root = await realpath(path.resolve(cwd)).catch(() => path.resolve(cwd));
	const target = path.resolve(cwd, filepath);
	// Canonicalize the walk anchor so symlinked roots (e.g. /tmp on macOS) compare
	// consistently; fall back to the lexical path when it does not resolve.
	const canonicalTarget = await realpath(target).catch(() => target);
	// A trailing separator marks a directory target: start the walk at the
	// directory itself instead of its parent.
	let current = filepath.endsWith(path.sep) ? canonicalTarget : path.dirname(canonicalTarget);
	const results: AgentsFile[] = [];

	while (current !== root && isWithinRoot(current, root) && remainingBytes > 0) {
		const directory = await collectDirectoryFiles(
			current,
			canonicalTarget,
			root,
			options.filenames,
			options.maxBytesPerFile,
			remainingBytes,
			readText,
		);
		results.push(...directory.files);
		remainingBytes = directory.remainingBytes;

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
