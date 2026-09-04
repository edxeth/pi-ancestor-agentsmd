import path from "node:path";
import { describe, expect, test } from "bun:test";
import { extractPathCandidates } from "../src/extract.js";

describe("extractPathCandidates (structured keys)", () => {
	test("resolves a relative path key against the base dir", () => {
		expect(extractPathCandidates({ path: "src/components/Button.tsx" }, "/repo")).toEqual([
			path.resolve("/repo/src/components/Button.tsx"),
		]);
	});

	test("keeps absolute paths and dedupes repeated candidates", () => {
		expect(extractPathCandidates({ path: "/repo/a.ts", file_path: "/repo/a.ts" }, "/repo")).toEqual(["/repo/a.ts"]);
	});

	test("ignores non-string and empty values", () => {
		expect(extractPathCandidates({ path: 7, filePath: "", nested: { path: null } }, "/repo")).toEqual([]);
	});
});

describe("extractPathCandidates (command string tokens)", () => {
	test("extracts path-looking tokens from arbitrary string values", () => {
		expect(extractPathCandidates({ cmd: "cat src/components/Button.tsx" }, "/repo")).toEqual([
			path.resolve("/repo/src/components/Button.tsx"),
		]);
	});

	test("resolves tokens against a workdir base key in the same record", () => {
		expect(
			extractPathCandidates({ cmd: "sed -n 1,5p tests/helper.ts", workdir: "/repo/src" }, "/repo"),
		).toEqual([path.resolve("/repo/src"), path.resolve("/repo/src/tests/helper.ts")]);
	});

	test("skips flags, plain words, URLs, and line-range suffixes", () => {
		expect(
			extractPathCandidates(
				{ cmd: "rg -n --hidden foo tests/a.ts:10 https://example.com/x.md plain", workdir: "/repo" },
				"/repo",
			),
		).toEqual([path.resolve("/repo"), path.resolve("/repo/tests/a.ts")]);
	});

	test("ignores blank command tokens and blank base keys", () => {
		expect(extractPathCandidates({ command: "   ", workdir: "  " }, "/repo")).toEqual([]);
	});

	test("does not re-emit a relative workdir as its own child path", () => {
		expect(extractPathCandidates({ workdir: "src", cmd: "cat helper.ts" }, "/repo")).toEqual([
			path.resolve("/repo/src"),
			path.resolve("/repo/src/helper.ts"),
		]);
	});

	test("walks nested records with their base and stops at the depth limit", () => {
		expect(
			extractPathCandidates(
				{
					details: {
						cwd: "/repo/src",
						command: "cat helper.ts",
						deeper: { ignored: { path: "not-reached.ts" } },
					},
				},
				"/repo",
			),
		).toEqual([path.resolve("/repo/src"), path.resolve("/repo/src/helper.ts")]);
	});

	test("includes candidates at the maximum nested-record depth", () => {
		expect(extractPathCandidates({ level1: { level2: { path: "files/depth-two.ts" } } }, "/repo")).toEqual([
			path.resolve("/repo/files/depth-two.ts"),
		]);
	});

	test("enforces the candidate and string-scan budgets", () => {
		const tokens = Array.from({ length: 20 }, (_, index) => `files/${index}.ts`).join(" ");
		expect(extractPathCandidates({ command: tokens }, "/repo")).toHaveLength(16);
		expect(extractPathCandidates({ command: `${"x".repeat(16 * 1024)} files/late.ts` }, "/repo")).toEqual([]);

		const exactPath = "files/exact-limit.ts";
		const exactLengthCommand = `${"x".repeat(16 * 1024 - exactPath.length - 1)} ${exactPath}`;
		expect(exactLengthCommand).toHaveLength(16 * 1024);
		expect(extractPathCandidates({ command: exactLengthCommand }, "/repo")).toEqual([
			path.resolve("/repo/files/exact-limit.ts"),
		]);
	});
});
