import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractPathCandidates } from "./extract.js";
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
			truncated: file.truncated === true,
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
	return basePrompt + `\n\n## ${designPath}\n\n${content}\n\n`;
}

function appendManifestPrompt(basePrompt: string, manifestDirs: string[]) {
	if (!isAncestorAgentsMdEnabled()) return undefined;
	if (!isNestedAgentsManifestEnabled()) return undefined;
	if (manifestDirs.length === 0) return undefined;

	const listing = manifestDirs.map((dir) => `- ${dir.split(path.sep).join("/")}/AGENTS.md`).join("\n");
	return (
		basePrompt +
		`\n\n## Nested AGENTS.md files\n\nAdditional AGENTS.md instructions exist in these directories under this project:\n${listing}\n\nBefore reading or editing files under any of these paths, read the applicable AGENTS.md first.\n`
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

async function sweepToolCall(state: SessionState, call: ToolCallInput, root: string) {
	if (!isNewSweepCall(call, state)) return;
	const targets = await resolveContainedTargets(call.input, root);
	for (const target of targets) {
		const { designFiles, agentsFiles } = await collectFilesForTarget(target);
		const pendingDesign = takePending(designFiles, state.loadedDesignPaths);
		const pendingAgents = takePending(agentsFiles, state.loadedAgentsPaths);
		appendPendingSweepFiles(state, pendingAgents, "AGENTS.md");
		appendPendingSweepFiles(state, pendingDesign, "DESIGN.md");
	}
}

async function sweepToolCalls(messages: readonly unknown[], state: SessionState, root: string) {
	for (const call of collectToolCallInputs(messages)) await sweepToolCall(state, call, root);
}

function createSweepContext(messages: AgentMessage[], files: AgentsFile[]) {
	const text = files.map((file) => `Instructions from: ${file.filepath}\n${file.content}`).join("\n\n");
	const message: AgentMessage = {
		role: "custom",
		customType: SWEEP_CUSTOM_TYPE,
		content: text,
		display: false,
		timestamp: Date.now(),
	};
	return { messages: [...messages, message] };
}

function blockContainsHeader(block: unknown, header: string) {
	if (!isObjectInput(block)) return false;
	const text = (block as { text?: unknown }).text;
	return typeof text === "string" && text.includes(header);
}

function messageContainsHeader(message: unknown, header: string) {
	if (!isObjectInput(message)) return false;
	const content = (message as MessageLike).content;
	if (!Array.isArray(content)) return false;
	for (const block of content) {
		if (blockContainsHeader(block, header)) return true;
	}
	return false;
}

function transcriptContainsHeader(messages: readonly unknown[], header: string) {
	const start = Math.max(0, messages.length - SWEEP_SCAN_MESSAGES);
	for (let i = start; i < messages.length; i++) {
		if (messageContainsHeader(messages[i], header)) return true;
	}
	return false;
}

/**
 * Delivery confirmation: a tool-result injection counts as delivered only once
 * its header is observed in the final transcript. A downstream extension that
 * replaced the result removes the header; the file is then re-delivered through
 * the self-healing sweep message instead.
 */
function reconcileUnconfirmedFiles(state: SessionState, messages: readonly unknown[]) {
	if (state.unconfirmedFiles.size === 0) return;
	for (const [filepath, file] of [...state.unconfirmedFiles]) {
		state.unconfirmedFiles.delete(filepath);
		if (!transcriptContainsHeader(messages, `Instructions from: ${filepath}`)) {
			state.sweptFiles.push(file);
		}
	}
}

function isSweepMessage(message: unknown) {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "custom" &&
		(message as { customType?: unknown }).customType === SWEEP_CUSTOM_TYPE
	);
}

/** The sweep message is rebuilt every request; a fed-back or persisted copy is replaced, never appended after. */
function filterSweepMessages(messages: readonly AgentMessage[]) {
	return messages.filter((message) => !isSweepMessage(message));
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
		clearSession(getSessionKey(ctx));
		const state = getSessionState(getSessionKey(ctx));
		state.root = ctx.cwd;
		state.disabled = pi.getFlag?.(FLAG_NO_CONTEXT_FILES) === true;
		state.manifestDirs = await computeManifestDirs(state.root);
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

	// Transcript sweep: on every LLM request, extract paths from recent tool
	// calls in the transcript and deliver any still-pending ancestor files as an
	// appended context message. Covers tool activity the tool_result handler
	// never saw (restored sessions, foreign tool surfaces, dropped injections).
	// The transform is per-request and ephemeral, so accumulated files are
	// re-appended on each request to stay visible for the rest of the session.
	pi.on("context", async (event, ctx) => {
		const state = getSessionState(getSessionKey(ctx));
		if (state.disabled) return;
		await sweepToolCalls(event.messages, state, state.root);
		reconcileUnconfirmedFiles(state, event.messages);

		if (state.sweptFiles.length === 0) return;
		return createSweepContext(filterSweepMessages(event.messages), state.sweptFiles);
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
