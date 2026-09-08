import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	sessionManager?: { getSessionFile: () => string };
	ui: { notify: (message: string, type?: "info" | "warning" | "error") => void };
};
type Handler = (event: unknown, ctx: FakeContext) => unknown | Promise<unknown>;
type CommandHandler = (args: string, ctx: FakeContext) => void | Promise<void>;
type FakeEntry = { type: string; data: unknown };
type FakePi = {
	on: (event: string, handler: Handler) => void;
	registerFlag: (name: string, options?: { default?: boolean }) => void;
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

function makeFakePi(
	cwd: string,
	options: { sessionFile?: string; disabled?: boolean; withoutSessionManager?: boolean } = {},
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, CommandHandler>();
	const entries: FakeEntry[] = [];
	const registeredFlags: string[] = [];
	const registeredFlagOptions = new Map<string, { default?: boolean }>();
	const notifications: string[] = [];
	const ctx: FakeContext = {
		cwd,
		sessionManager: options.withoutSessionManager
			? undefined
			: { getSessionFile: () => options.sessionFile ?? "/tmp/session.jsonl" },
		ui: { notify: (message: string) => notifications.push(message) },
	};
	const pi: FakePi = {
		on: (event, handler) => {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		registerFlag: (name, flagOptions) => {
			registeredFlags.push(name);
			if (flagOptions) registeredFlagOptions.set(name, flagOptions);
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
		registeredFlagOptions,
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
	test("does not register handlers when the process flag disables the extension", async () => {
		const previousArgv = process.argv;
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		process.argv = [...previousArgv, "--no-context-files"];
		try {
			const extension = (await import("../src/index.js" + "?hardener-no-context-files")).default;
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);

			expect(fake.registeredFlags).toContain("no-context-files");
			expect(await fake.emit("session_start", {})).toBeUndefined();
			expect(await fake.emit("tool_result", readEvent(tree.path("src/file.ts")))).toBeUndefined();
		} finally {
			process.argv = previousArgv;
			await tree.cleanup();
		}
	});

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
			expect(second).toBeUndefined();

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

	test("injects ancestor AGENTS.md for custom tools via command-string extraction", async () => {
		const tree = await makeTree({
			"tests/AGENTS.md": "tests rules",
			"tests/helper.ts": "helper content",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			// Deliberately not "read" or "exec_command": injection must not depend on tool identity.
			const result = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "shell_runner",
				input: { cmd: "cat tests/helper.ts", workdir: tree.root },
				content: [{ type: "text", text: "helper content" }],
				isError: false,
			});

			const text = contentText(result);
			expect(text).toContain("tests rules");
			expect(text.indexOf("tests rules")).toBeLessThan(text.indexOf("helper content"));
		} finally {
			await tree.cleanup();
		}
	});

	test("injects ancestor AGENTS.md for custom tools with structured path inputs", async () => {
		const tree = await makeTree({
			"pkg/internal/AGENTS.md": "internal rules",
			"pkg/internal/core.ts": "core",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "mcp_gateway",
				input: { args: { path: tree.path("pkg/internal/core.ts") } },
				content: [{ type: "text", text: "core" }],
				isError: false,
			});

			expect(contentText(result)).toContain("internal rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("ignores primitive tool-result inputs", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "shell_runner",
				input: `cat ${tree.path("src/file.ts")}`,
				content: [{ type: "text", text: "x" }],
				isError: false,
			});
			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("places AGENTS.md above DESIGN.md for generic tool results", async () => {
		const previous = process.env.PI_ANCESTOR_DESIGN_MD;
		process.env.PI_ANCESTOR_DESIGN_MD = "1";
		const tree = await makeTree({
			"src/AGENTS.md": "agent rules",
			"src/DESIGN.md": "design rules",
			"src/file.ts": "TARGET_FILE_BODY",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "filesystem_gateway",
				input: { file_path: "src/file.ts" },
				content: [{ type: "text", text: "TARGET_FILE_BODY" }],
				isError: false,
			});
			const text = contentText(result);
			expect(text.indexOf("agent rules")).toBeLessThan(text.indexOf("design rules"));
			expect(text.indexOf("design rules")).toBeLessThan(text.indexOf("TARGET_FILE_BODY"));
		} finally {
			if (previous === undefined) delete process.env.PI_ANCESTOR_DESIGN_MD;
			else process.env.PI_ANCESTOR_DESIGN_MD = previous;
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
			expect(await fake.emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
			expect(await fake.emit("context", { messages: [] })).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("does not inject when root DESIGN.md is enabled but absent", async () => {
		const previous = process.env.PI_ROOT_DESIGN_MD;
		process.env.PI_ROOT_DESIGN_MD = "1";
		const tree = await makeTree({ "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(await fake.emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_ROOT_DESIGN_MD;
			else process.env.PI_ROOT_DESIGN_MD = previous;
			await tree.cleanup();
		}
	});

	test("does not inject an empty root DESIGN.md", async () => {
		const previous = process.env.PI_ROOT_DESIGN_MD;
		process.env.PI_ROOT_DESIGN_MD = "1";
		const tree = await makeTree({ "DESIGN.md": "" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(await fake.emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_ROOT_DESIGN_MD;
			else process.env.PI_ROOT_DESIGN_MD = previous;
			await tree.cleanup();
		}
	});

	test("does not collect ancestor files when ancestor injection is disabled", async () => {
		const previous = process.env.PI_ANCESTOR_AGENTS_MD;
		process.env.PI_ANCESTOR_AGENTS_MD = "0";
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(await fake.emit("tool_result", readEvent(tree.path("src/file.ts")))).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env.PI_ANCESTOR_AGENTS_MD;
			else process.env.PI_ANCESTOR_AGENTS_MD = previous;
			await tree.cleanup();
		}
	});

	test("does not inject context files into an error tool result", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit(
				"tool_result",
				readEvent(tree.path("src/file.ts"), { isError: true, content: [{ type: "text", text: "error" }] }),
			);
			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("uses a safe singleton session key when no session manager is available", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root, { withoutSessionManager: true });
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(contentText(await fake.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("does not treat an empty session filename as a real session key", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const emptyFile = makeFakePi(tree.root, { sessionFile: "" });
			const missingManager = makeFakePi(tree.root, { withoutSessionManager: true });
			extension(emptyFile.pi as unknown as ExtensionAPI);
			extension(missingManager.pi as unknown as ExtensionAPI);
			await emptyFile.emit("session_start", {});
			await missingManager.emit("session_start", {});

			await emptyFile.emit("tool_result", readEvent(tree.path("src/file.ts")));
			expect(await missingManager.emit("tool_result", readEvent(tree.path("src/file.ts")))).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("accepts a one-character session filename", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const oneCharacter = makeFakePi(tree.root, { sessionFile: "x" });
			const missingManager = makeFakePi(tree.root, { withoutSessionManager: true });
			extension(oneCharacter.pi as unknown as ExtensionAPI);
			extension(missingManager.pi as unknown as ExtensionAPI);
			await oneCharacter.emit("session_start", {});
			await missingManager.emit("session_start", {});

			expect(contentText(await oneCharacter.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
			expect(contentText(await missingManager.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
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

	test("injects root DESIGN.md into every agent start and records debug state", async () => {
		const previous = process.env.PI_ROOT_DESIGN_MD;
		process.env.PI_ROOT_DESIGN_MD = "1";
		const tree = await makeTree({ "DESIGN.md": "DESIGN_SENTINEL_ROOT_INJECTION_2026_06_11" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root, { sessionFile: "/tmp/root-design.jsonl" });
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const first = await fake.emit("before_agent_start", { systemPrompt: "base prompt" });
			const second = await fake.emit("before_agent_start", { systemPrompt: "next prompt" });
			await fake.runCommand("nested-context-files");

			expect(first).toMatchObject({
				systemPrompt: expect.stringContaining("DESIGN_SENTINEL_ROOT_INJECTION_2026_06_11"),
			});
			expect(second).toMatchObject({
				systemPrompt: expect.stringContaining("DESIGN_SENTINEL_ROOT_INJECTION_2026_06_11"),
			});
			expect(fake.entries.filter((entry) => entry.type === "ancestor-agentsmd:context-file-event")).toEqual([
				expect.objectContaining({
					data: expect.objectContaining({
						type: "root-design-md",
						path: tree.path("DESIGN.md"),
						mode: "system-prompt",
						turn: 1,
					}),
				}),
				expect.objectContaining({
					data: expect.objectContaining({ turn: 2 }),
				}),
			]);
			expect(lastEntry(fake.entries)?.type).toBe("ancestor-agentsmd:context-files");
			expect(lastEntry(fake.entries)?.data).toMatchObject({
				count: 1,
				files: [
					expect.objectContaining({
						filepath: tree.path("DESIGN.md"),
						type: "DESIGN.md",
						truncated: false,
						mode: "system-prompt",
						injectionCount: 2,
						lastTurn: 2,
					}),
				],
			});
		} finally {
			if (previous === undefined) {
				delete process.env.PI_ROOT_DESIGN_MD;
			} else {
				process.env.PI_ROOT_DESIGN_MD = previous;
			}
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
			expect(fake.registeredFlagOptions.get("no-context-files")).toMatchObject({ default: false });
			expect(lastEntry(fake.entries)?.type).toBe("ancestor-agentsmd:context-files");
			expect(lastEntry(fake.entries)?.data).toMatchObject({ count: 1 });
			expect(lastEntry(fake.entries)?.data).toMatchObject({
				files: [expect.objectContaining({ mode: "tool-result", injectionCount: 1 })],
			});
		} finally {
			await tree.cleanup();
		}
	});

	test("clears the session cache when the session shuts down", async () => {
		const tree = await makeTree({ "src/AGENTS.md": "src rules", "src/file.ts": "x" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root, { sessionFile: "/tmp/shutdown.jsonl" });
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(contentText(await fake.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
			await fake.emit("session_shutdown", {});
			expect(contentText(await fake.emit("tool_result", readEvent(tree.path("src/file.ts"))))).toContain("src rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("preserves the original injection mode for an already loaded ancestor", async () => {
		const tree = await makeTree({
			"src/AGENTS.md": "src rules",
			"src/file.ts": "src file",
			"src/deep/AGENTS.md": "deep rules",
			"src/deep/file.ts": "deep file",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			await fake.emit("context", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "sweep-src", arguments: { path: "src/file.ts" } }],
					},
				],
			});
			await fake.emit("tool_result", readEvent(tree.path("src/deep/file.ts")));
			await fake.runCommand("nested-context-files");

			expect(lastEntry(fake.entries)?.data).toMatchObject({
				files: [
					expect.objectContaining({ filepath: tree.path("src/AGENTS.md"), mode: "context-sweep" }),
					expect.objectContaining({ filepath: tree.path("src/deep/AGENTS.md"), mode: "tool-result" }),
				],
			});
		} finally {
			await tree.cleanup();
		}
	});

	test("records complete delivery for a large tool-result context file", async () => {
		const content = "x".repeat(32 * 1024 + 1) + "FINAL_RULE";
		const tree = await makeTree({
			"src/AGENTS.md": content,
			"src/file.ts": "x",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});
			const result = await fake.emit("tool_result", readEvent(tree.path("src/file.ts")));
			await fake.runCommand("nested-context-files");

			expect(contentText(result).includes(content)).toBe(true);
			expect(lastEntry(fake.entries)?.data).toMatchObject({
				files: [expect.objectContaining({ filepath: tree.path("src/AGENTS.md"), truncated: false })],
			});
		} finally {
			await tree.cleanup();
		}
	});

	test("sweeps transcript tool calls on context and injects pending AGENTS.md durably", async () => {
		const tree = await makeTree({
			"tests/AGENTS.md": "tests rules",
			"tests/helper.ts": "helper content",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			// Transcript from a session whose tool calls never passed through the
			// tool_result handler (e.g. restored session, foreign tool surface).
			const transcript = [
				{ role: "user", content: "inspect the tests", timestamp: 1 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-1",
							name: "shell_runner",
							arguments: { cmd: "cat tests/helper.ts", workdir: tree.root },
						},
					],
					timestamp: 2,
				},
			];

			const first = (await fake.emit("context", { messages: transcript })) as { messages: unknown[] };
			expect(first.messages).toHaveLength(transcript.length + 1);
			const swept = first.messages[first.messages.length - 1] as { role: string; content: string; display: boolean };
			expect(swept.role).toBe("custom");
			expect(swept.display).toBe(false);
			expect(swept.content).toContain("<project_instructions");
			expect(swept.content).toContain("tests rules");

			// The transform is per-request; a fed-back sweep message is replaced by
			// a fresh one rather than appended after.
			const second = (await fake.emit("context", { messages: [...transcript, swept] })) as {
				messages: Array<{ role: string; content: string }>;
			};
			expect(second.messages).toHaveLength(transcript.length + 1);
			expect(second.messages).not.toContain(swept);
			const sweptAgain = second.messages[second.messages.length - 1]!;
			expect(sweptAgain.role).toBe("custom");
			expect(sweptAgain.content).toContain("tests rules");
			expect(sweptAgain.content.indexOf("tests rules")).toBe(sweptAgain.content.lastIndexOf("tests rules"));

			// Dedupe across channels: the file was delivered by the sweep, so the
			// tool_result path must not inject it again.
			const viaTool = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "shell_runner",
				input: { cmd: "cat tests/helper.ts", workdir: tree.root },
				content: [{ type: "text", text: "helper content" }],
				isError: false,
			});
			expect(viaTool).toBeUndefined();

			await fake.emit("session_compact", {});
			const afterCompact = (await fake.emit("context", { messages: transcript })) as { messages: unknown[] };
			expect(afterCompact.messages).toHaveLength(transcript.length + 1);
			expect((afterCompact.messages[afterCompact.messages.length - 1] as { content: string }).content).toContain(
				"tests rules",
			);

		} finally {
			await tree.cleanup();
		}
	});

	test("sweeps only the most recent assistant tool calls", async () => {
		const tree = await makeTree({
			"tests/AGENTS.md": "tests rules",
			"tests/helper.ts": "helper content",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const oldCall = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "old-call", arguments: { path: "tests/helper.ts" } },
				],
			};
			const recentMessages = Array.from({ length: 40 }, () => ({ role: "user", content: "chat" }));
			const result = await fake.emit("context", {
				messages: [oldCall, ...recentMessages],
			});

			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("ignores malformed and non-assistant transcript blocks", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper content" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(
				await fake.emit("context", {
					messages: [
						null,
						{ role: "user", content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }] },
						{ role: "assistant", content: [null] },
						{ role: "assistant", content: "not a tool-call block list" },
					],
				}),
			).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("does not treat a non-assistant message as a tool-call source", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper content" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("context", {
				messages: [
					{
						role: "user",
						content: [{ type: "toolCall", id: "user-call", arguments: { path: "tests/helper.ts" } }],
					},
				],
			});
			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("honors a tool-call id even when an earlier call had no filesystem path", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper content" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = await fake.emit("context", {
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "same-call", arguments: {} },
							{ type: "toolCall", id: "same-call", arguments: { path: "tests/helper.ts" } },
						],
					},
				],
			});
			expect(result).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("dedupes pending files across distinct transcript tool calls", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper content" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = (await fake.emit("context", {
				messages: [
					{
						role: "assistant",
						content: [
							{ type: "toolCall", id: "first-path", arguments: { path: "tests/helper.ts" } },
							{ type: "toolCall", id: "second-path", arguments: { path: "tests/helper.ts" } },
						],
					},
				],
			})) as { messages: Array<{ content: string }> };
			expect(result.messages).toHaveLength(2);
			expect(result.messages[1]?.content.indexOf("tests rules")).toBe(
				result.messages[1]?.content.lastIndexOf("tests rules"),
			);
		} finally {
			await tree.cleanup();
		}
	});

	test("sweeps a tool call in the first message of a short transcript", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper content" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = (await fake.emit("context", {
				messages: [
					{
						role: "assistant",
						content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }],
					},
				],
			})) as { messages: Array<{ content: string }> };
			expect(result.messages).toHaveLength(2);
			expect(result.messages[1]?.content).toContain("tests rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("leaves context untouched when no pathy tool calls exist and nothing is pending", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const untouched = await fake.emit("context", {
				messages: [
					{ role: "user", content: "just chatting", timestamp: 1 },
					{ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 },
				],
			});
			expect(untouched).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("appends a nested AGENTS.md manifest to the system prompt", async () => {
		const tree = await makeTree({
			"AGENTS.md": "root rules",
			"frontend/AGENTS.md": "frontend rules",
			"frontend/src/Button.tsx": "button",
			"docs/guide/AGENTS.md": "guide rules",
			"node_modules/pkg/AGENTS.md": "dep rules",
			"misc/file.txt": "misc",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			const result = (await fake.emit("before_agent_start", { systemPrompt: "base prompt" })) as {
				systemPrompt: string;
			};
			expect(result.systemPrompt).toContain("base prompt");
			expect(result.systemPrompt).toContain("frontend/AGENTS.md");
			expect(result.systemPrompt).toContain("docs/guide/AGENTS.md");
			expect(result.systemPrompt).toContain("ensure the applicable AGENTS.md instructions are loaded");
			expect(result.systemPrompt).toContain("Complete injected contents satisfy this requirement");
			expect(result.systemPrompt).not.toContain("read the applicable AGENTS.md first");
			// Root is loaded by pi itself; dependency noise stays out.
			expect(result.systemPrompt).not.toContain("- AGENTS.md\n");
			expect(result.systemPrompt).not.toContain("node_modules");
			expect(result.systemPrompt).not.toContain("root rules");
		} finally {
			await tree.cleanup();
		}
	});

	test("does not reuse a manifest collected while ancestor rules were disabled", async () => {
		const previousAncestor = process.env.PI_ANCESTOR_AGENTS_MD;
		const previousManifest = process.env.PI_NESTED_AGENTS_MANIFEST;
		process.env.PI_ANCESTOR_AGENTS_MD = "0";
		process.env.PI_NESTED_AGENTS_MANIFEST = "1";
		const tree = await makeTree({ "frontend/AGENTS.md": "frontend rules" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			process.env.PI_ANCESTOR_AGENTS_MD = "1";
			expect(await fake.emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
		} finally {
			if (previousAncestor === undefined) delete process.env.PI_ANCESTOR_AGENTS_MD;
			else process.env.PI_ANCESTOR_AGENTS_MD = previousAncestor;
			if (previousManifest === undefined) delete process.env.PI_NESTED_AGENTS_MANIFEST;
			else process.env.PI_NESTED_AGENTS_MANIFEST = previousManifest;
			await tree.cleanup();
		}
	});

	test("leaves the system prompt unchanged when no nested manifest files exist", async () => {
		const tree = await makeTree({ "misc/file.txt": "misc" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			expect(await fake.emit("before_agent_start", { systemPrompt: "base" })).toBeUndefined();
		} finally {
			await tree.cleanup();
		}
	});

	test("omits the manifest when nested rules or the manifest are disabled by env", async () => {
		const tree = await makeTree({ "frontend/AGENTS.md": "frontend rules" });
		const previousManifest = process.env.PI_NESTED_AGENTS_MANIFEST;
		const previousAncestor = process.env.PI_ANCESTOR_AGENTS_MD;
		try {
			const extension = await loadExtension();

			process.env.PI_NESTED_AGENTS_MANIFEST = "0";
			let fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});
			let result = (await fake.emit("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
			expect(result?.systemPrompt ?? "base").not.toContain("frontend/AGENTS.md");

			delete process.env.PI_NESTED_AGENTS_MANIFEST;
			process.env.PI_ANCESTOR_AGENTS_MD = "0";
			fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});
			result = (await fake.emit("before_agent_start", { systemPrompt: "base" })) as { systemPrompt: string };
			expect(result?.systemPrompt ?? "base").not.toContain("frontend/AGENTS.md");
		} finally {
			if (previousManifest === undefined) delete process.env.PI_NESTED_AGENTS_MANIFEST;
			else process.env.PI_NESTED_AGENTS_MANIFEST = previousManifest;
			if (previousAncestor === undefined) delete process.env.PI_ANCESTOR_AGENTS_MD;
			else process.env.PI_ANCESTOR_AGENTS_MD = previousAncestor;
			await tree.cleanup();
		}
	});

	test("injects AGENTS.md for directory-only candidates such as a bare workdir", async () => {
		const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			// An agent that only cd'd into tests/: no pathy token in the command,
			// the directory itself is the candidate.
			const result = await fake.emit("tool_result", {
				type: "tool_result",
				toolName: "shell_runner",
				input: { cmd: "ls", workdir: tree.path("tests") },
				content: [{ type: "text", text: "helper.ts" }],
				isError: false,
			});
			expect(contentText(result)).toContain("tests rules");
		} finally {
			await tree.cleanup();
		}
	});
});

