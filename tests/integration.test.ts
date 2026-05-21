import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, mock, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function hasToolName(event: unknown): event is { toolName: string } {
	return typeof event === "object" && event !== null && "toolName" in event;
}

mock.module("@earendil-works/pi-coding-agent", () => ({
	isReadToolResult: (event: unknown) => hasToolName(event) && event.toolName === "read",
}));

async function loadExtension() {
	return (await import("../src/index.js")).default;
}

type TextBlock = { type: "text"; text: string };
type ReadEvent = {
	type: "tool_result";
	toolName: "read";
	input: { path?: string | number };
	content: TextBlock[];
	isError: boolean;
};
type FakeContext = {
	cwd: string;
	sessionManager: { getSessionFile: () => string };
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
};
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: FakeContext) => void | Promise<void>;
type FakeEntry = { type: string; data: unknown };
type FakePi = {
	on: (event: string, handler: Handler) => void;
	registerFlag: (name: string) => void;
	getFlag: (name: string) => boolean;
	registerCommand: (name: string, opts: { handler: CommandHandler }) => void;
	appendEntry: (type: string, data?: unknown) => void;
};

async function makeTree(files: Record<string, string>) {
	const root = await realpath(await mkdtemp(path.join(tmpdir(), "paa-")));
	for (const [relative, content] of Object.entries(files)) {
		const full = path.join(root, relative);
		await mkdir(path.dirname(full), { recursive: true });
		await writeFile(full, content, "utf8");
	}
	return {
		root,
		path: (relative: string) => path.join(root, relative),
		cleanup: () => rm(root, { recursive: true, force: true }),
	};
}

function makeFakePi(cwd: string, options: { sessionFile?: string; disabled?: boolean } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const entries: FakeEntry[] = [];
	const registeredFlags: string[] = [];
	const notifications: string[] = [];
	const ctx: FakeContext = {
		cwd,
		sessionManager: { getSessionFile: () => options.sessionFile ?? "/tmp/session.jsonl" },
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const pi: FakePi = {
		on: (event, handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: (name) => {
			registeredFlags.push(name);
		},
		getFlag: (name) => name === "no-context-files" && options.disabled === true,
		registerCommand: (name, opts) => {
			commands.set(name, opts.handler);
		},
		appendEntry: (type, data) => {
			entries.push({ type, data });
		},
	};
	return {
		pi,
		ctx,
		entries,
		registeredFlags,
		notifications,
		emit: async (event: string, payload: unknown) => {
			let result: unknown;
			for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
			return result;
		},
		runCommand: async (name: string) => commands.get(name)?.("", ctx),
	};
}

function readEvent(file: string, overrides: Partial<ReadEvent> = {}): ReadEvent {
	return {
		type: "tool_result",
		toolName: "read",
		input: { path: file },
		content: [{ type: "text", text: "file content" }],
		isError: false,
		...overrides,
	};
}

function contentText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
		return "";
	}
	return result.content
		.filter((block): block is TextBlock => typeof block === "object" && block !== null && "text" in block)
		.map((block) => block.text)
		.join("\n");
}

function lastEntry(entries: FakeEntry[]) {
	return entries[entries.length - 1];
}

describe("extension integration", () => {
	test("injects ancestor AGENTS.md closest-first and dedupes until compaction", async () => {
		const tree = await makeTree({
			"AGENTS.md": "root rules",
			"src/AGENTS.md": "src rules",
			"src/components/AGENTS.md": "component rules",
			"src/components/Button.tsx": "button",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const first = await fake.emit("tool_result", readEvent(tree.path("src/components/Button.tsx")));
			const text = contentText(first);
			expect(text.indexOf("component rules")).toBeLessThan(text.indexOf("src rules"));
			expect(text).not.toContain("root rules");

			const second = await fake.emit("tool_result", readEvent(tree.path("src/components/Button.tsx")));
			expect(second).toEqual({ content: [{ type: "text", text: "file content" }] });

			const isError = await fake.emit(
				"tool_result",
				readEvent(tree.path("src/components/Button.tsx"), { isError: true, content: [{ type: "text", text: "error" }] }),
			);
			expect(isError).toBeUndefined();

			const nonStringPath = await fake.emit(
				"tool_result",
				readEvent(tree.path("src/components/Button.tsx"), { input: { path: 7 } }),
			);
			expect(nonStringPath).toBeUndefined();

			await fake.emit("session_compact", {});
			const afterCompact = await fake.emit("tool_result", readEvent(tree.path("src/components/Button.tsx")));
			expect(contentText(afterCompact)).toContain("component rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("rejects reads that resolve outside the session root through a symlink", async () => {
		const outside = await makeTree({ "secret/AGENTS.md": "evil rules", "secret/file.ts": "secret" });
		const tree = await makeTree({ "src/AGENTS.md": "src rules" });
		try {
			await symlink(path.join(outside.root, "secret"), tree.path("src/escape"));
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("tool_result", readEvent(tree.path("src/escape/file.ts")));
			expect(result).toBeUndefined();
		} finally {
			await outside.cleanup();
			await tree.cleanup();
		}
	});

	test("does not inject when --no-context-files is enabled through registered flag", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root, { disabled: true });
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("tool_result", readEvent(tree.path("src/file.ts")));
			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("keeps session caches isolated", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const first = makeFakePi(tree.root, { sessionFile: "/tmp/one.jsonl" });
			const second = makeFakePi(tree.root, { sessionFile: "/tmp/two.jsonl" });
			extension(first.pi as unknown as ExtensionAPI);
			extension(second.pi as unknown as ExtensionAPI);
			await first.emit("session_start", {});
			await second.emit("session_start", {});

			expect(contentText(await first.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
			expect(contentText(await second.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("registers --no-context-files and /nested-context-files debug command", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});
			await fake.emit("tool_result", readEvent(tree.path("src/file.ts")));
			await fake.runCommand("nested-context-files");

			expect(fake.registeredFlags).toContain("no-context-files");
			expect(lastEntry(fake.entries)?.type).toBe("ancestor-agentsmd:context-files");
			expect(lastEntry(fake.entries)?.data).toMatchObject({ count: 1 });
		} finally {
			await tree.cleanup();
		}
	});
});