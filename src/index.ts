import { access, readFile } from "node:fs/promises";
import { isReadToolResult, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { collectRecursiveAgents, hasNoContextFilesFlag, prependAgentsContent } from "./core";

const loadedPaths = new Set<string>();
let sessionRoot = process.cwd();

async function readAgentsFile(filepath: string) {
	try {
		await access(filepath);
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
	});

	pi.on("tool_result", async (event) => {
		if (!isReadToolResult(event) || event.isError) return;

		const inputPath = typeof event.input.path === "string" ? event.input.path : "";
		if (!inputPath) return;

		const agentsFiles = await collectRecursiveAgents(inputPath, sessionRoot, readAgentsFile);
		if (agentsFiles.length === 0) return;

		const result = prependAgentsContent(event.content, agentsFiles, loadedPaths);
		if (!result.changed) return;

		return { content: result.content };
	});
}
