import path from "node:path";
import { describe, expect, test, beforeAll } from "bun:test";
import {
	collectRecursiveAgents,
	collectRecursiveDesign,
	hasNoContextFilesFlag,
	isRootDesignMdEnabled,
	isAncestorDesignMdEnabled,
	isAncestorAgentsMdEnabled,
	prependAgentsContent,
} from "../src/core";

describe("hasNoContextFilesFlag", () => {
	test("detects long and short flags", () => {
		expect(hasNoContextFilesFlag(["pi", "--no-context-files"])).toBe(true);
		expect(hasNoContextFilesFlag(["pi", "-nc"])).toBe(true);
		expect(hasNoContextFilesFlag(["pi"])).toBe(false);
	});
});

describe("env var guards", () => {
	beforeAll(() => {
		delete process.env.PI_ROOT_DESIGN_MD;
		delete process.env.PI_ANCESTOR_DESIGN_MD;
	});

	test("defaults to disabled", () => {
		expect(isRootDesignMdEnabled()).toBe(false);
		expect(isAncestorDesignMdEnabled()).toBe(false);
	});

	test("PI_ROOT_DESIGN_MD=1 enables root injection", () => {
		process.env.PI_ROOT_DESIGN_MD = "1";
		expect(isRootDesignMdEnabled()).toBe(true);
		delete process.env.PI_ROOT_DESIGN_MD;
	});

	test("PI_ANCESTOR_DESIGN_MD=1 enables ancestor injection", () => {
		process.env.PI_ANCESTOR_DESIGN_MD = "1";
		expect(isAncestorDesignMdEnabled()).toBe(true);
		delete process.env.PI_ANCESTOR_DESIGN_MD;
	});

	test("PI_ANCESTOR_AGENTS_MD defaults to enabled", () => {
		delete process.env.PI_ANCESTOR_AGENTS_MD;
		expect(isAncestorAgentsMdEnabled()).toBe(true);
	});

	test("PI_ANCESTOR_AGENTS_MD=0 disables ancestor agents", () => {
		process.env.PI_ANCESTOR_AGENTS_MD = "0";
		expect(isAncestorAgentsMdEnabled()).toBe(false);
		delete process.env.PI_ANCESTOR_AGENTS_MD;
	});

	test("PI_ANCESTOR_AGENTS_MD=1 keeps ancestor agents enabled", () => {
		process.env.PI_ANCESTOR_AGENTS_MD = "1";
		expect(isAncestorAgentsMdEnabled()).toBe(true);
		delete process.env.PI_ANCESTOR_AGENTS_MD;
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

describe("collectRecursiveDesign", () => {
	test("collects nested DESIGN.md from deepest to highest and skips cwd root", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/deeper/DESIGN.md"), "deep design\n"],
			[path.resolve("/repo/nested/DESIGN.md"), "nested design\n"],
			[path.resolve("/repo/DESIGN.md"), "root design\n"],
		]);

		const results = await collectRecursiveDesign("nested/deeper/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			{ filepath: path.resolve("/repo/nested/deeper/DESIGN.md"), content: "deep design\n" },
			{ filepath: path.resolve("/repo/nested/DESIGN.md"), content: "nested design\n" },
		]);
	});

	test("skips the target DESIGN.md file itself", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/DESIGN.md"), "nested design\n"],
			[path.resolve("/repo/nested/deeper/DESIGN.md"), "deep design\n"],
		]);

		const results = await collectRecursiveDesign("nested/deeper/DESIGN.md", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([{ filepath: path.resolve("/repo/nested/DESIGN.md"), content: "nested design\n" }]);
	});

	test("collects both DESIGN.md and AGENTS.md when root dirs have only one type each", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/sub/DESIGN.md"), "sub design\n"],
			[path.resolve("/repo/AGENTS.md"), "root agents\n"],
		]);

		const designResults = await collectRecursiveDesign("sub/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");
		expect(designResults).toEqual([{ filepath: path.resolve("/repo/sub/DESIGN.md"), content: "sub design\n" }]);

		const agentsResults = await collectRecursiveAgents("sub/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");
		expect(agentsResults).toEqual([]);
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