for (const channel of ["tool-result", "context-sweep"] as const) {
	test(`injects every complete ancestor AGENTS.md and DESIGN.md through ${channel} without byte limits`, async () => {
		const previous = process.env.PI_ANCESTOR_DESIGN_MD;
		process.env.PI_ANCESTOR_DESIGN_MD = "1";
		const files: Record<string, string> = {};
		for (let depth = 1; depth <= 6; depth++) {
			const directory = Array.from({ length: depth }, (_, index) => `level${index}`).join("/");
			for (const filename of ["AGENTS.md", "DESIGN.md"]) {
				files[`${directory}/${filename}`] = `START-${depth}-${filename}\n${"é😀�\n".repeat(6000)}END-${depth}-${filename}`;
			}
		}
		const target = "level0/level1/level2/level3/level4/level5/file.ts";
		const tree = await makeTree({ ...files, [target]: "TARGET_FILE_BODY" });
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			// SAFETY: makeFakePi implements the extension methods used by this integration boundary.
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});

			let text: string;
			if (channel === "tool-result") {
				text = contentText(await fake.emit("tool_result", readEvent(tree.path(target))));
			} else {
				// SAFETY: This narrows the actual context handler's returned messages at the fake API boundary.
				const result = await fake.emit("context", {
					messages: [{ role: "assistant", content: [{ type: "toolCall", id: "full-files", arguments: { path: target } }] }],
				}) as { messages: Array<{ content: string }> };
				text = result.messages.at(-1)?.content ?? "";
			}

			expect(text.match(/<project_instructions /g)).toHaveLength(12);
			for (const content of Object.values(files)) {
				expect(text.includes(`<file_content>\n${content}\n</file_content>`)).toBe(true);
			}
			expect(text).not.toContain("Only partial file contents");
			expect(text).not.toContain("Content was truncated");
			expect(text).toContain("complete file contents are already loaded");
		} finally {
			if (previous === undefined) delete process.env.PI_ANCESTOR_DESIGN_MD;
			else process.env.PI_ANCESTOR_DESIGN_MD = previous;
			await tree.cleanup();
		}
	});
}

