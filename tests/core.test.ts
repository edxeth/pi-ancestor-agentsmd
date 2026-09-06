import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test, beforeAll } from "bun:test";
import {
	collectNestedAgentsDirs,
	collectRecursive,
	collectRecursiveAgents,
	collectRecursiveDesign,
	hasNoContextFilesFlag,
	isRootDesignMdEnabled,
	isAncestorDesignMdEnabled,
	isAncestorAgentsMdEnabled,
	isNestedAgentsManifestEnabled,
	prependAgentsContent,
	resolveContainedPath,
	truncateForContext,
} from "../src/core.js";

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

	test("PI_NESTED_AGENTS_MANIFEST defaults to enabled", () => {
		delete process.env.PI_NESTED_AGENTS_MANIFEST;
		expect(isNestedAgentsManifestEnabled()).toBe(true);
	});

	test("PI_NESTED_AGENTS_MANIFEST=0 disables the manifest", () => {
		process.env.PI_NESTED_AGENTS_MANIFEST = "0";
		expect(isNestedAgentsManifestEnabled()).toBe(false);
		delete process.env.PI_NESTED_AGENTS_MANIFEST;
	});
});

describe("collectNestedAgentsDirs", () => {
	test("returns bounded breadth-first relative paths and skips excluded directories", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-core-")));
		try {
			for (const relative of [
				"AGENTS.md",
				"alpha/AGENTS.md",
				"alpha/deep/AGENTS.md",
				"alpha/deep/deeper/AGENTS.md",
				"beta/AGENTS.md",
				"beta/deep/AGENTS.md",
				"gamma/AGENTS.md",
				".hidden/AGENTS.md",
				"node_modules/pkg/AGENTS.md",
			]) {
				const filepath = path.join(root, relative);
				await mkdir(path.dirname(filepath), { recursive: true });
				await writeFile(filepath, relative, "utf8");
			}
			await mkdir(path.join(root, "empty"), { recursive: true });

			expect(await collectNestedAgentsDirs(root)).toEqual([
				"alpha",
				"beta",
				"gamma",
				"alpha/deep",
				"beta/deep",
				"alpha/deep/deeper",
			]);
			expect(await collectNestedAgentsDirs(root, { maxDepth: 1 })).toEqual(["alpha", "beta", "gamma"]);
			expect(await collectNestedAgentsDirs(root, { maxEntries: 2 })).toEqual(["alpha", "beta"]);
			expect(await collectNestedAgentsDirs(root, { maxDepth: 2 })).toEqual([
				"alpha",
				"beta",
				"gamma",
				"alpha/deep",
				"beta/deep",
			]);
			expect(await collectNestedAgentsDirs(path.join(root, "missing"))).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("sorts manifest directories by name before traversing them", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-core-sort-")));
		try {
			for (const relative of ["zeta/AGENTS.md", "alpha/AGENTS.md"]) {
				const filepath = path.join(root, relative);
				await mkdir(path.dirname(filepath), { recursive: true });
				await writeFile(filepath, relative, "utf8");
			}

			expect(await collectNestedAgentsDirs(root, { maxDepth: 1 })).toEqual(["alpha", "zeta"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("keeps a large manifest listing in sorted order", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-core-sort-large-")));
		const names = [
			"k130",
			"q208",
			"m156",
			"c026",
			"n169",
			"p195",
			"s234",
			"b013",
			"i104",
			"v273",
			"f065",
			"j117",
			"w286",
			"t247",
			"o182",
			"e052",
			"d039",
			"u260",
			"r221",
			"l143",
			"g078",
			"x299",
			"h091",
			"a000",
		];
		try {
			for (const name of names) {
				await mkdir(path.join(root, name), { recursive: true });
				await writeFile(path.join(root, name, "AGENTS.md"), name, "utf8");
			}

			expect(await collectNestedAgentsDirs(root, { maxDepth: 1 })).toEqual([...names].sort());
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("collectRecursiveAgents", () => {
	test("returns no target when the path cannot be resolved", async () => {
		expect(await resolveContainedPath("missing/file.ts", "/tmp/paa-no-such-root")).toBeNull();
	});

	test("collects nested AGENTS from closest to broadest and skips cwd root", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/deeper/AGENTS.md"), "deep rules\n"],
			[path.resolve("/repo/nested/AGENTS.md"), "nested rules\n"],
			[path.resolve("/repo/AGENTS.md"), "root rules\n"],
		]);

		const results = await collectRecursiveAgents("nested/deeper/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			expect.objectContaining({ filepath: path.resolve("/repo/nested/deeper/AGENTS.md"), content: "deep rules\n" }),
			expect.objectContaining({ filepath: path.resolve("/repo/nested/AGENTS.md"), content: "nested rules\n" }),
		]);
	});

	test("accepts an explicit filename array", async () => {
		const filepath = path.resolve("/repo/nested/AGENTS.md");
		const results = await collectRecursive("nested/file.ts", "/repo", async (candidate) => {
			return candidate === filepath ? "nested rules\n" : "";
		}, ["AGENTS.md"]);

		expect(results).toEqual([expect.objectContaining({ filepath, content: "nested rules\n" })]);
	});

	test("skips the target AGENTS file itself", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/AGENTS.md"), "nested rules\n"],
			[path.resolve("/repo/nested/deeper/AGENTS.md"), "deep rules\n"],
		]);

		const results = await collectRecursiveAgents("nested/deeper/AGENTS.md", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			expect.objectContaining({ filepath: path.resolve("/repo/nested/AGENTS.md"), content: "nested rules\n" }),
		]);
	});

	test("starts at a directory target when the input has a trailing separator", async () => {
		const cwd = "/repo";
		const filepath = path.resolve("/repo/nested/AGENTS.md");
		const results = await collectRecursiveAgents("nested/", cwd, async (candidate) => {
			return candidate === filepath ? "nested rules\n" : "";
		});

		expect(results).toEqual([expect.objectContaining({ filepath, content: "nested rules\n" })]);
	});

	test("ignores targets outside cwd", async () => {
		const results = await collectRecursiveAgents("/outside/project/file.ts", "/repo", async () => "should not load");
		expect(results).toEqual([]);
	});
});

describe("collectRecursive limits", () => {
	test("truncates without splitting multi-byte characters", () => {
		const result = truncateForContext("ab😀cd", 5, "/repo/AGENTS.md");

		expect(result.truncated).toBe(true);
		expect(result.content).toStartWith("ab");
		expect(result.content).not.toContain("�");
		expect(result.content).toContain("please read the file directly: /repo/AGENTS.md");
	});

	test("does not mark content truncated when it exactly fits the byte limit", () => {
		expect(truncateForContext("abc", 3)).toEqual({
			content: "abc",
			truncated: false,
			originalBytes: 3,
			injectedBytes: 3,
		});
	});

	test("uses an empty prefix when truncation has no available bytes", () => {
		expect(truncateForContext("abc", 0)).toEqual({
			content: "",
			truncated: true,
			originalBytes: 3,
			injectedBytes: 0,
		});
	});

	test("honors the total per-read byte budget across multiple files", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/a/AGENTS.md"), "12345"],
			[path.resolve("/repo/a/b/AGENTS.md"), "67890"],
		]);

		const results = await collectRecursive("a/b/file.ts", cwd, async (filepath) => map.get(filepath) ?? "", {
			filenames: ["AGENTS.md"],
			maxBytesPerFile: 5,
			maxBytesPerRead: 5,
		});

		expect(results).toEqual([expect.objectContaining({ filepath: path.resolve("/repo/a/b/AGENTS.md") })]);
	});

	test("walks once when the total read budget is one byte", async () => {
		const cwd = "/repo";
		const filepath = path.resolve("/repo/a/AGENTS.md");
		const results = await collectRecursive("a/file.ts", cwd, async (candidate) => (candidate === filepath ? "rules" : ""), {
			maxBytesPerRead: 1,
		});

		expect(results).toEqual([expect.objectContaining({ filepath })]);
	});
});

