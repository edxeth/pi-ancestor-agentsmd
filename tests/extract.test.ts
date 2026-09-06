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
						// input(0) > details(1) > deeper(2) > ignored(3) > inner(4) is
						// walked; deepest(5) exceeds the depth limit.
						deeper: { ignored: { inner: { deepest: { path: "not-reached.ts" } } } },
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

describe("extractPathCandidates (shell and envelope shapes)", () => {
	test("resolves =-attached flag values", () => {
		expect(extractPathCandidates({ command: "tool --file=src/file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/src/file.ts"),
		]);
	});

	test("treats bare cd/pushd/ls targets as directories and tracks the shell cwd for later tokens", () => {
		expect(extractPathCandidates({ command: "cd src && cat file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/src"),
			path.resolve("/repo/src/file.ts"),
		]);
		expect(extractPathCandidates({ command: "ls src" }, "/repo")).toEqual([path.resolve("/repo/src")]);
		expect(extractPathCandidates({ command: "make -C pkg test" }, "/repo")).toEqual([
			path.resolve("/repo/pkg"),
		]);
	});

	test("rejects flags, URLs, and shell separators as directory targets", () => {
		expect(extractPathCandidates({ command: "cd - && cat file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/file.ts"),
		]);
		expect(extractPathCandidates({ command: "cd https://example.com && cat file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/file.ts"),
		]);
		expect(extractPathCandidates({ command: "cd && cat file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/file.ts"),
		]);
	});

	test("tracks successive directory changes before resolving a later file", () => {
		expect(extractPathCandidates({ command: "pushd src && ls pkg && cat file.ts" }, "/repo")).toEqual([
			path.resolve("/repo/src"),
			path.resolve("/repo/src/pkg"),
			path.resolve("/repo/src/pkg/file.ts"),
		]);
	});

	test("resolves quoted spans containing spaces as whole paths", () => {
		expect(extractPathCandidates({ cmd: 'cat "my dir/app.ts"' }, "/repo")).toEqual([
			path.resolve("/repo/my dir/app.ts"),
		]);
	});

	test("walks JSON-encoded argument strings", () => {
		expect(extractPathCandidates({ arguments: '{"path":"src/file.ts"}' }, "/repo")).toEqual([
			path.resolve("/repo/src/file.ts"),
		]);
	});

	test("falls back to token scanning when a JSON-looking string is malformed", () => {
		expect(extractPathCandidates({ arguments: '{ "path": "src/file.ts" trailing' }, "/repo")).toEqual([
			path.resolve("/repo/src/file.ts"),
		]);
	});

	test("reaches depth-four structured envelopes", () => {
		expect(extractPathCandidates({ payload: { files: [{ path: "src/file.ts" }] } }, "/repo")).toEqual([
			path.resolve("/repo/src/file.ts"),
		]);
	});

	test("keeps structured and parsed-token recursion within depth four", () => {
		expect(extractPathCandidates({ a: { b: { c: { d: { path: "exact" } } } } }, "/repo")).toEqual([
			path.resolve("/repo/exact"),
		]);
		expect(
			extractPathCandidates(
				{ a: { b: { c: { d: { payload: '{"path":"too-deep","workdir":"nested","command":"cat file.ts"}' } } } } },
				"/repo",
			),
		).toEqual([]);
		expect(
			extractPathCandidates(
				{ a: { b: { c: { d: { payload: { workdir: "nested", command: "cat file.ts" } } } } } },
				"/repo",
			),
		).toEqual([]);
	});

	test("honors working_directory as a base key", () => {
		expect(extractPathCandidates({ command: "cat helper.ts", working_directory: "src" }, "/repo")).toEqual([
			path.resolve("/repo/src"),
			path.resolve("/repo/src/helper.ts"),
		]);
	});

	test("token-scans top-level string inputs", () => {
		expect(extractPathCandidates("cat src/file.ts", "/repo")).toEqual([path.resolve("/repo/src/file.ts")]);
	});

	test("keeps the top-level string and object depth origins at zero", () => {
		expect(extractPathCandidates('{"a":{"b":{"c":{"path":"exact"}}}}', "/repo")).toEqual([
			path.resolve("/repo/exact"),
		]);
		expect(extractPathCandidates({ a: { b: { c: { d: { path: "exact" } } } } }, "/repo")).toEqual([
			path.resolve("/repo/exact"),
		]);
		expect(
			extractPathCandidates(
				{ a: { b: { c: { d: { payload: { workdir: "nested", command: "cat file.ts" } } } } } },
				"/repo",
			),
		).toEqual([]);
	});

	test("retains one-character path tokens", () => {
		expect(extractPathCandidates({ command: "cat /" }, "/repo")).toEqual([path.resolve("/repo", "/")]);
	});

	test("scans the first budget of oversized strings instead of skipping them", () => {
		expect(extractPathCandidates({ command: `files/early.ts ${"x".repeat(16 * 1024)}` }, "/repo")).toEqual([
			path.resolve("/repo/files/early.ts"),
		]);
	});

	test("collects structured path fields before token noise under the candidate cap", () => {
		const noise = Array.from({ length: 20 }, (_, index) => `noise${index}/missing.ts`).join(" ");
		const out = extractPathCandidates({ description: noise, path: "actual/subtree/file.ts" }, "/repo");
		expect(out).toContain(path.resolve("/repo/actual/subtree/file.ts"));
	});
});

describe("extractPathCandidates (quoted shell targets)", () => {
	test("tracks a quoted directory through cd and resolves later tokens against it", () => {
		expect(extractPathCandidates({ command: 'cd "my dir" && cat file.ts' }, "/repo")).toEqual([
			path.resolve("/repo/my dir"),
			path.resolve("/repo/my dir/file.ts"),
		]);
	});

	test("still resolves quoted file paths with spaces as whole candidates", () => {
		expect(extractPathCandidates({ cmd: "cat 'my dir/app.ts'" }, "/repo")).toEqual([
			path.resolve("/repo/my dir/app.ts"),
		]);
	});
});

describe("extractPathCandidates (top-level string depth boundary)", () => {
	test("walks JSON string inputs seeded at depth zero so depth-four paths still resolve", () => {
		expect(extractPathCandidates('{"a":{"b":{"c":{"path":"deep/file.ts"}}}}', "/repo")).toEqual([
			path.resolve("/repo/deep/file.ts"),
		]);
	});
});