test("injects a complete large root DESIGN.md into the system prompt", async () => {
	const previous = process.env.PI_ROOT_DESIGN_MD;
	process.env.PI_ROOT_DESIGN_MD = "1";
	const content = "ROOT_DESIGN_START\n" + "é😀�\n".repeat(20000) + "ROOT_DESIGN_END";
	const tree = await makeTree({ "DESIGN.md": content });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		// SAFETY: makeFakePi implements the extension methods used by this integration boundary.
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});
		// SAFETY: With a readable root DESIGN.md enabled, the handler returns its augmented system prompt.
		const result = await fake.emit("before_agent_start", { systemPrompt: "base" }) as { systemPrompt: string };
		expect(result.systemPrompt.includes(content)).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.PI_ROOT_DESIGN_MD;
		else process.env.PI_ROOT_DESIGN_MD = previous;
		await tree.cleanup();
	}
});


test("isolates session roots across overlapping sessions", async () => {
	const treeA = await makeTree({ "pkg/AGENTS.md": "A_RULES", "pkg/file.ts": "a", "other/AGENTS.md": "A_OTHER_RULES", "other/file.ts": "x" });
	const treeB = await makeTree({ "pkg/AGENTS.md": "B_RULES", "pkg/file.ts": "b" });
	try {
		const extension = await loadExtension();
		const sessionA = makeFakePi(treeA.root, { sessionFile: "/tmp/session-a.jsonl" });
		const sessionB = makeFakePi(treeB.root, { sessionFile: "/tmp/session-b.jsonl" });
		extension(sessionA.pi as unknown as ExtensionAPI);
		extension(sessionB.pi as unknown as ExtensionAPI);
		await sessionA.emit("session_start", {});
		await sessionB.emit("session_start", {});

		const absolute = await sessionA.emit("tool_result", {
			type: "tool_result",
			toolName: "shell_runner",
			input: { cmd: `cat ${treeA.path("pkg/file.ts")}` },
			content: [{ type: "text", text: "a" }],
			isError: false,
		});
		expect(contentText(absolute)).toContain("A_RULES");

		const relative = await sessionA.emit("tool_result", {
			type: "tool_result",
			toolName: "shell_runner",
			input: { cmd: "cat other/file.ts", workdir: treeA.root },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		const relativeText = contentText(relative);
		expect(relativeText).toContain("A_OTHER_RULES");
		expect(relativeText).not.toContain("B_RULES");
	} finally {
		await treeA.cleanup();
		await treeB.cleanup();
	}
});

test("snapshots applicable files at tool_call before execution removes their subtree", async () => {
	const tree = await makeTree({
		"pkg/AGENTS.md": "PKG_RULES",
		"pkg/deep/AGENTS.md": "DEEP_RULES",
		"pkg/deep/file.ts": "x",
	});
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		await fake.emit("tool_call", {
			type: "tool_call",
			toolCallId: "call-snap",
			toolName: "shell_runner",
			input: { cmd: "rm -rf pkg/deep" },
		});
		// The command removes the subtree before the result is processed.
		await (await import("node:fs/promises")).rm(tree.path("pkg/deep"), { recursive: true, force: true });

		const result = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-snap",
			toolName: "shell_runner",
			input: { cmd: "rm -rf pkg/deep" },
			content: [{ type: "text", text: "" }],
			isError: false,
		});
		const text = contentText(result);
		expect(text).toContain("DEEP_RULES");
		expect(text).toContain("PKG_RULES");
	} finally {
		await tree.cleanup();
	}
});

