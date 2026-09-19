import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPathCandidates } from "./extract.js";
import { formatInstructions, instructionHeader } from "./instructions.js";
import {
	collectNestedAgentsDirs,
	collectRecursiveAgents,
	collectRecursiveDesign,
	hasNoContextFilesFlag,
	isAncestorAgentsMdEnabled,
	isAncestorDesignMdEnabled,
	isNestedAgentsManifestEnabled,
	isRootDesignMdEnabled,
	prependAgentsContent,
	resolveContainedPath,
	type AgentsFile,
} from "./core.js";

const COMMAND_CONTEXT_FILES = "nested-context-files";
const FLAG_NO_CONTEXT_FILES = "no-context-files";
const ENTRY_CONTEXT_FILES_DEBUG = "ancestor-agentsmd:context-files";
const ENTRY_CONTEXT_FILE_EVENT = "ancestor-agentsmd:context-file-event";
const SINGLETON_SESSION_KEY = "__pi_ancestor_agentsmd_singleton__";
const SWEEP_CUSTOM_TYPE = "ancestor-agentsmd";
const SWEEP_SCAN_MESSAGES = 40;
const SNAPSHOT_CACHE_MAX = 64;

type InjectedFileRecord = {
	filepath: string;
	type: "AGENTS.md" | "DESIGN.md";
	truncated: boolean;
	mode: "tool-result" | "context-sweep" | "system-prompt";
	injectionCount: number;
	lastTurn?: number;
};

type SessionState = {
	loadedAgentsPaths: Set<string>;
	loadedDesignPaths: Set<string>;
	injectedFiles: Map<string, InjectedFileRecord>;
	agentStartCount: number;
	sweptFiles: AgentsFile[];
	sweptToolCallIds: Set<string>;
	toolCallSnapshots: Map<string, { designFiles: AgentsFile[]; agentsFiles: AgentsFile[] }>;
	unconfirmedFiles: Map<string, AgentsFile>;
	root: string;
	disabled: boolean;
	manifestDirs: string[];
};

const sessions = new Map<string, SessionState>();
async function computeManifestDirs(root: string) {
	return isAncestorAgentsMdEnabled() && isNestedAgentsManifestEnabled()
		? await collectNestedAgentsDirs(root)
		: [];
}

async function readFileContent(filepath: string) {
	try {
		return await readFile(filepath, "utf8");
	} catch {
		return "";
	}
}

/**
 * Resolve tool-input path candidates to contained targets. Directory candidates
 * get a trailing separator so ancestor walks start at the directory itself
 * rather than its parent.
 */
async function resolveContainedTargets(input: unknown, root: string) {
	const targets: Array<{ root: string; target: string }> = [];
	for (const candidate of extractPathCandidates(input, root)) {
		const contained = await resolveContainedPath(candidate, root);
		if (!contained) continue;
		const stats = await stat(contained.target).catch(() => null);
		targets.push(stats?.isDirectory() ? { root: contained.root, target: contained.target + path.sep } : contained);
	}
	return targets;
}

function getSessionKey(ctx: { sessionManager?: { getSessionFile?: () => string | null | undefined } }) {
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	return typeof sessionFile === "string" && sessionFile.length > 0 ? sessionFile : SINGLETON_SESSION_KEY;
}

function getSessionState(sessionKey: string) {
	let state = sessions.get(sessionKey);
	if (!state) {
		state = {
			loadedAgentsPaths: new Set<string>(),
			loadedDesignPaths: new Set<string>(),
			injectedFiles: new Map(),
			agentStartCount: 0,
			sweptFiles: [],
			sweptToolCallIds: new Set(),
			toolCallSnapshots: new Map(),
			unconfirmedFiles: new Map(),
			root: process.cwd(),
			disabled: hasNoContextFilesFlag(),
			manifestDirs: [],
		};
		sessions.set(sessionKey, state);
	}
	return state;
}

function clearSession(sessionKey: string) {
	sessions.delete(sessionKey);
}

