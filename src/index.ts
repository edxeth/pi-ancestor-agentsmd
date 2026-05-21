import { readFile } from "node:fs/promises";
import path from "node:path";
import { isReadToolResult, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	collectRecursiveAgents,
	collectRecursiveDesign,
	hasNoContextFilesFlag,
	isAncestorAgentsMdEnabled,
	isAncestorDesignMdEnabled,
	isRootDesignMdEnabled,
	prependAgentsContent,
	resolveContainedPath,
	type AgentsFile,
} from "./core.js";

const COMMAND_CONTEXT_FILES = "nested-context-files";
const FLAG_NO_CONTEXT_FILES = "no-context-files";
const ENTRY_CONTEXT_FILES_DEBUG = "ancestor-agentsmd:context-files";
const SINGLETON_SESSION_KEY = "__pi_ancestor_agentsmd_singleton__";

type SessionState = {
	loadedAgentsPaths: Set<string>;
	loadedDesignPaths: Set<string>;
	injectedFiles: Map<string, { filepath: string; type: "AGENTS.md" | "DESIGN.md"; truncated: boolean }>;
	rootDesignInjected: boolean;
};

const sessions = new Map<string, SessionState>();
let sessionRoot = process.cwd();
let disabled = hasNoContextFilesFlag();

async function readFileContent(filepath: string) {
	try {
		return await readFile(filepath, "utf8");
	} catch {
		return "";
	}
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
			rootDesignInjected: false,
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
) {
	for (const file of files) {
		const resolved = path.resolve(file.filepath);
		if (loadedBefore.has(resolved)) continue;
		state.injectedFiles.set(resolved, {
			filepath: resolved,
			type,
			truncated: file.truncated === true,
		});
	}
}

function appendDebugEntry(pi: ExtensionAPI, sessionKey: string, state: SessionState) {
	pi.appendEntry?.(ENTRY_CONTEXT_FILES_DEBUG, {
		sessionKey,
		count: state.injectedFiles.size,
		files: [...state.injectedFiles.values()],
	});
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

	pi.on("session_start", (_event, ctx) => {
		sessionRoot = ctx.cwd;
		disabled = pi.getFlag?.(FLAG_NO_CONTEXT_FILES) === true;
		clearSession(getSessionKey(ctx));
	});

	// Root DESIGN.md injection: before first LLM call, append to system prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		if (disabled || !isRootDesignMdEnabled()) return;
		const sessionKey = getSessionKey(ctx);
		const state = getSessionState(sessionKey);
		if (state.rootDesignInjected) return;

		const contained = await resolveContainedPath("DESIGN.md", sessionRoot);
		if (!contained) return;

		const designPath = path.join(contained.root, "DESIGN.md");
		const content = await readFileContent(designPath);
		if (!content) return;

		state.rootDesignInjected = true;
		return {
			systemPrompt: event.systemPrompt + `\n\n## ${designPath}\n\n${content}\n\n`,
		};
	});

	// Ancestor file injection into read results.
	pi.on("tool_result", async (event, ctx) => {
		if (disabled || !isReadToolResult(event) || event.isError) return;

		const inputPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!inputPath) return;

		const contained = await resolveContainedPath(inputPath, sessionRoot);
		if (!contained) return;

		const sessionKey = getSessionKey(ctx);
		const state = getSessionState(sessionKey);

		// DESIGN.md runs first, then AGENTS.md prepends on top of it.
		// Result order: AGENTS.md additions → DESIGN.md additions → original file content.
		if (isAncestorDesignMdEnabled()) {
			const designFiles = await collectRecursiveDesign(contained.target, contained.root, readFileContent);
			if (designFiles.length > 0) {
				const loadedBefore = new Set(state.loadedDesignPaths);
				const result = prependAgentsContent(event.content, designFiles, state.loadedDesignPaths);
				if (result.changed) {
					rememberInjectedFiles(state, designFiles, "DESIGN.md", loadedBefore);
					event.content = result.content;
				}
			}
		}

		if (isAncestorAgentsMdEnabled()) {
			const agentsFiles = await collectRecursiveAgents(contained.target, contained.root, readFileContent);
			if (agentsFiles.length > 0) {
				const loadedBefore = new Set(state.loadedAgentsPaths);
				const result = prependAgentsContent(event.content, agentsFiles, state.loadedAgentsPaths);
				if (result.changed) {
					rememberInjectedFiles(state, agentsFiles, "AGENTS.md", loadedBefore);
					event.content = result.content;
				}
			}
		}

		return { content: event.content };
	});

	pi.on("session_compact", (_event, ctx) => {
		clearSession(getSessionKey(ctx));
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearSession(getSessionKey(ctx));
	});
}