test("evicts the oldest pre-execution snapshot when the cache reaches its bound", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "PKG_RULES", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		for (let index = 0; index < 65; index++) {
			await fake.emit("tool_call", {
				type: "tool_call",
				toolCallId: `call-${index}`,
				toolName: "read",
				input: { path: tree.path("pkg/file.ts") },
			});
		}
		await rm(tree.path("pkg/AGENTS.md"));

		const resultFor = (toolCallId: string) => ({
			type: "tool_result",
			toolCallId,
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});

		expect(await fake.emit("tool_result", resultFor("call-0"))).toBeUndefined();
		expect(contentText(await fake.emit("tool_result", resultFor("call-64")))).toContain("PKG_RULES");
	} finally {
		await tree.cleanup();
	}
});

test("does not let empty snapshots evict a real pre-execution snapshot", async () => {
	const tree = await makeTree({
		"pkg/AGENTS.md": "PKG_RULES",
		"pkg/file.ts": "x",
		"empty/file.ts": "empty",
	});
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		await fake.emit("tool_call", {
			type: "tool_call",
			toolCallId: "real-first",
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
		});
		for (let index = 0; index < 64; index++) {
			await fake.emit("tool_call", {
				type: "tool_call",
				toolCallId: `empty-${index}`,
				toolName: "read",
				input: { path: tree.path("empty/file.ts") },
			});
		}
		await rm(tree.path("pkg/AGENTS.md"));

		const result = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "real-first",
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		expect(contentText(result)).toContain("PKG_RULES");
	} finally {
		await tree.cleanup();
	}
});