function rememberInjectedFiles(
	state: SessionState,
	files: AgentsFile[],
	type: "AGENTS.md" | "DESIGN.md",
	loadedBefore: Set<string>,
	mode: InjectedFileRecord["mode"],
) {
	for (const file of files) {
		const resolved = path.resolve(file.filepath);
		if (loadedBefore.has(resolved)) continue;
		state.injectedFiles.set(resolved, {
			filepath: resolved,
			type,
			truncated: false,
			mode,
			injectionCount: 1,
		});
	}
}

/** Filter a collected file list down to files the model has not seen yet, marking them loaded. */
function takePending(files: AgentsFile[], loadedPaths: Set<string>) {
	const pending: AgentsFile[] = [];
	for (const file of files) {
		const resolved = path.resolve(file.filepath);
		if (loadedPaths.has(resolved)) continue;
		loadedPaths.add(resolved);
		pending.push(file);
	}
	return pending;
}

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

type ToolCallInput = { id: string | undefined; input: unknown };

function isAssistantMessage(message: unknown): message is MessageLike {
	return typeof message === "object" && message !== null && (message as MessageLike).role === "assistant";
}

function parseToolCallBlock(block: unknown): ToolCallInput | undefined {
	if (typeof block !== "object" || block === null) return undefined;
	const typed = block as { type?: unknown; id?: unknown; arguments?: unknown };
	if (typed.type !== "toolCall") return undefined;
	return {
		id: typeof typed.id === "string" ? typed.id : undefined,
		input: typed.arguments,
	};
}

function collectToolCallBlockInputs(content: unknown): ToolCallInput[] {
	if (!Array.isArray(content)) return [];
	const inputs: ToolCallInput[] = [];
	for (const block of content) {
		const input = parseToolCallBlock(block);
		if (input) inputs.push(input);
	}
	return inputs;
}

/** Collect tool call arguments from recent assistant messages (transcript sweep input). */
function collectToolCallInputs(messages: readonly unknown[]) {
	const inputs: ToolCallInput[] = [];
	const start = Math.max(0, messages.length - SWEEP_SCAN_MESSAGES);
	for (let i = start; i < messages.length; i++) {
		const message = messages[i];
		if (!isAssistantMessage(message)) continue;
		inputs.push(...collectToolCallBlockInputs(message.content));
	}
	return inputs;
}

function rememberRootDesignInjection(state: SessionState, filepath: string) {
	const resolved = path.resolve(filepath);
	const current = state.injectedFiles.get(resolved);
	state.injectedFiles.set(resolved, {
		filepath: resolved,
		type: "DESIGN.md",
		truncated: false,
		mode: "system-prompt",
		injectionCount: (current?.injectionCount ?? 0) + 1,
		lastTurn: state.agentStartCount,
	});
}

function appendDebugEntry(pi: ExtensionAPI, sessionKey: string, state: SessionState) {
	pi.appendEntry?.(ENTRY_CONTEXT_FILES_DEBUG, {
		sessionKey,
		count: state.injectedFiles.size,
		files: [...state.injectedFiles.values()],
	});
}

function appendRootDesignInjectionEvent(pi: ExtensionAPI, sessionKey: string, state: SessionState, filepath: string) {
	pi.appendEntry?.(ENTRY_CONTEXT_FILE_EVENT, {
		sessionKey,
		type: "root-design-md",
		path: path.resolve(filepath),
		mode: "system-prompt",
		turn: state.agentStartCount,
	});
}

async function collectRootDesignPrompt(
	pi: ExtensionAPI,
	sessionKey: string,
	state: SessionState,
	basePrompt: string,
) {
	if (!isRootDesignMdEnabled()) return undefined;
	const contained = await resolveContainedPath("DESIGN.md", state.root);
	if (!contained) return undefined;

	const designPath = path.join(contained.root, "DESIGN.md");
	const content = await readFileContent(designPath);
	if (!content) return undefined;

	rememberRootDesignInjection(state, designPath);
	appendRootDesignInjectionEvent(pi, sessionKey, state, designPath);
	// Same paired block as tool-result delivery, so the system-prompt append is
	// delimited and XML-escaped like every other injected file.
	return basePrompt + `\n\n${formatInstructions({ filepath: designPath, content })}\n\n`;
}

