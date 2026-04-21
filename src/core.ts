import path from "node:path";
import type { ImageContent, TextContent } from "@mariozechner/pi-ai";

export type AgentsFile = {
	filepath: string;
	content: string;
};

export function hasNoContextFilesFlag(argv = process.argv) {
	return argv.includes("--no-context-files") || argv.includes("-nc");
}

export function isWithinRoot(dir: string, root: string) {
	const relative = path.relative(root, dir);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function collectRecursiveAgents(
	filepath: string,
	cwd: string,
	readText: (filepath: string) => Promise<string>,
): Promise<AgentsFile[]> {
	const root = path.resolve(cwd);
	const target = path.resolve(cwd, filepath);
	let current = path.dirname(target);
	const results: AgentsFile[] = [];

	while (current !== root && isWithinRoot(current, root)) {
		const agentsPath = path.resolve(path.join(current, "AGENTS.md"));
		if (agentsPath !== target) {
			const content = await readText(agentsPath);
			if (content) {
				results.push({ filepath: agentsPath, content });
			}
		}

		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}

	return results;
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
