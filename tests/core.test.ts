import path from "node:path";
import { describe, expect, test } from "bun:test";
import { collectRecursiveAgents, hasNoContextFilesFlag, prependAgentsContent } from "../src/core";

describe("hasNoContextFilesFlag", () => {
	test("detects long and short flags", () => {
		expect(hasNoContextFilesFlag(["pi", "--no-context-files"])).toBe(true);
		expect(hasNoContextFilesFlag(["pi", "-nc"])).toBe(true);
		expect(hasNoContextFilesFlag(["pi"])).toBe(false);
	});
});

describe("collectRecursiveAgents", () => {
	test("collects nested AGENTS from deepest to highest and skips cwd root", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/deeper/AGENTS.md"), "deep rules\n"],
			[path.resolve("/repo/nested/AGENTS.md"), "nested rules\n"],
			[path.resolve("/repo/AGENTS.md"), "root rules\n"],
		]);

		const results = await collectRecursiveAgents("nested/deeper/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			{ filepath: path.resolve("/repo/nested/deeper/AGENTS.md"), content: "deep rules\n" },
			{ filepath: path.resolve("/repo/nested/AGENTS.md"), content: "nested rules\n" },
		]);
	});

		test("skips the target AGENTS file itself", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/AGENTS.md"), "nested rules\n"],
			[path.resolve("/repo/nested/deeper/AGENTS.md"), "deep rules\n"],
		]);

		const results = await collectRecursiveAgents("nested/deeper/AGENTS.md", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([{ filepath: path.resolve("/repo/nested/AGENTS.md"), content: "nested rules\n" }]);
	});

	test("ignores targets outside cwd", async () => {
		const results = await collectRecursiveAgents("/outside/project/file.ts", "/repo", async () => "should not load");
		expect(results).toEqual([]);
	});
});

describe("prependAgentsContent", () => {
	test("prepends instructions before the original content and dedupes loaded paths", () => {
		const loadedPaths = new Set<string>([path.resolve("/repo/nested/AGENTS.md")]);
		const content = [{ type: "text" as const, text: "target file\n" }];
		const result = prependAgentsContent(
			content,
			[
				{ filepath: "/repo/nested/deeper/AGENTS.md", content: "deep rules\n" },
				{ filepath: "/repo/nested/AGENTS.md", content: "nested rules\n" },
			],
			loadedPaths,
		);

		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: `Instructions from: ${path.resolve("/repo/nested/deeper/AGENTS.md")}\ndeep rules\n`,
				},
				{ type: "text", text: "target file\n" },
			],
			changed: true,
		});
		
		expect(loadedPaths).toEqual(
			new Set([path.resolve("/repo/nested/AGENTS.md"), path.resolve("/repo/nested/deeper/AGENTS.md")]),
		);
	});

	test("returns unchanged content when everything was already loaded", () => {
		const content = [{ type: "text" as const, text: "target file\n" }];
		const loadedPaths = new Set<string>([
			path.resolve("/repo/nested/AGENTS.md"),
			path.resolve("/repo/nested/deeper/AGENTS.md"),
		]);
		const result = prependAgentsContent(
			content,
			[
				{ filepath: "/repo/nested/deeper/AGENTS.md", content: "deep rules\n" },
				{ filepath: "/repo/nested/AGENTS.md", content: "nested rules\n" },
			],
			loadedPaths,
		);

		expect(result).toEqual({ content, changed: false });
	});
});