function appendManifestPrompt(basePrompt: string, manifestDirs: string[]) {
	if (!isAncestorAgentsMdEnabled()) return undefined;
	if (!isNestedAgentsManifestEnabled()) return undefined;
	if (manifestDirs.length === 0) return undefined;

	const listing = manifestDirs.map((dir) => `- ${dir.split(path.sep).join("/")}/AGENTS.md`).join("\n");
	return (
		basePrompt +
		`\n\n## Nested AGENTS.md files\n\nAdditional AGENTS.md instructions exist in these directories under this project:\n${listing}\n\nBefore working under any of these paths, ensure the applicable AGENTS.md instructions are loaded. Complete injected contents satisfy this requirement; do not reread them solely to load instructions.\n`
	);
}

type CollectedToolFiles = {
	designFiles: AgentsFile[];
	agentsFiles: AgentsFile[];
};

function isObjectInput(input: unknown): input is object {
	return input !== null && typeof input === "object";
}

function isUsableToolInput(disabledForSession: boolean, isError: boolean, input: unknown): input is object {
	if (disabledForSession) return false;
	if (isError) return false;
	return isObjectInput(input);
}

async function collectFilesForTarget(target: { root: string; target: string }): Promise<CollectedToolFiles> {
	return {
		designFiles: isAncestorDesignMdEnabled()
			? await collectRecursiveDesign(target.target, target.root, readFileContent)
			: [],
		agentsFiles: isAncestorAgentsMdEnabled()
			? await collectRecursiveAgents(target.target, target.root, readFileContent)
			: [],
	};
}

async function collectFilesForTargets(targets: Array<{ root: string; target: string }>): Promise<CollectedToolFiles> {
	const collected: CollectedToolFiles = { designFiles: [], agentsFiles: [] };
	for (const target of targets) {
		const files = await collectFilesForTarget(target);
		collected.designFiles.push(...files.designFiles);
		collected.agentsFiles.push(...files.agentsFiles);
	}
	return collected;
}

function hasCollectedToolFiles(files: CollectedToolFiles) {
	return files.designFiles.length > 0 || files.agentsFiles.length > 0;
}

function rememberToolCallSnapshot(state: SessionState, toolCallId: string, files: CollectedToolFiles) {
	if (state.toolCallSnapshots.size >= SNAPSHOT_CACHE_MAX) {
		const oldest = state.toolCallSnapshots.keys().next().value;
		if (oldest !== undefined) state.toolCallSnapshots.delete(oldest);
	}
	state.toolCallSnapshots.set(toolCallId, files);
}

async function snapshotToolCall(event: { input: unknown; toolCallId?: unknown }, state: SessionState) {
	if (state.disabled) return;
	if (!isObjectInput(event.input)) return;
	if (typeof event.toolCallId !== "string") return;

	const targets = await resolveContainedTargets(event.input, state.root);
	if (targets.length === 0) return;

	const collected = await collectFilesForTargets(targets);
	if (!hasCollectedToolFiles(collected)) return;
	rememberToolCallSnapshot(state, event.toolCallId, collected);
}

function prependCollectedFiles(
	content: Parameters<typeof prependAgentsContent>[0],
	files: AgentsFile[],
	loadedPaths: Set<string>,
	state: SessionState,
	type: "AGENTS.md" | "DESIGN.md",
) {
	if (files.length === 0) return { content, changed: false };
	const loadedBefore = new Set(loadedPaths);
	const result = prependAgentsContent(content, files, loadedPaths);
	if (!result.changed) return result;
	for (const file of files) {
		const resolved = path.resolve(file.filepath);
		if (!loadedBefore.has(resolved)) state.unconfirmedFiles.set(resolved, file);
	}
	rememberInjectedFiles(state, files, type, loadedBefore, "tool-result");
	return result;
}

