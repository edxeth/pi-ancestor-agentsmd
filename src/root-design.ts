import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
	parseSessionEntries,
	type SessionEntry,
	type SessionHeader,
	type SessionProjection,
} from "@earendil-works/pi-coding-agent";
import { formatInstructions } from "./instructions.js";
import { isWithinRoot } from "./core.js";

/** System-section name owned by this extension for the root DESIGN.md value. */
export const ROOT_DESIGN_SECTION = "ancestor-agentsmd:root-design";
/** Custom entry type persisting the session-lifetime root DESIGN.md capture. */
export const ROOT_DESIGN_SNAPSHOT_ENTRY = "ancestor-agentsmd:root-design-snapshot";

const SNAPSHOT_VERSION = 1;

/**
 * The root DESIGN.md value fixed for one session, recorded once through a
 * durable custom entry. `block` is the exact rendered envelope delivered on
 * every request of that session; `block: ""` is the empty state recorded when
 * the file was absent or empty at capture time, so creating the file later
 * cannot silently change that session's guidance. File edits take effect in
 * new sessions only.
 */
export type RootDesignSnapshot = {
	version: 1;
	path: string;
	contentHash: string;
	content: string;
	block: string;
};

/** Parse and fully validate one persisted capture entry. Invalid shapes are ignored. */
export function parseRootDesignSnapshot(entry: SessionEntry): RootDesignSnapshot | undefined {
	if (!isSnapshotEntry(entry)) return undefined;
	// SAFETY: SessionEntry.data is typed loosely at the persistence boundary;
	// isSnapshotData fully validates every field before use.
	const data = entry.data as Partial<RootDesignSnapshot> | undefined;
	if (!isSnapshotData(data)) return undefined;
	return { version: SNAPSHOT_VERSION, path: data.path, contentHash: data.contentHash, content: data.content, block: data.block };
}

function isSnapshotEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === ROOT_DESIGN_SNAPSHOT_ENTRY;
}