describe("collectRecursiveDesign", () => {
	test("collects nested DESIGN.md from closest to broadest and skips cwd root", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/deeper/DESIGN.md"), "deep design\n"],
			[path.resolve("/repo/nested/DESIGN.md"), "nested design\n"],
			[path.resolve("/repo/DESIGN.md"), "root design\n"],
		]);

		const results = await collectRecursiveDesign("nested/deeper/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			expect.objectContaining({ filepath: path.resolve("/repo/nested/deeper/DESIGN.md"), content: "deep design\n" }),
			expect.objectContaining({ filepath: path.resolve("/repo/nested/DESIGN.md"), content: "nested design\n" }),
		]);
	});

	test("skips the target DESIGN.md file itself", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/nested/DESIGN.md"), "nested design\n"],
			[path.resolve("/repo/nested/deeper/DESIGN.md"), "deep design\n"],
		]);

		const results = await collectRecursiveDesign("nested/deeper/DESIGN.md", cwd, async (filepath) => map.get(filepath) ?? "");

		expect(results).toEqual([
			expect.objectContaining({ filepath: path.resolve("/repo/nested/DESIGN.md"), content: "nested design\n" }),
		]);
	});

	test("collects both DESIGN.md and AGENTS.md when root dirs have only one type each", async () => {
		const cwd = "/repo";
		const map = new Map([
			[path.resolve("/repo/sub/DESIGN.md"), "sub design\n"],
			[path.resolve("/repo/AGENTS.md"), "root agents\n"],
		]);

		const designResults = await collectRecursiveDesign("sub/file.ts", cwd, async (filepath) => map.get(filepath) ?? "");
		expect(designResults).toEqual([
			expect.objectContaining({ filepath: path.resolve("/repo/sub/DESIGN.md"), content: "sub design\n" }),
		]);

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

describe("instruction file containment (symlinks)", () => {
	const readReal = async (filepath: string) => {
		try {
			return await readFile(filepath, "utf8");
		} catch {
			return "";
		}
	};

	test("rejects an AGENTS.md symlink resolving outside the session root", async () => {
		const outside = await realpath(await mkdtemp(path.join(tmpdir(), "paa-out-")));
		await writeFile(path.join(outside, "rules.md"), "OUTSIDE_RULES");
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-sym-")));
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src", "file.ts"), "x");
		await symlink(path.join(outside, "rules.md"), path.join(root, "src", "AGENTS.md"));
		try {
			const files = await collectRecursiveAgents("src/file.ts", root, readReal);
			expect(files).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});

	test("allows an AGENTS.md symlink resolving inside the session root", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-sym-")));
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src", "file.ts"), "x");
		await writeFile(path.join(root, "shared-agents.md"), "INSIDE_RULES");
		await symlink(path.join(root, "shared-agents.md"), path.join(root, "src", "AGENTS.md"));
		try {
			const files = await collectRecursiveAgents("src/file.ts", root, readReal);
			expect(files.map((file) => file.content)).toContain("INSIDE_RULES");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("contains candidates against a symlinked session root", async () => {
		const realRoot = await realpath(await mkdtemp(path.join(tmpdir(), "paa-sym-")));
		await mkdir(path.join(realRoot, "pkg"), { recursive: true });
		await writeFile(path.join(realRoot, "pkg", "AGENTS.md"), "PKG_RULES");
		await writeFile(path.join(realRoot, "pkg", "file.ts"), "x");
		const linkRoot = realRoot + "-link";
		await symlink(realRoot, linkRoot);
		try {
			const files = await collectRecursiveAgents("pkg/file.ts", linkRoot, readReal);
			expect(files.map((file) => file.content)).toContain("PKG_RULES");
		} finally {
			await rm(linkRoot);
			await rm(realRoot, { recursive: true, force: true });
		}
	});
});

describe("resolveContainedPath missing-target fallback", () => {
	test("falls back to the nearest existing ancestor for a deleted target", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-")));
		await mkdir(path.join(root, "pkg"), { recursive: true });
		await writeFile(path.join(root, "pkg", "AGENTS.md"), "rules");
		try {
			const resolved = await resolveContainedPath("pkg/gone.ts", root);
			expect(resolved?.target).toBe(path.join(root, "pkg"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("falls back to the directory for a glob-shaped target", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-")));
		await mkdir(path.join(root, "pkg"), { recursive: true });
		await writeFile(path.join(root, "pkg", "AGENTS.md"), "rules");
		try {
			const resolved = await resolveContainedPath("pkg/*.ts", root);
			expect(resolved?.target).toBe(path.join(root, "pkg"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("falls back across a chain of missing directories", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-")));
		await mkdir(path.join(root, "pkg"), { recursive: true });
		try {
			const resolved = await resolveContainedPath("pkg/a/b/c.ts", root);
			expect(resolved?.target).toBe(path.join(root, "pkg"));
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("returns null when the climb lands on the session root", async () => {
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-")));
		try {
			expect(await resolveContainedPath("definitely-missing.ts", root)).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("returns null when the surviving ancestor resolves outside the root", async () => {
		const outside = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-out-")));
		const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-fb-")));
		await symlink(outside, path.join(root, "pkg-link"));
		try {
			expect(await resolveContainedPath("pkg-link/gone.ts", root)).toBeNull();
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}
	});
});