function isNewSweepCall(call: ToolCallInput, state: SessionState): call is ToolCallInput & { input: object } {
	if (call.id !== undefined && state.sweptToolCallIds.has(call.id)) return false;
	if (call.id !== undefined) state.sweptToolCallIds.add(call.id);
	return isObjectInput(call.input);
}

function appendPendingSweepFiles(state: SessionState, files: AgentsFile[], type: "AGENTS.md" | "DESIGN.md") {
	if (files.length === 0) return;
	state.sweptFiles.push(...files);
	rememberInjectedFiles(state, files, type, new Set(), "context-sweep");
}

/** Extract the readable text of one message for delivered-header detection. */
function messageText(message: unknown): string {
	if (typeof message !== "object" || message === null) return "";
	const content = (message as MessageLike).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) =>
			typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string"
				? (block as { text: string }).text
				: "",
		)
		.join("\n");
}

/**
 * Restored-transcript text: tool-result injections and persisted fallback
 * batches both carry instruction headers, so one text scan covers every
 * earlier delivery channel.
 */
function transcriptText(messages: readonly unknown[]) {
	return messages.map(messageText).join("\n");
}

/** Deliver pending sweep files as one persistent, append-only session message. */
async function flushSweptFiles(pi: ExtensionAPI, state: SessionState) {
	if (state.sweptFiles.length === 0) return;
	// Without a usable sendMessage the files must stay pending, because the
	// callers below have already marked them loaded; dropping them here would
	// silently lose delivery for the rest of the process.
	if (typeof pi.sendMessage !== "function") return;
	const files = state.sweptFiles.splice(0);
	await pi.sendMessage(
		{
			customType: SWEEP_CUSTOM_TYPE,
			content: files.map(formatInstructions).join("\n\n"),
			display: false,
		},
		{ triggerTurn: false, deliverAs: "steer" },
	);
}

type RestoredEntry = { message?: unknown; type?: unknown; customType?: unknown; content?: unknown };

/**
 * Map one session entry to its in-context message. Message entries wrap a
 * message; custom message entries carry their fields directly on the entry.
 */
function restoredEntryMessage(entry: unknown): unknown {
	if (typeof entry !== "object" || entry === null) return undefined;
	const typed = entry as RestoredEntry;
	if (typed.message !== undefined) return typed.message;
	if (typed.type === "custom_message" && typed.customType !== undefined && typed.content !== undefined) {
		return { role: "custom", customType: typed.customType, content: typed.content };
	}
	return undefined;
}


async function readRestoredMessages(
	ctx: {
		sessionManager?: {
			getSessionFile?: () => string | null | undefined;
			buildContextEntries?: () => unknown[];
		};
	},
): Promise<readonly unknown[]> {
	// buildContextEntries is the compaction-aware view of the active session;
	// getBranch is deliberately not used because it includes entries dropped by
	// compaction, which could mark an instruction as delivered when the model
	// can no longer see it.
	const entries = ctx.sessionManager?.buildContextEntries?.();
	if (Array.isArray(entries)) {
		return entries.map(restoredEntryMessage).filter((message) => message !== undefined);
	}
	// Best-effort fallback for hosts without context entries: read the CURRENT
	// session file. The session_start event's previousSessionFile names the
	// session being left, which on an in-process switch is the wrong transcript.
	const sessionFile = ctx.sessionManager?.getSessionFile?.();
	if (typeof sessionFile !== "string" || sessionFile.length === 0) return [];
	let raw: string;
	try {
		raw = await readFile(sessionFile, "utf8");
	} catch {
		return [];
	}
	const messages: unknown[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const message = restoredEntryMessage(JSON.parse(trimmed));
			if (message !== undefined) messages.push(message);
		} catch {
			// Skip malformed lines; delivery falls back to later tool activity.
		}
	}
	return messages;
}

/**
 * Collect still-pending ancestor files named by transcript tool calls. Files
 * whose instruction header already appears in the transcript — through a
 * tool-result injection or a persisted fallback batch — count as delivered, so
 * repeated scans, fed-back batches, and restored sessions never re-deliver.
 */
