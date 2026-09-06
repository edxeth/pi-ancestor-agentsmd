import path from "node:path";

/**
 * Generic, tool-agnostic extraction of filesystem path candidates from arbitrary
 * tool input. Tools that touch the filesystem must name a location somewhere in
 * their input; keying on location-naming instead of tool identity keeps injection
 * working under any tool replacement (codex-style exec_command, MCP tools, ...).
 *
 * Collection runs in two phases so structured fields (path/workdir/...) always
 * earn candidate slots before free-form token noise: the candidate cap can never
 * starve an explicit path field.
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

const BASE_KEYS = new Set(["workdir", "cwd", "directory", "dir", "working_directory", "workingdirectory"]);

/** Shell vocabulary (not tool names) whose next argument names a directory. */
const DIRECTORY_KEYWORDS = new Set(["cd", "pushd", "ls", "dir"]);
const DIRECTORY_FLAGS = new Set(["-C", "--prefix", "--directory", "--workdir", "--cwd"]);

const MAX_DEPTH = 4;
const MAX_STRING_SCAN = 16 * 1024;
const MAX_CANDIDATES = 16;
const LINE_SUFFIX = /:[0-9]+(?:[-,][0-9]+)*$/;
const HAS_SEPARATOR = /[\\/]/;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,8}$/;
const SHELL_TOKEN_PATTERN = /(?:[^\s"'`]+|"[^"]*"?|'[^']*'?|`[^`]*`?)+/g;
const SHELL_QUOTE_PATTERN = /'([^']*)'?|"([^"]*)"?|`([^`]*)`?/g;

type CandidateAdder = (raw: string, base: string) => void;

function cleanValue(raw: string) {
	return raw
		.trim()
		.replace(/^['"`]|['"`]$/g, "")
		.replace(/[,;:]+$/, "")
			.trim();
}

function removeAttachedFlagValue(value: string) {
	if (!value.startsWith("-")) return value;
	const equals = value.indexOf("=");
	return equals < 0 ? "" : value.slice(equals + 1);
}

function looksLikePath(value: string) {
	return (
		value.length > 0 &&
		!value.includes("://") &&
		!/[{}]/.test(value) &&
		(HAS_SEPARATOR.test(value) || HAS_EXTENSION.test(value))
	);
}

function tokenCandidate(raw: string): string | undefined {
	// Trailing closing punctuation glued on by tokenization is junk (a quoted span
	// ending in '}'), but only strip it when no quote precedes it: a quote before
	// the closers marks a JSON fragment like file.ts"}}, which stays rejected.
	if (/['"`][)\]}]+$/.test(raw)) return undefined;
	const cleaned = removeAttachedFlagValue(cleanValue(raw))
		.replace(/[)\]}]+$/, "")
		.replace(LINE_SUFFIX, "");
	return looksLikePath(cleaned) ? cleaned : undefined;
}

type TokenState = { base: string; expectsDirectory: boolean };

function isDirectoryTargetMarker(token: string) {
	return DIRECTORY_KEYWORDS.has(token.toLowerCase()) || DIRECTORY_FLAGS.has(token);
}

function resolveDirectoryTarget(token: string, base: string) {
	if (token.startsWith("-") || token.includes("://") || token === "&&" || token === ";") return undefined;
	return path.resolve(base, token);
}

/** Token scan with shell working-directory tracking for cd/pushd/ls-style targets. */
/** Split on whitespace while keeping quoted spans ("my dir") as single tokens. */
function shellTokens(raw: string) {
	return (raw.match(SHELL_TOKEN_PATTERN) ?? [])
		.map((token) => token.replace(SHELL_QUOTE_PATTERN, "$1$2$3"))
		.filter(Boolean);
}

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&", ">", "<", ">>", "<<"]);

function isShellOperator(token: string) {
	return SHELL_OPERATORS.has(token) || token.startsWith("-");
}

function scanTokens(raw: string, initialBase: string, addCandidate: CandidateAdder, depth = 0) {
	const state: TokenState = { base: initialBase, expectsDirectory: false };
	const tokens = shellTokens(raw);
	const bareWords: string[] = [];
	for (const [index, token] of tokens.entries()) {
		const cleaned = cleanValue(token);
		if (!cleaned) continue;
		if (isDirectoryTargetMarker(cleaned)) {
			state.expectsDirectory = true;
			continue;
		}
		if (state.expectsDirectory) {
			// Flags between a directory keyword and its operand do not consume it.
			if (cleaned.startsWith("-")) continue;
			state.expectsDirectory = false;
			const resolved = resolveDirectoryTarget(cleaned, state.base);
			if (resolved) {
				addCandidate(resolved, state.base);
				state.base = resolved;
			}
			continue;
		}
		// A whitespace-bearing token can only come from a quoted span, ambiguous between
		// one path with spaces and a nested command line. Keep both readings: the whole
		// span as a candidate, plus a depth-bounded rescan of its contents.
		const pathShaped = tokenCandidate(token);
		if (pathShaped) addCandidate(pathShaped, state.base);
		// A bare operand of any command may name a directory (find src, rg pattern src);
		// the command word itself never does. Collected second so prose words only
		// consume candidate budget left over after real paths; URLs never qualify.
		if (!pathShaped && index > 0 && !isShellOperator(cleaned) && !cleaned.includes("://")) {
			bareWords.push(cleaned);
		}
		if (/\s/.test(token) && depth < MAX_DEPTH) scanTokens(token, state.base, addCandidate, depth + 1);
	}
	for (const word of bareWords) addCandidate(word, state.base);
}



function tryParseJson(text: string): unknown | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return undefined;
	}
}

