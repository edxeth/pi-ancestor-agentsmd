import path from "node:path";

/**
 * Generic, tool-agnostic extraction of filesystem path candidates from arbitrary
 * tool input. Tools that touch the filesystem must name a location somewhere in
 * their input; keying on location-naming instead of tool identity keeps injection
 * working under any tool replacement (codex-style exec_command, MCP tools, ...).
 */

const PATH_KEYS = new Set([
	"path",
	"file",
	"filepath",
	"file_path",
	"workdir",
	"cwd",
	"directory",
	"dir",
	"notebookpath",
	"notebook_path",
]);

const BASE_KEYS = new Set(["workdir", "cwd", "directory", "dir"]);

const MAX_DEPTH = 2;
const MAX_STRING_SCAN = 16 * 1024;
const MAX_CANDIDATES = 16;
const LINE_SUFFIX = /:[0-9]+(?:[-,][0-9]+)*$/;
const HAS_SEPARATOR = /[\\/]/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;

type CandidateAdder = (raw: string, base: string) => void;

function cleanValue(raw: string) {
	return raw
		.trim()
		.replace(/^['"`]|['"`]$/g, "")
		.replace(/[,;:]+$/, "")
		.trim();
}

function tokenCandidate(raw: string): string | undefined {
	let cleaned = cleanValue(raw);
	if (!cleaned) return undefined;
	if (cleaned.startsWith("-") || cleaned.includes("://")) return undefined;
	cleaned = cleaned.replace(LINE_SUFFIX, "");
	if (!HAS_SEPARATOR.test(cleaned) && !HAS_EXTENSION.test(cleaned)) return undefined;
	return cleaned;
}

function scanTokens(raw: string, base: string, addCandidate: CandidateAdder) {
	if (raw.length > MAX_STRING_SCAN) return;
	for (const token of raw.split(/\s+/)) {
		const candidate = tokenCandidate(token);
		if (candidate) addCandidate(candidate, base);
	}
}

function resolveRecordBase(entries: Array<[string, unknown]>, base: string, addCandidate: CandidateAdder) {
	let recordBase = base;
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		if (typeof child === "string" && BASE_KEYS.has(normalizedKey)) {
			const cleaned = cleanValue(child);
			if (cleaned) {
				recordBase = path.resolve(base, cleaned);
				addCandidate(recordBase, base);
			}
		}
	}
	return recordBase;
}

function walkEntries(entries: Array<[string, unknown]>, depth: number, recordBase: string, addCandidate: CandidateAdder) {
	for (const [key, child] of entries) {
		const normalizedKey = key.toLowerCase();
		if (typeof child === "string") {
			// BASE_KEYS values were already added as candidates while resolving recordBase.
			if (PATH_KEYS.has(normalizedKey) && !BASE_KEYS.has(normalizedKey)) addCandidate(child, recordBase);
			else scanTokens(child, recordBase, addCandidate);
		} else {
			walkValue(child, depth + 1, recordBase, addCandidate);
		}
	}
}

function walkValue(value: unknown, depth: number, base: string, addCandidate: CandidateAdder) {
	if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;

	const entries = Object.entries(value as Record<string, unknown>);
	const recordBase = resolveRecordBase(entries, base, addCandidate);
	walkEntries(entries, depth, recordBase, addCandidate);
}

/**
 * Extract filesystem-looking candidates from arbitrary tool input.
 *
 * @param input - Structured or free-form tool input to inspect.
 * @param baseDir - Directory used to resolve relative candidates.
 * @returns Deduplicated absolute path candidates in discovery order.
 */
export function extractPathCandidates(input: unknown, baseDir: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();

	const addRelativeTo = (raw: string, base: string) => {
		if (candidates.length >= MAX_CANDIDATES) return;
		const cleaned = cleanValue(raw);
		if (!cleaned) return;
		const resolved = path.resolve(base, cleaned);
		if (!seen.has(resolved)) {
			seen.add(resolved);
			candidates.push(resolved);
		}
	};

	walkValue(input, 0, baseDir, addRelativeTo);
	return candidates;
}