async function collectTranscriptSweepFiles(messages: readonly unknown[], state: SessionState, root: string) {
	const agentsCandidates: AgentsFile[] = [];
	const designCandidates: AgentsFile[] = [];
	for (const call of collectToolCallInputs(messages)) {
		if (!isNewSweepCall(call, state)) continue;
		for (const target of await resolveContainedTargets(call.input, root)) {
			const { designFiles, agentsFiles } = await collectFilesForTarget(target);
			agentsCandidates.push(...agentsFiles);
			designCandidates.push(...designFiles);
		}
	}
	const pendingAgents = takePending(agentsCandidates, state.loadedAgentsPaths);
	const pendingDesign = takePending(designCandidates, state.loadedDesignPaths);
	if (pendingAgents.length === 0 && pendingDesign.length === 0) return;
	const text = transcriptText(messages);
	appendPendingSweepFiles(state, pendingAgents.filter((file) => !text.includes(instructionHeader(file.filepath))), "AGENTS.md");
	appendPendingSweepFiles(
		state,
		pendingDesign.filter((file) => !text.includes(instructionHeader(file.filepath))),
		"DESIGN.md",
	);
}

/**
 * Delivery confirmation: a tool-result injection counts as delivered only once
	* its header is observed anywhere in the transcript text, the same single
	* source of truth the sweep uses. A downstream extension that replaced the
	* result removes the header; the file is then re-delivered through one
	* persistent fallback batch instead.
 */