function isObjectData(data: unknown): data is Partial<RootDesignSnapshot> {
	return typeof data === "object" && data !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/** Identity fields identify the captured file; the payload carries the fixed guidance. */
function isSnapshotData(data: unknown): data is RootDesignSnapshot {
	return isObjectData(data)
		&& data.version === SNAPSHOT_VERSION
		&& isNonEmptyString(data.path)
		&& isNonEmptyString(data.contentHash)
		&& typeof data.content === "string"
		&& typeof data.block === "string"
		// A capture is either full guidance or exactly the empty state; mixed
		// shapes are inert leftovers from discarded designs.
		&& (data.block === "" ? data.content === "" : data.content !== "");
}

/** The last capture on the branch wins; anything unparseable is inert history. */
export function latestBranchCapture(entries: readonly SessionEntry[]): RootDesignSnapshot | undefined {
	let latest: RootDesignSnapshot | undefined;
	for (const entry of entries) {
		const capture = parseRootDesignSnapshot(entry);
		if (capture) latest = capture;
	}
	return latest;
}

/**
 * Follow the persisted parent-session chain (fork lineage) read-only and
 * return the nearest durable capture, or undefined when the chain ends
 * without one. Reads only the parent JSONL files' capture and header entries;
 * parent sessions are never mutated and nothing else is projected.
 */
export async function inheritParentCapture(header: SessionHeader | undefined): Promise<RootDesignSnapshot | undefined> {
	let current = header?.parentSession;
	for (let depth = 0; current && depth < MAX_PARENT_CHAIN_DEPTH; depth++) {
		let entries;
		try {
			const raw = await readFile(current, "utf8");
			entries = parseSessionEntries(raw);
		} catch (error) {
			// An unreadable parent file ends the chain; callers freeze instead.
			return undefined;
		}
		const capture = latestBranchCapture(entries.filter((entry): entry is SessionEntry => entry.type !== "session"));

		if (capture) return capture;
		const parentHeader = entries.find((entry): entry is SessionHeader => entry.type === "session");
		current = parentHeader?.parentSession;
	}
	return undefined;
}

/** Bounds parent-chain reads; fork lineages are shallow by construction. */
const MAX_PARENT_CHAIN_DEPTH = 16;

function hashContent(content: string) {
	return createHash("sha256").update(content).digest("hex");
}

/** Build the immutable session capture for one readable root DESIGN.md. */
export function buildRootDesignCapture(filepath: string, content: string): RootDesignSnapshot {
	return {
		version: SNAPSHOT_VERSION,
		path: filepath,
		contentHash: hashContent(content),
		content,
		block: formatInstructions({ filepath, content }),
	};
}

/** Build the empty capture that freezes "no guidance" for this session. */
export function buildEmptyRootDesignCapture(filepath: string): RootDesignSnapshot {
	return {
		version: SNAPSHOT_VERSION,
		path: filepath,
		contentHash: hashContent(""),
		content: "",
		block: "",
	};
}

export type RootDesignFile =
	| { status: "present"; path: string; content: string }
	| { status: "missing" }
	| { status: "unknown" };

/**
 * Read the root DESIGN.md at capture time only — never again for the lifetime
 * of the session. Canonicalization happens here, not through the nested
 * containment helper, so filesystem failures stay classifiable: absent files
 * and root-escaping symlinks are "missing", while denied traversal or
 * unreadable files are classified as "unknown" so capture can freeze the empty
 * state and warn instead of silently adding guidance after a later retry.
 */
export async function readRootDesignFile(root: string): Promise<RootDesignFile> {
	const canonicalRoot = await realpath(root).catch(() => null);
	if (canonicalRoot === null) return { status: "unknown" };
	const designPath = path.join(canonicalRoot, "DESIGN.md");
	const canonicalDesign = await realpath(designPath).catch((error: NodeJS.ErrnoException) => error);
	if (canonicalDesign instanceof Error) {
		return canonicalDesign.code === "ENOENT" ? { status: "missing" } : { status: "unknown" };
	}
	// A symlink escaping the canonical session root cannot back guidance.
	if (!isWithinRoot(canonicalDesign, canonicalRoot)) return { status: "missing" };
	try {
		const content = await readFile(canonicalDesign, "utf8");
		return content ? { status: "present", path: designPath, content } : { status: "missing" };
	} catch (error) {
		return classifyUnreadableDesignFile(error);
	}
}

/** A vanished file is simply absent; any other read failure defers the capture. */
function classifyUnreadableDesignFile(error: unknown): RootDesignFile {
	// SAFETY: Node filesystem errors carry the errno code on ErrnoException;
	// reading it off an unknown error is a guarded probe, not a trusted cast.
	if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { status: "missing" };
	return { status: "unknown" };
}

export type CaptureDecision =
	| { action: "none" }
	| { action: "record"; capture: RootDesignSnapshot; /** Shown once when guidance was unavailable at capture time. */ warning?: string };

/**
 * Decide whether this request needs the one-time session capture. An existing
 * capture is final: file edits, deletions, and later feature or availability
 * changes never alter the captured session — repairing any of them requires a
 * new session. With no capture, a readable file (feature enabled) records its
 * value; a disabled feature, a confirmed-absent file, and an unreadable file
 * all freeze the empty state, so nothing can be silently added to a running
 * session's head later. An unreadable file additionally asks for a warning.
 */
export function decideRootDesignCapture(
	existing: RootDesignSnapshot | undefined,
	file: RootDesignFile,
	featureEnabled: boolean,
	designPath: string,
): CaptureDecision {
	if (existing) return { action: "none" };
	if (featureEnabled && file.status === "present") {
		return { action: "record", capture: buildRootDesignCapture(file.path, file.content) };
	}
	if (featureEnabled && file.status === "unknown") {
		return {
			action: "record",
			capture: buildEmptyRootDesignCapture(designPath),
			warning:
				"Root DESIGN.md could not be read; this session runs without design guidance. Repair the file and start a new session to pick it up.",
		};
	}
	return { action: "record", capture: buildEmptyRootDesignCapture(designPath) };
}

type RequestMessages = SessionProjection["messages"];

/**
 * Re-assert the captured block in flat payload system text when a forced
 * prompt (a before_agent_start return, applied after context_with_system)
 * replaced the request head and dropped the injected section. Gated on the
 * text carrying pi's rendered `<cwd>` section, which proves the forced prompt
 * was built from pi's own prompt (the common forcing shape); foreign forced
 * prompts that never included pi's prompt are left untouched. Exactly-once by
 * presence check, and the appended text is the same captured block the
 * structured injection uses, so the two delivery paths cannot diverge.
 */
export function reassertRootDesignSection(text: string, block: string): string | undefined {
	if (block === "") return undefined;
	if (!text.includes("<cwd>")) return undefined;
	if (text.includes(block)) return undefined;
	return `${text}\n\n${block}`;
}

/**
 * Add the captured value once to the LEADING system message of a request
 * clone, the same seam the platform's skill guidance uses. Returns undefined
 * (callers ship the original messages) when nothing changed, the head is
 * missing, or the block is already present — so repeated handler runs and
 * chained registrations stay exactly-once.
 *
 * - structured head (`sections`, pi's normal shape): inject as the named
 *   section, so the block participates in pi's prompt-update semantics. A
 *   foreign value under the owned name is overwritten.
 * - flat whole-prompt head (plain string content, e.g. after a foreign forced
 *   prompt projection): append after a presence check.
 * - a head with neither shapes fails open: no injection is better than a
 *   mangled prompt.
 *
 * Early custom messages can sit before the declaration in the transcript;
 * only the original declaration is relocated to index zero so the request
 * keeps a valid leading prompt, and later system updates are never folded in.
 */
export function injectRootDesignSection(messages: RequestMessages, block: string): RequestMessages | undefined {
	if (block === "") return undefined;
	let result = messages;
	let relocated = false;
	if (result[0]?.role !== "system") {
		const headIndex = result.findIndex((message) => message.role === "system");
		if (headIndex < 0) return undefined;
		result = result.slice();
		const [declaration] = result.splice(headIndex, 1);
		if (!declaration) return undefined;
		result.unshift(declaration);
		relocated = true;
	}
	const head = result[0];
	if (!head || head.role !== "system") return undefined;

	if (head.sections) {
		if (head.sections[ROOT_DESIGN_SECTION] === block) return relocated ? result : undefined;
		result = result.slice();
		result[0] = { ...head, sections: { ...head.sections, [ROOT_DESIGN_SECTION]: block } };
		return result;
	}

	if (typeof head.content === "string") {
		if (head.content.includes(block)) return relocated ? result : undefined;
		const content = head.content ? `${head.content}\n\n${block}` : block;
		result = result.slice();
		result[0] = { ...head, content };
		return result;
	}

	return relocated ? result : undefined;
}
