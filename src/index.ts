import { readFile } from "node:fs/promises";
import path from "node:path";
import { isReadToolResult, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	collectRecursiveAgents,
	collectRecursiveDesign,
	hasNoContextFilesFlag,
	isAncestorAgentsMdEnabled,
	isAncestorDesignMdEnabled,
	isRootDesignMdEnabled,
	prependAgentsContent,
} from "./core";

const loadedPaths = new Set<string>();
const loadedDesignPaths = new Set<string>();
let sessionRoot = process.cwd();
let rootDesignInjected = false;

async function readFileContent(filepath: string) {
	try {
		return await readFile(filepath, "utf8");
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	if (hasNoContextFilesFlag()) return;

	pi.on("session_start", (_event, ctx) => {
		sessionRoot = ctx.cwd;
		loadedPaths.clear();
		loadedDesignPaths.clear();
		rootDesignInjected = false;
	});

	// Root DESIGN.md injection: before first LLM call, append to system prompt
	pi.on("before_agent_start", async (event) => {
		if (!isRootDesignMdEnabled() || rootDesignInjected) return;

		const designPath = path.join(sessionRoot, "DESIGN.md");
		const content = await readFileContent(designPath);
		if (!content) return;

		rootDesignInjected = true;
		return {
			systemPrompt: event.systemPrompt + `\n\n## ${designPath}\n\n${content}\n\n`,
		};
	});

	// Ancestor file injection into read results
	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event) || event.isError) return;

		const inputPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!inputPath) return;

		// DESIGN.md runs first, then AGENTS.md prepends on top of it.
		// Result order: AGENTS.md additions → DESIGN.md additions → original file content.

		// Ancestor DESIGN.md (opt-in via PI_ANCESTOR_DESIGN_MD=1)
		if (isAncestorDesignMdEnabled()) {
			const designFiles = await collectRecursiveDesign(inputPath, sessionRoot, readFileContent);
			if (designFiles.length > 0) {
				const result = prependAgentsContent(event.content, designFiles, loadedDesignPaths);
				if (result.changed) {
					event.content = result.content;
				}
			}
		}

		// AGENTS.md (opt-out via PI_ANCESTOR_AGENTS_MD=0, enabled by default)
		if (isAncestorAgentsMdEnabled()) {
			const agentsFiles = await collectRecursiveAgents(inputPath, sessionRoot, readFileContent);
			if (agentsFiles.length > 0) {
				const result = prependAgentsContent(event.content, agentsFiles, loadedPaths);
				if (result.changed) {
					event.content = result.content;
				}
			}
		}

		return { content: event.content };
	});
}