test("retains more than one pre-execution snapshot before reaching the cache bound", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "PKG_RULES", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		for (const toolCallId of ["first-snapshot", "second-snapshot"]) {
			await fake.emit("tool_call", {
				type: "tool_call",
				toolCallId,
				toolName: "read",
				input: { path: tree.path("pkg/file.ts") },
			});
		}
		await rm(tree.path("pkg/AGENTS.md"));

		const result = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "first-snapshot",
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		expect(contentText(result)).toContain("PKG_RULES");
	} finally {
		await tree.cleanup();
	}
});

test("recovers delivery when a downstream handler replaces the injected tool result", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "PKG_RULES", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const injected = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-strip",
			toolName: "shell_runner",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		expect(contentText(injected)).toContain("PKG_RULES");

		// A later extension replaced the result before the transcript was saved.
		const strippedTranscript = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-strip", name: "shell_runner", arguments: { path: tree.path("pkg/file.ts") } }],
				timestamp: 1,
			},
			{
				role: "toolResult",
				toolCallId: "call-strip",
				toolName: "shell_runner",
				content: [{ type: "text", text: "x" }],
				isError: false,
				timestamp: 2,
			},
		];
		const recovered = (await fake.emit("context", { messages: strippedTranscript })) as {
			messages: Array<{ role: string; content: unknown }>;
		};
		const recoveredText = JSON.stringify(recovered.messages);
		expect(recoveredText).toContain("PKG_RULES");
		expect(recovered.messages.at(-1)?.role).toBe("custom");
	} finally {
		await tree.cleanup();
	}
});

