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

	test("places AGENTS.md above DESIGN.md for generic tool results", async () => {
		const previous = process.env.PI_ANCESTOR_DESIGN_MD;
		process.env.PI_ANCESTOR_DESIGN_MD = "1";
		const tree = await makeTree({
			"src/AGENTS.md": "agent rules",
			"src/DESIGN.md": "design rules",
			"src/file.ts": "file content",
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
				content: [{ type: "text", text: "file content" }],
				isError: false,
			});
			const text = contentText(result);
			expect(text.indexOf("agent rules")).toBeLessThan(text.indexOf("design rules"));
			expect(text.indexOf("design rules")).toBeLessThan(text.indexOf("file content"));
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

	test("records when a tool-result context file was truncated", async () => {
		const tree = await makeTree({
			"src/AGENTS.md": "x".repeat(32 * 1024 + 1),
			"src/file.ts": "x",
		});
		try {
			const extension = await loadExtension();
			const fake = makeFakePi(tree.root);
			extension(fake.pi as unknown as ExtensionAPI);
			await fake.emit("session_start", {});
			await fake.emit("tool_result", readEvent(tree.path("src/file.ts")));
			await fake.runCommand("nested-context-files");

			expect(lastEntry(fake.entries)?.data).toMatchObject({
				files: [expect.objectContaining({ filepath: tree.path("src/AGENTS.md"), truncated: true })],
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
			expect(swept.content).toContain("Instructions from:");
			expect(swept.content).toContain("tests rules");

			// The transform is per-request; the same injection must re-append on the
			// next request without duplicating content inside the message.
			const second = (await fake.emit("context", { messages: [...transcript, swept] })) as {
				messages: Array<{ role: string; content: string }>;
			};
			expect(second.messages).toHaveLength(transcript.length + 2);
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
			expect(result.systemPrompt).toContain("Before reading or editing files under any of these paths");
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