function reconcileUnconfirmedFiles(state: SessionState, messages: readonly unknown[]) {
	if (state.unconfirmedFiles.size === 0) return;
	const text = transcriptText(messages);
	for (const [filepath, file] of [...state.unconfirmedFiles]) {
		state.unconfirmedFiles.delete(filepath);
		if (!text.includes(instructionHeader(filepath))) {
			state.sweptFiles.push(file);
		}
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag?.(FLAG_NO_CONTEXT_FILES, {
		description: "Disable AGENTS.md and DESIGN.md context-file injection.",
		type: "boolean",
		default: false,
	});

	pi.registerCommand?.(COMMAND_CONTEXT_FILES, {
		description: "Print injected AGENTS.md/DESIGN.md context-file state to the session log.",
		handler: async (_args, ctx) => {
			const sessionKey = getSessionKey(ctx);
			const state = getSessionState(sessionKey);
			appendDebugEntry(pi, sessionKey, state);
			ctx.ui?.notify?.(`Nested context files recorded: ${state.injectedFiles.size}`, "info");
		},
	});

	if (hasNoContextFilesFlag()) return;

	pi.on("session_start", async (_event, ctx) => {
		const event = _event as { reason?: unknown; previousSessionFile?: string | undefined };
		clearSession(getSessionKey(ctx));
		const state = getSessionState(getSessionKey(ctx));
		state.root = ctx.cwd;
		state.disabled = pi.getFlag?.(FLAG_NO_CONTEXT_FILES) === true;
		state.manifestDirs = await computeManifestDirs(state.root);
		if (state.disabled) return;

		// Restored transcripts never passed through this process's
		// tool_result handler, so deliver anything still pending once as a
		// persistent message instead of a per-request context suffix. A new
		// process continuing a session emits "startup", not "resume"; a fresh
		// session yields no message entries, making the scan a no-op.
		const reason = event.reason;
		if (reason !== "startup" && reason !== "resume" && reason !== "fork" && reason !== "reload") return;
		const messages = await readRestoredMessages(ctx);
		if (messages.length === 0) return;
		await collectTranscriptSweepFiles(messages, state, state.root);
		await flushSweptFiles(pi, state);
	});

	// Pre-execution snapshot: collect applicable files while the named paths
	// still exist, so commands that delete or move their own targets still
	// deliver the rules that applied at execution time. Entries are consumed by
	// the matching tool_result and the cache is bounded.
	pi.on("tool_call", async (event, ctx) => {
		const state = getSessionState(getSessionKey(ctx));
		await snapshotToolCall(event, state);
	});

	// Root DESIGN.md injection: append to every agent-start system prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		const sessionKey = getSessionKey(ctx);
		const state = getSessionState(sessionKey);
		if (state.disabled) return;
		state.agentStartCount += 1;

		let systemPrompt = await collectRootDesignPrompt(pi, sessionKey, state, event.systemPrompt);

		// Nested AGENTS.md manifest: a tool-independent index of where nested
		// rules live, so agents discover them even when no tool input names them.
		const manifestPrompt = appendManifestPrompt(systemPrompt ?? event.systemPrompt, state.manifestDirs);
		if (manifestPrompt !== undefined) systemPrompt = manifestPrompt;

		return systemPrompt === undefined ? undefined : { systemPrompt };
	});

	// Ancestor file injection into tool results. The trigger is generic path
	// extraction over any tool's input, not tool identity, so tool replacements
	// (codex-style exec_command, MCP gateways, ...) keep nested rules flowing.
	pi.on("tool_result", async (event, ctx) => {
		const input = event.input;
		const sessionKey = getSessionKey(ctx);
		const state = getSessionState(sessionKey);
		if (!isUsableToolInput(state.disabled, event.isError, input)) return;

		const targets = await resolveContainedTargets(input, state.root);
		if (targets.length === 0) return;

		const { designFiles, agentsFiles } = await collectFilesForTargets(targets);
		const snapshot = state.toolCallSnapshots.get(event.toolCallId);
		state.toolCallSnapshots.delete(event.toolCallId);
		if (snapshot) {
			designFiles.unshift(...snapshot.designFiles);
			agentsFiles.unshift(...snapshot.agentsFiles);
		}

		// DESIGN.md runs first, then AGENTS.md prepends on top of it.
		// Result order: AGENTS.md additions → DESIGN.md additions → original file content.
		const withDesign = prependCollectedFiles(event.content, designFiles, state.loadedDesignPaths, state, "DESIGN.md");
		const withAgents = prependCollectedFiles(withDesign.content, agentsFiles, state.loadedAgentsPaths, state, "AGENTS.md");
		if (!withDesign.changed && !withAgents.changed) return;
		return { content: withAgents.content };
	});

	// Transcript sweep: discover tool activity the tool_result handler never
	// saw (error results, foreign tool surfaces) and deliver pending ancestor
	// files once as a persistent session message that lands before the next
	// LLM call. The hook itself never mutates request messages, so request
	// prefixes stay append-only and provider prompt caches remain valid.
	pi.on("context", async (event, ctx) => {
		const state = getSessionState(getSessionKey(ctx));
		if (state.disabled) return;
		await collectTranscriptSweepFiles(event.messages, state, state.root);
		reconcileUnconfirmedFiles(state, event.messages);
		await flushSweptFiles(pi, state);
	});

	pi.on("session_compact", async (_event, ctx) => {
		const state = getSessionState(getSessionKey(ctx));
		// Compaction clears delivered-file memory but keeps the session's root
		// and flag state; the manifest is refreshed in place.
		state.loadedAgentsPaths.clear();
		state.loadedDesignPaths.clear();
		state.injectedFiles.clear();
		state.sweptFiles.length = 0;
		state.sweptToolCallIds.clear();
		state.toolCallSnapshots.clear();
		state.unconfirmedFiles.clear();
		state.manifestDirs = await computeManifestDirs(state.root);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		// Shutdown clears delivered-file memory for the key but keeps root and
		// flag state: a replacement session_start reinitializes everything.
		const state = getSessionState(getSessionKey(ctx));
		state.loadedAgentsPaths.clear();
		state.loadedDesignPaths.clear();
		state.injectedFiles.clear();
		state.sweptFiles.length = 0;
		state.sweptToolCallIds.clear();
		state.toolCallSnapshots.clear();
		state.unconfirmedFiles.clear();
	});
}