test("does not re-deliver a tool-result injection after its header reaches the transcript", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "PKG_RULES", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const injected = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-confirm",
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		expect(contentText(injected)).toContain("PKG_RULES");

		const finalTranscript = [
			{
				role: "toolResult",
				toolCallId: "call-confirm",
				content: [{ type: "text", text: contentText(injected) }],
			},
		];

		expect(await fake.emit("context", { messages: finalTranscript })).toBeUndefined();
	} finally {
		await tree.cleanup();
	}
});

test("does not retain stale sweep files after compaction without new tool calls", async () => {
	const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root, { sessionFile: "/tmp/compact-stale-sweep.jsonl" });
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const swept = await fake.emit("context", {
			messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }] }],
		});
		expect(swept).toBeDefined();
		await fake.emit("session_compact", {});

		expect(await fake.emit("context", { messages: [] })).toBeUndefined();
	} finally {
		await tree.cleanup();
	}
});

test("does not retain stale sweep files after shutdown without new tool calls", async () => {
	const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root, { sessionFile: "/tmp/shutdown-stale-sweep.jsonl" });
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const swept = await fake.emit("context", {
			messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }] }],
		});
		expect(swept).toBeDefined();
		await fake.emit("session_shutdown", {});

		expect(await fake.emit("context", { messages: [] })).toBeUndefined();
	} finally {
		await tree.cleanup();
	}
});