function scanString(raw: string, base: string, depth: number, addCandidate: CandidateAdder) {
	const budget = raw.length > MAX_STRING_SCAN ? raw.slice(0, MAX_STRING_SCAN) : raw;
	const parsed = tryParseJson(budget);
	if (parsed !== null && typeof parsed === "object") {
		collectStructuredValue(parsed, depth + 1, base, addCandidate);
		collectTokenValue(parsed, depth + 1, base, addCandidate);
	}
	scanTokens(budget, base, addCandidate, depth);
}

function computeRecordBase(entries: Array<[string, unknown]>, base: string) {
	for (const [key, child] of entries) {
		if (typeof child === "string" && BASE_KEYS.has(key.toLowerCase())) {
			const cleaned = cleanValue(child);
			if (cleaned) return { base: path.resolve(base, cleaned), fromKey: true };
		}
	}
	return { base, fromKey: false };
}

function isCollectableValue(value: unknown, depth: number) {
	return depth <= MAX_DEPTH && value !== null && typeof value === "object";
}

function isStructuredPathKey(key: string) {
	return PATH_KEYS.has(key) && !BASE_KEYS.has(key);
}

function collectStructuredEntry(
	key: string,
	child: unknown,
	depth: number,
	base: string,
	addCandidate: CandidateAdder,
) {
	const normalizedKey = key.toLowerCase();
	if (typeof child !== "string") {
		collectStructuredValue(child, depth + 1, base, addCandidate);
		return;
	}
	if (isStructuredPathKey(normalizedKey)) addCandidate(child, base);
}

function collectStructuredValue(value: unknown, depth: number, base: string, addCandidate: CandidateAdder) {
	if (!isCollectableValue(value, depth)) return;

	const entries = Object.entries(value as Record<string, unknown>);
	const record = computeRecordBase(entries, base);
	// BASE_KEYS values are added once, during the structured phase.
	if (record.fromKey) addCandidate(record.base, base);

	for (const [key, child] of entries) collectStructuredEntry(key, child, depth, record.base, addCandidate);
}

function collectTokenEntry(
	key: string,
	child: unknown,
	depth: number,
	base: string,
	addCandidate: CandidateAdder,
) {
	const normalizedKey = key.toLowerCase();
	if (typeof child === "string") {
		if (!PATH_KEYS.has(normalizedKey)) scanString(child, base, depth, addCandidate);
		return;
	}
	collectTokenValue(child, depth + 1, base, addCandidate);
}

function collectTokenValue(value: unknown, depth: number, base: string, addCandidate: CandidateAdder) {
	if (!isCollectableValue(value, depth)) return;

	const entries = Object.entries(value as Record<string, unknown>);
	const recordBase = computeRecordBase(entries, base).base;
	for (const [key, child] of entries) collectTokenEntry(key, child, depth, recordBase, addCandidate);
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

	if (typeof input === "string") {
		scanString(input, baseDir, 0, addRelativeTo);
		return candidates;
	}

	collectStructuredValue(input, 0, baseDir, addRelativeTo);
	collectTokenValue(input, 0, baseDir, addRelativeTo);
	return candidates;
}