test("recovers delivery when transcript messages or blocks are malformed", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "PKG_RULES", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const injected = await fake.emit("tool_result", {
			type: "tool_result",
			toolCallId: "call-malformed",
			toolName: "read",
			input: { path: tree.path("pkg/file.ts") },
			content: [{ type: "text", text: "x" }],
			isError: false,
		});
		expect(contentText(injected)).toContain("PKG_RULES");

		const recovered = (await fake.emit("context", {
			messages: [
				null,
				{ role: "assistant", content: [null] },
				{ role: "toolResult", content: "not an array" },
			],
		})) as { messages: Array<{ role: string; content: string }> };
		expect(recovered.messages.at(-1)?.role).toBe("custom");
		expect(recovered.messages.at(-1)?.content).toContain("PKG_RULES");
	} finally {
		await tree.cleanup();
	}
});

test("preserves non-sweep custom messages while rebuilding the sweep message", async () => {
	const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root);
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});

		const preserved = { role: "user", customType: "ancestor-agentsmd", content: "keep this" };
		const result = (await fake.emit("context", {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "call-filter", arguments: { path: "tests/helper.ts" } }],
				},
				preserved,
			],
		})) as { messages: unknown[] };
		expect(result.messages).toContain(preserved);
		expect(result.messages).toHaveLength(3);
	} finally {
		await tree.cleanup();
	}
});

test("clears pending sweep files during compaction", async () => {
	const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root, { sessionFile: "/tmp/compact-pending.jsonl" });
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});
		await fake.emit("context", {
			messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }] }],
		});

		await fake.emit("session_compact", {});
		expect(await fake.emit("context", { messages: [] })).toBeUndefined();
	} finally {
		await tree.cleanup();
	}
});

test("clears pending sweep files during shutdown", async () => {
	const tree = await makeTree({ "tests/AGENTS.md": "tests rules", "tests/helper.ts": "helper" });
	try {
		const extension = await loadExtension();
		const fake = makeFakePi(tree.root, { sessionFile: "/tmp/shutdown-pending.jsonl" });
		extension(fake.pi as unknown as ExtensionAPI);
		await fake.emit("session_start", {});
		await fake.emit("context", {
			messages: [{ role: "assistant", content: [{ type: "toolCall", arguments: { path: "tests/helper.ts" } }] }],
		});

		await fake.emit("session_shutdown", {});
		expect(await fake.emit("context", { messages: [] })).toBeUndefined();
	} finally {
		await tree.cleanup();
	}
});

test("uses the same complete scoped envelope for tool results and fallback context", async () => {
	const tree = await makeTree({ "pkg/AGENTS.md": "Package-only rules", "pkg/file.ts": "x" });
	try {
		const extension = await loadExtension();
		const normal = makeFakePi(tree.root, { sessionFile: "/tmp/envelope-normal.jsonl" });
		const fallback = makeFakePi(tree.root, { sessionFile: "/tmp/envelope-fallback.jsonl" });
		extension(normal.pi as unknown as ExtensionAPI);
		extension(fallback.pi as unknown as ExtensionAPI);
		await normal.emit("session_start", {});
		await fallback.emit("session_start", {});
		const injected = await normal.emit("tool_result", readEvent(tree.path("pkg/file.ts")));
		// SAFETY: The actual context handler returns messages; this narrows the fake API's unknown event boundary.
		const swept = await fallback.emit("context", {
			messages: [{ role: "assistant", content: [{ type: "toolCall", id: "envelope-read", arguments: { path: "pkg/file.ts" } }] }],
		}) as { messages: Array<{ role: string; content: string }> };
		const envelope = swept.messages.at(-1)?.content;
		expect(envelope).toContain("complete file contents are already loaded");
		expect(envelope).toContain('scope="' + tree.path("pkg") + path.sep + '"');
		expect(contentText(injected)).toBe(envelope + "\nfile content");
	} finally {
		await tree.cleanup();
	}
});
