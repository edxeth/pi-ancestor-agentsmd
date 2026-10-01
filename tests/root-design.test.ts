import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { buildRootDesignCapture } from "../src/root-design.js";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { Type } from "typebox";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

const SNAPSHOT_ENTRY_TYPE = "ancestor-agentsmd:root-design-snapshot";

type Payload = {
	system?: unknown;
	messages?: Array<{ role: string; content: unknown }>;
};

type SessionEntryRecord = {
	id?: string;
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string };
};

async function loadExtension() {
	return (await import("../src/index.js")).default;
}

/**
 * The real installed pi-better-skills extension, for composition verification
 * only (test-time sibling; never a runtime dependency of the extension).
 */
// SAFETY: the non-literal specifier keeps the sibling repo out of this repo's
// type graph; the cast documents the expected extension factory shape.
async function betterSkillsFactory(): Promise<(pi: ExtensionAPI) => void> {
	const sibling = new URL("../../pi-better-skills/src/index.ts", import.meta.url).pathname;
	const module = (await import(sibling)) as { default: (pi: ExtensionAPI) => void };
	return module.default;
}

const betterSkillsInstalled = existsSync(new URL("../../pi-better-skills/package.json", import.meta.url));

function fakeSseResponse(requestIndex: number) {
	const events = [
		{ type: "message_start", message: { id: `fixture-${requestIndex}`, model: "prefix-test", usage: { input_tokens: 1, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "Test reasoning.", signature: `fixture-signature-${requestIndex}` } },
		{ type: "content_block_stop", index: 0 },
		{ type: "content_block_start", index: 1, content_block: { type: "text", text: "Done." } },
		{ type: "content_block_stop", index: 1 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** A tool-call turn for the registered fixture_noop tool, ending the turn for execution. */
function fakeToolUseSseResponse(requestIndex: number) {
	const events = [
		{ type: "message_start", message: { id: `fixture-${requestIndex}`, model: "prefix-test", usage: { input_tokens: 1, output_tokens: 1 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu-fixture-${requestIndex}`, name: "fixture_noop", input: {} } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } },
		{ type: "message_stop" },
	];
	const body = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

type Harness = {
	root: string;
	captures: Payload[];
	setDesignContent: (content: string) => Promise<void>;
	removeDesign: () => Promise<void>;
	prompt: (text: string) => Promise<void>;
	sendIdleHelperResult: () => Promise<void>;
	compactDroppingAllSnapshots: () => Promise<void>;
	navigateTreeTo: (targetId: string) => Promise<void>;
	forkFromCurrentLeaf: (targetId?: string) => Promise<void>;
	resume: () => Promise<void>;
	readSessionEntries: () => Promise<SessionEntryRecord[]>;
	dispose: () => Promise<void>;
};

async function startHarness(
	options: {
		designContent?: string;
		rootDesignEnabled?: boolean;
		forcedCompaction?: boolean;
		toolCallOnRequest?: number;
		/** Public session_start handler that persists a hidden custom message before the first prompt. */
		earlyCustomMessage?: boolean;
		/** A foreign extension that returns a forced systemPrompt from before_agent_start. */
		forcedPrompt?: boolean;
		/** Occupy the design path with a directory before the session starts. */
		designPathOccupied?: boolean;
		/** Register the probe before this extension (controls session_start order). */
		probeFirst?: boolean;
		/** Load the real installed pi-better-skills extension alongside this one. */
		skillsOrder?: "skills-first" | "ancestor-first";
	} = {},
) {
	const root = await mkdtemp(path.join(tmpdir(), "paa-root-design-"));
	const agentDir = path.join(root, "agent");
	const sessionsDir = path.join(root, "sessions");
	await mkdir(agentDir, { recursive: true });

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousRootDesign = process.env.PI_ROOT_DESIGN_MD;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_ROOT_DESIGN_MD = options.rootDesignEnabled === false ? "0" : "1";

	if (options.designPathOccupied) {
		await mkdir(path.join(root, "DESIGN.md"));
	} else if (options.designContent !== undefined) {
		await writeFile(path.join(root, "DESIGN.md"), options.designContent, "utf8");
	}

	let requestCount = 0;
	const captures: Payload[] = [];
	const probe = (pi: ExtensionAPI) => {
		pi.on("before_provider_request", (event) => {
			captures.push(structuredClone(event.payload) as Payload);
		});
		if (options.forcedPrompt) {
			// The common forcing shape: a prompt derived from pi's own rendered
			// prompt (event.systemPrompt), which the payload safeguard recognizes.
			pi.on("before_agent_start", (event) => ({
				systemPrompt: (event as { systemPrompt: string }).systemPrompt + "\n\nFORCED OVERRIDE",
			}));
		}
		if (options.earlyCustomMessage) {
			pi.on("session_start", () => {
				pi.sendMessage({ customType: "early_note", content: "EARLY-CUSTOM-NOTE", display: false }, { triggerTurn: false });
			});
		}
		if (options.toolCallOnRequest !== undefined) {
			pi.registerTool({
				name: "fixture_noop",
				label: "Fixture noop",
				description: "Returns a fixed confirmation.",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "FIXTURE-TOOL-OK" }], details: {} }),
			});
		}
		if (options.forcedCompaction) {
			// Deterministic extension compaction: keep everything after the last
			// snapshot, so every recorded snapshot is summarized away and the
			// effective context loses its guidance without any token heuristics.
			pi.on("session_before_compact", (_event, ctx) => {
				const entries = ctx.sessionManager.getEntries();
				let lastSnapshotIndex = -1;
				for (const [index, entry] of entries.entries()) {
					if (entry.type === "custom" && (entry as { customType?: unknown }).customType === SNAPSHOT_ENTRY_TYPE) {
						lastSnapshotIndex = index;
					}
				}
				const keep = entries[lastSnapshotIndex + 1];
				if (!keep) return undefined;
				return { compaction: { summary: "Compacted away the design snapshot.", firstKeptEntryId: keep.id, tokensBefore: 100 } };
			});
		}
	};

	const model: Model<"anthropic-messages"> = {
		id: "prefix-test",
		name: "Prefix test",
		api: "anthropic-messages" as const,
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 1024,
		compat: { supportsMidConvoSystemMessages: true, supportsMidConvoEffort: true, forceAdaptiveThinking: true },
	};

	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const base: Provider = anthropicProvider();
	const offlineFetch = (async () => {
		requestCount += 1;
		return requestCount === options.toolCallOnRequest
			? fakeToolUseSseResponse(requestCount)
			: fakeSseResponse(requestCount);
	}) as unknown as typeof fetch;
	runtime.registerNativeProvider({
		...base,
		getModels: () => [model as Model<Api>],
		streamSimple: (m, c, o) => base.streamSimple(m, c, { ...o, cacheRetention: "none", fetch: offlineFetch }),
	});
	await runtime.setRuntimeApiKey("anthropic", "offline-test-key");

	const settings = SettingsManager.inMemory({
		compaction: {
			enabled: false,
			// With forced compaction, shrink the keep-recent window so the small
			// fixture session still has summarizeable history; the probe hook
			// supplies the summary, so no summarization request is sent.
			...(options.forcedCompaction ? { keepRecentTokens: 1 } : {}),
		},
		retry: { enabled: false },
		cacheWarming: "off",
	});
	const extensionFactories = [await loadExtension()];
	if (options.skillsOrder) {
		const skills = await betterSkillsFactory();
		if (options.skillsOrder === "skills-first") extensionFactories.unshift(skills);
		else extensionFactories.push(skills);
	}
	if (options.probeFirst) extensionFactories.unshift(probe);
	else extensionFactories.push(probe);

	/**
	 * Fresh resource loader per session binding: a disposed AgentSession
	 * invalidates its loader's extension runtime, so reusing one loader across
	 * session replacement would poison every later binding with a stale
	 * extension context. Real pi loads extensions once per process; this
	 * harness replaces sessions, so each binding gets its own loader.
	 */
	async function createBoundSession(
		sessionFile?: string,
		bindOptions?: { sessionManager?: SessionManager; sessionStartEvent?: { type: "session_start"; reason: "fork" | "resume" | "startup" | "new" | "reload"; previousSessionFile?: string } },
	) {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir,
			settingsManager: settings,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories,
		});
		await loader.reload();
		if (loader.getExtensions().errors.length > 0) {
			throw new Error(`extension load errors: ${JSON.stringify(loader.getExtensions().errors)}`);
		}
		const { session: created } = await createAgentSession({
			cwd: root,
			agentDir,
			model,
			modelRuntime: runtime,
			resourceLoader: loader,
			settingsManager: settings,
			sessionManager: bindOptions?.sessionManager
				? bindOptions.sessionManager
				: sessionFile
					? SessionManager.open(sessionFile, sessionsDir)
					: SessionManager.create(root, sessionsDir),
			...(bindOptions?.sessionStartEvent ? { sessionStartEvent: bindOptions.sessionStartEvent } : {}),
			thinkingLevel: "high",
		});
		await created.bindExtensions({});
		return created;
	}

	let session = await createBoundSession();



	const harness: Harness = {
		root,
		captures,
		setDesignContent: async (content) => {
			await rm(path.join(root, "DESIGN.md"), { recursive: true, force: true });
			await writeFile(path.join(root, "DESIGN.md"), content, "utf8");
		},
		removeDesign: async () => {
			await rm(path.join(root, "DESIGN.md"), { force: true });
		},
		prompt: (text) => session.prompt(text),
		sendIdleHelperResult: async () => {
			await session.sendCustomMessage(
				{ customType: "subagent_result", content: "Background helper completed.", display: false },
				{ triggerTurn: true, deliverAs: "steer" },
			);
		},
		compactDroppingAllSnapshots: async () => {
			await session.compact();
		},
		navigateTreeTo: async (targetId) => {
			await session.navigateTree(targetId);
		},
		forkFromCurrentLeaf: async (targetId?: string) => {
			// The durable operation pi's runtime performs for /fork at an entry:
			// createBranchedSession mutates the persisted manager in place (the
			// file is written lazily), the same manager continues as the fork,
			// and session_start fires with reason "fork" plus the parent file.
			const previousSessionFile = session.sessionManager.getSessionFile();
			const entries = session.sessionManager.getEntries();
			const leaf = targetId ? entries.find((entry) => entry.id === targetId) : entries[entries.length - 1];
			if (!leaf) throw new Error("no entries to fork from");
			session.sessionManager.createBranchedSession(leaf.id);
			const forkManager = session.sessionManager;
			session.dispose();
			session = await createBoundSession(undefined, {
				sessionManager: forkManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			});
		},
		resume: async () => {
			// In-process session replacement over the same transcript file. All
			// snapshot state is derived from durable entries, so this is
			// equivalent to a cross-process resume for this feature.
			session.dispose();
			const files = (await readdir(sessionsDir)).filter((file) => file.endsWith(".jsonl"));
			if (files.length !== 1 || !files[0]) throw new Error(`expected one session file, found ${files.length}`);
			session = await createBoundSession(path.join(sessionsDir, files[0]));
		},
		readSessionEntries: async () => {
			const files = (await readdir(sessionsDir)).filter((file) => file.endsWith(".jsonl"));
			const entries: SessionEntryRecord[] = [];
			for (const file of files) {
				const raw = await readFile(path.join(sessionsDir, file), "utf8");
				for (const line of raw.split("\n")) {
					if (!line.trim()) continue;
					try {
						entries.push(JSON.parse(line) as SessionEntryRecord);
					} catch {
						// skip malformed lines
					}
				}
			}
			return entries;
		},
		dispose: async () => {
			try {
				session.dispose();
			} catch {
				// Cleanup must finish even when the runtime rejects disposal.
			}
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousRootDesign === undefined) delete process.env.PI_ROOT_DESIGN_MD;
			else process.env.PI_ROOT_DESIGN_MD = previousRootDesign;
			await rm(root, { recursive: true, force: true });
		},
	};
	return harness;
}

/** The Nth captured provider payload; names the gap in the failure message when absent. */
function captureAt(captures: Payload[], index: number): Payload {
	const payload = captures[index];
	if (!payload) throw new Error(`missing capture ${index}; got ${captures.length} captures`);
	return payload;
}

/** The persisted data of the Nth snapshot entry; names the gap when absent. */
function snapshotDataAt(snapshots: SessionEntryRecord[], index: number): Record<string, unknown> {
	const data = snapshots[index]?.data;
	if (typeof data !== "object" || data === null) throw new Error(`snapshot entry ${index} carries no data object`);
	// SAFETY: the guard proves the persisted entry data is an object; the
	// extension serialized it, so field-level assertions run on real values.
	return data as Record<string, unknown>;
}

/** Collect text of every mid-conversation system block on the wire. */
function systemBlockTexts(payload: Payload) {
	const texts: string[] = [];
	for (const message of payload.messages ?? []) {
		if (message.role !== "system") continue;
		if (typeof message.content === "string") {
			texts.push(message.content);
		} else if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if (typeof block === "object" && block !== null && "text" in block) {
					texts.push(String((block as { text: unknown }).text));
				}
			}
		}
	}
	return texts;
}

function replayedSignature(payload: Payload) {
	for (const message of payload.messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "thinking") {
				return (block as { signature?: unknown }).signature;
			}
		}
	}
	return undefined;
}

describe("root DESIGN.md durable delivery", () => {
	/** Wire text of every captured payload, for marker presence checks. */
	const wireText = (payload: Payload) => JSON.stringify(payload);

	test("captures the design once and keeps it fixed across edits, deletion, and continuations", async () => {
		const v1 = "ROOT-DESIGN-FIXED-V1";
		const v2 = "ROOT-DESIGN-FIXED-V2-NEVER-DELIVERED";
		const harness = await startHarness({ designContent: v1, toolCallOnRequest: 3 });
		try {
			await harness.prompt("Begin.");
			await harness.setDesignContent(v2);
			await harness.sendIdleHelperResult();
			await harness.prompt("Continue.");

			// Request 3 carries the fixture tool call, so its continuation adds one.
			expect(harness.captures.length).toBe(4);
			for (const [index, capture] of harness.captures.entries()) {
				expect({ request: index, hasV1: wireText(capture).includes(v1) }).toEqual({ request: index, hasV1: true });
				expect({ request: index, hasV2: wireText(capture).includes(v2) }).toEqual({ request: index, hasV2: false });
			}

			// Append-only wire: nothing before the replayed history is rewritten.
			for (let i = 1; i < harness.captures.length; i++) {
				const previous = captureAt(harness.captures, i - 1).messages ?? [];
				const next = captureAt(harness.captures, i).messages ?? [];
				expect({ request: i, prefix: next.slice(0, previous.length) }).toEqual({ request: i, prefix: previous });
			}
			expect(replayedSignature(captureAt(harness.captures, 2))).toBe("fixture-signature-1");

			// The section rides ON the leading declaration: the top-level system
			// param carries it and no mid-conversation system block duplicates it.
			for (const [index, capture] of harness.captures.entries()) {
				const midConversationBlocks = systemBlockTexts(capture).filter((text) => text.includes(v1));
				const headText = JSON.stringify(capture.system ?? "");
				expect({ request: index, inHead: headText.includes(v1), midConversation: midConversationBlocks.length }).toEqual({
					request: index,
					inHead: true,
					midConversation: 0,
				});
			}

			// Deleting the file mid-session does not clear the fixed guidance.
			await harness.removeDesign();
			await harness.prompt("After deletion.");
			expect(harness.captures.length).toBe(5);
			expect(wireText(captureAt(harness.captures, 4)).includes(v1)).toBe(true);
			const previous = captureAt(harness.captures, 3).messages ?? [];
			const next = captureAt(harness.captures, 4).messages ?? [];
			expect({ prefix: next.slice(0, previous.length) }).toEqual({ prefix: previous });

			// Exactly one capture entry exists on the session.
			const captures = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(captures.length).toBe(1);
			expect(snapshotDataAt(captures, 0).content).toBe(v1);
		} finally {
			await harness.dispose();
		}
	});

	test("freezes the empty state so a file created mid-session cannot change the head", async () => {
		const v2 = "ROOT-DESIGN-CREATED-LATER";
		const harness = await startHarness({});
		try {
			await harness.prompt("Begin.");
			await harness.setDesignContent(v2);
			await harness.sendIdleHelperResult();
			await harness.prompt("Continue.");

			for (const [index, capture] of harness.captures.entries()) {
				expect({ request: index, hasDesign: wireText(capture).includes("design_system") }).toEqual({
					request: index,
					hasDesign: false,
				});
			}
			const captures = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(captures.length).toBe(1);
			expect(snapshotDataAt(captures, 0).block).toBe("");
		} finally {
			await harness.dispose();
		}
	});

	test("a fresh session captures the current file", async () => {
		const v2 = "ROOT-DESIGN-FRESH-SESSION-V2";
		const harness = await startHarness({ designContent: v2 });
		try {
			await harness.prompt("Begin.");
			expect(wireText(captureAt(harness.captures, 0)).includes(v2)).toBe(true);
		} finally {
			await harness.dispose();
		}
	});

	test("resume keeps the captured value and ignores later file edits", async () => {
		const v1 = "ROOT-DESIGN-RESUME-V1";
		const v2 = "ROOT-DESIGN-RESUME-V2-IGNORED";
		const harness = await startHarness({ designContent: v1 });
		try {
			await harness.prompt("Begin.");
			const beforeResume = wireText(captureAt(harness.captures, 0));
			await harness.resume();
			await harness.setDesignContent(v2);
			await harness.prompt("After resume.");

			const after = captureAt(harness.captures, 1);
			expect(wireText(after).includes(v1)).toBe(true);
			expect(wireText(after).includes(v2)).toBe(false);
			// The projection rebuilds from the durable capture across the restart.
			const before = captureAt(harness.captures, 0).messages ?? [];
			const next = after.messages ?? [];
			expect({ prefix: next.slice(0, before.length) }).toEqual({ prefix: before });
			expect(beforeResume).not.toBe("");
		} finally {
			await harness.dispose();
		}
	});

	test("fork keeps the captured value and ignores later file edits", async () => {
		const v1 = "ROOT-DESIGN-FORK-V1";
		const v2 = "ROOT-DESIGN-FORK-V2-IGNORED";
		const harness = await startHarness({ designContent: v1 });
		try {
			await harness.prompt("Begin.");
			await harness.forkFromCurrentLeaf();
			await harness.setDesignContent(v2);
			await harness.prompt("On the fork.");

			const forked = captureAt(harness.captures, 1);
			expect(wireText(forked).includes(v1)).toBe(true);
			expect(wireText(forked).includes(v2)).toBe(false);
		} finally {
			await harness.dispose();
		}
	});

	test("compaction keeps the captured value", async () => {
		const v1 = "ROOT-DESIGN-COMPACTION-V1";
		const harness = await startHarness({ designContent: v1, forcedCompaction: true });
		try {
			await harness.prompt("Begin.");
			const preCompactionRequests = harness.captures.length;
			await harness.compactDroppingAllSnapshots();
			await harness.prompt("After compaction.");

			expect(harness.captures.length).toBe(preCompactionRequests + 1);
			const after = captureAt(harness.captures, harness.captures.length - 1);
			expect(wireText(after).includes(v1)).toBe(true);
		} finally {
			await harness.dispose();
		}
	});

	test("tree navigation before the capture keeps the original session value", async () => {
		const v1 = "ROOT-DESIGN-TREE-V1";
		const v2 = "ROOT-DESIGN-TREE-V2-IGNORED";
		// The early custom message is persisted before the capture, so tree
		// navigation to it selects an ancestry that excludes the capture entry.
		const harness = await startHarness({ designContent: v1, earlyCustomMessage: true, probeFirst: true });
		try {
			await harness.prompt("Begin.");
			await harness.setDesignContent(v2);
			const entries = await harness.readSessionEntries();
			const early = entries.find((entry) => entry.type === "custom_message");
			if (!early?.id) throw new Error("no early custom message persisted");
			await harness.navigateTreeTo(early.id);
			await harness.prompt("Continue from early note.");

			// The fixed session value survives: V1 on the wire, never V2, and no
			// reread produced a different value.
			const after = captureAt(harness.captures, 1);
			expect(JSON.stringify(after.system)).toContain(v1);
			expect(JSON.stringify(after.system)).not.toContain(v2);

			// The original capture is recovered onto the selected ancestry as an
			// identical copy, so later forks and resumes retain the same value.
			const captures = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(captures.length).toBe(2);
			for (const entry of captures) {
				expect(snapshotDataAt(captures, captures.indexOf(entry)).content).toBe(v1);
			}
		} finally {
			await harness.dispose();
		}
	});

	test("fork at an early entry inherits the parent capture before any file read", async () => {
		// One immutable value per session lineage: a fork whose copied ancestry
		// excludes the parent's capture inherits the parent's durable value, or
		// the parent's frozen empty state — never the current file.
		const cases = [
			{ name: "value capture", parentSetup: { designContent: "FORK-FIXED-V1" }, changed: "FORK-CHANGED-V2-IGNORED" },
			{ name: "empty capture", parentSetup: { designContent: "ROOT-DESIGN-UNFROZEN", rootDesignEnabled: false }, changed: "ROOT-DESIGN-UNFROZEN" },
		];
		for (const { name, parentSetup, changed } of cases) {
			const harness = await startHarness({ ...parentSetup, earlyCustomMessage: true, probeFirst: true });
			try {
				await harness.prompt("Begin.");
				const entries = await harness.readSessionEntries();
				const early = entries.find((entry) => entry.type === "custom_message");
				if (!early?.id) throw new Error(`[${name}] no early custom message persisted`);
				await harness.setDesignContent(changed);
				await harness.navigateTreeTo(early.id);
				await harness.forkFromCurrentLeaf(early.id);
				await harness.prompt("First prompt on fork.");

				const forked = captureAt(harness.captures, harness.captures.length - 1);
				const parentValue = parentSetup.rootDesignEnabled === false ? "" : parentSetup.designContent;
				if (parentValue !== "") {
					expect({ name, hasParent: wireText(forked).includes(parentValue) }).toEqual({ name, hasParent: true });
				}
				expect({ name, hasChanged: wireText(forked).includes(changed) }).toEqual({ name, hasChanged: false });

				// The inherited value is re-anchored on the fork's ancestry.
				const forkEntries = (await harness.readSessionEntries()).filter(
					(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
				);
				const values = forkEntries.map((entry) => (entry.data as { content?: unknown } | undefined)?.content);
				expect({ name, values }).toEqual({ name, values: [parentValue, parentValue] });
			} finally {
				await harness.dispose();
			}
		}
	});

	test("freezes the empty state when the feature starts disabled; enabling mid-session adds nothing", async () => {
		const marker = "ROOT-DESIGN-ENABLED-LATER";
		const harness = await startHarness({ designContent: marker, rootDesignEnabled: false });
		try {
			await harness.prompt("Begin.");
			await harness.sendIdleHelperResult();

			// Exactly one empty capture; no root-design injection debug event.
			const captures = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(captures.length).toBe(1);
			expect(snapshotDataAt(captures, 0).block).toBe("");
			const injectedEvents = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === "ancestor-agentsmd:context-file-event",
			);
			expect(injectedEvents).toEqual([]);

			// Enabling the feature mid-session cannot change the frozen session.
			const previousEnv = process.env.PI_ROOT_DESIGN_MD;
			process.env.PI_ROOT_DESIGN_MD = "1";
			try {
				await harness.prompt("Continue.");
			} finally {
				if (previousEnv === undefined) delete process.env.PI_ROOT_DESIGN_MD;
				else process.env.PI_ROOT_DESIGN_MD = previousEnv;
			}
			for (const capture of harness.captures) {
				expect(wireText(capture).includes(marker)).toBe(false);
			}
			const capturesAfter = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(capturesAfter.length).toBe(1);

			// A fresh session picks the file up.
			const fresh = await startHarness({ designContent: marker });
			try {
				await fresh.prompt("Fresh session.");
				expect(wireText(captureAt(fresh.captures, 0)).includes(marker)).toBe(true);
			} finally {
				await fresh.dispose();
			}
		} finally {
			await harness.dispose();
		}
	});

	test("freezes the empty state when the design path is unreadable at start; repair needs a new session", async () => {
		const v1 = "ROOT-DESIGN-AFTER-REPAIR";
		const harness = await startHarness({ designPathOccupied: true });
		try {
			await harness.prompt("Begin.");

			const captures = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(captures.length).toBe(1);
			expect(snapshotDataAt(captures, 0).block).toBe("");

			// Repair the file mid-session: the frozen session stays without guidance.
			await harness.setDesignContent(v1);
			await harness.prompt("Continue.");
			for (const capture of harness.captures) {
				expect(wireText(capture).includes(v1)).toBe(false);
			}
			const capturesAfter = (await harness.readSessionEntries()).filter(
				(entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY_TYPE,
			);
			expect(capturesAfter.length).toBe(1);

			// A fresh session picks the repaired file up.
			const fresh = await startHarness({ designContent: v1 });
			try {
				await fresh.prompt("Fresh session.");
				expect(wireText(captureAt(fresh.captures, 0)).includes(v1)).toBe(true);
			} finally {
				await fresh.dispose();
			}
		} finally {
			await harness.dispose();
		}
	});

	test("feature state is fixed within a captured session", async () => {
		const v1 = "ROOT-DESIGN-TOGGLE-V1";
		const harness = await startHarness({ designContent: v1 });
		try {
			await harness.prompt("Begin.");
			const previousEnv = process.env.PI_ROOT_DESIGN_MD;
			process.env.PI_ROOT_DESIGN_MD = "0";
			try {
				await harness.prompt("Disabled turn.");
			} finally {
				if (previousEnv === undefined) delete process.env.PI_ROOT_DESIGN_MD;
				else process.env.PI_ROOT_DESIGN_MD = previousEnv;
			}
			// The captured session keeps its fixed guidance even with the feature off.
			expect(wireText(captureAt(harness.captures, 1)).includes(v1)).toBe(true);
		} finally {
			await harness.dispose();
		}
	});

	test("keeps the top-level system declaration when early custom messages precede it", async () => {
		const v1 = "ROOT-DESIGN-EARLY-CUSTOM";
		const harness = await startHarness({ designContent: v1, earlyCustomMessage: true });
		const control = await startHarness({ designContent: v1 });
		try {
			await control.prompt("Begin.");
			await harness.prompt("Begin.");

			const entries = await harness.readSessionEntries();
			const customEntry = entries.find((entry) => entry.type === "custom_message");
			expect(JSON.stringify(customEntry)).toContain("EARLY-CUSTOM-NOTE");

			const withEarly = captureAt(harness.captures, 0);
			const withoutEarly = captureAt(control.captures, 0);
			// The original declaration still opens the request as the top-level
			// system prompt, identical apart from the per-fixture cwd.
			const normalize = (payload: Payload, root: string) => JSON.stringify(payload.system).split(root).join("<root>");
			expect(normalize(withEarly, harness.root)).toBe(normalize(withoutEarly, control.root));
			expect(normalize(withEarly, harness.root)).toContain("You are an expert coding assistant");
			expect(wireText(withEarly).includes(v1)).toBe(true);
		} finally {
			await harness.dispose();
			await control.dispose();
		}
	});

	test("keeps the section on the final payload through a foreign forced prompt", async () => {
		const v1 = "ROOT-DESIGN-FORCED-PROMPT";
		const harness = await startHarness({ designContent: v1, forcedPrompt: true, toolCallOnRequest: 2 });
		try {
			await harness.prompt("Begin.");
			await harness.sendIdleHelperResult();
			await harness.prompt("Continue.");

			// The idle helper turn calls the fixture tool, so its continuation
			// adds a request: normal, idle, tool continuation, next user.
			expect(harness.captures.length).toBe(4);
			// Every request — normal, idle helper, tool continuation — carries the
			// section exactly once despite the forced head on user turns.
			for (const [index, capture] of harness.captures.entries()) {
				const blocks = systemBlockTexts(capture).filter((text) => text.includes(v1));
				const headBlocks = JSON.stringify(capture.system ?? "").split(v1).length - 1;
				expect({ request: index, headBlocks, messageBlocks: blocks.length }).toEqual({
					request: index,
					headBlocks: 1,
					messageBlocks: 0,
				});
			}
			expect(JSON.stringify(captureAt(harness.captures, 0).system)).toContain("FORCED OVERRIDE");
		} finally {
			await harness.dispose();
		}
	});

	test("payload safeguard covers cached instruction text blocks from the real openai-completions serializer", async () => {
		const { stream } = await import("@earendil-works/pi-ai/api/openai-completions");
		const extension = await loadExtension();
		const handlers = new Map<string, (event: { payload: unknown }, ctx: unknown) => unknown>();
		const pi = {
			on: (event: string, handler: (event: { payload: unknown }, ctx: unknown) => unknown) => handlers.set(event, handler),
			registerFlag() {},
			registerCommand() {},
		};
		extension(pi as unknown as ExtensionAPI);
		const captured = buildRootDesignCapture("/project/DESIGN.md", "CACHED-ROOT-V1");
		const ctx = {
			cwd: "/project",
			sessionManager: {
				getSessionFile: () => "/tmp/completions-review.jsonl",
				getBranch: () => [
					{
						type: "custom",
						id: "capture",
						parentId: null,
						timestamp: "2026-09-30T00:00:00Z",
						customType: SNAPSHOT_ENTRY_TYPE,
						data: captured,
					},
				],
			},
		};
		const model = {
			id: "anthropic/claude-haiku-4.5",
			name: "SDK cache-shape fixture",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://example.invalid/v1",
			reasoning: false,
			input: ["text" as const],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 1000,
		};
		let payload: Payload | undefined;
		const sse =
			'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"Done."},"finish_reason":null}]}\n\n' +
			'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
			"data: [DONE]\n\n";
		const output = stream(
			model as never,
			{
				messages: [
					{ role: "system", content: "Pi forced prompt\n\n<cwd>\n/project\n</cwd>", timestamp: 1 },
					{ role: "user", content: "hi", timestamp: 2 },
				],
			} as never,
			{
				apiKey: "offline-test-key",
				maxRetries: 0,
				cacheRetention: "short",
				onPayload: async (p: unknown) => {
					await handlers.get("before_provider_request")?.({ payload: p }, ctx);
					payload = structuredClone(p) as Payload;
					return p;
				},
				fetch: async () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
			} as never,
		);
		const result = await output.result();
		if (result.stopReason === "error") throw new Error(result.errorMessage ?? "stream error");

		// OpenRouter-Anthropic caching converted the leading instruction into a
		// cached text-block array; the safeguard must find the pi-built block
		// there and append the captured section without touching cache metadata
		// or the user message.
		const head = payload?.messages?.[0] as { role: string; content: Array<{ type: string; text: string; cache_control?: unknown }> } | undefined;
		expect(head?.role === "system" || head?.role === "developer").toBe(true);
		expect(Array.isArray(head?.content)).toBe(true);
		const promptBlock = head?.content?.find((part) => part.text.includes("<cwd>"));
		expect(promptBlock?.text.endsWith(captured.block)).toBe(true);
		expect(promptBlock?.cache_control).toBeDefined();
		// JSON.stringify escapes the block's newlines; count the escaped form.
		const escapedBlock = JSON.stringify(captured.block).slice(1, -1);
		expect(JSON.stringify(payload?.messages ?? []).split(escapedBlock).length - 1).toBe(1);
	});

	test("composes with pi-better-skills in both load orders without duplication", async () => {
		if (!betterSkillsInstalled) {
			console.log("pi-better-skills not installed; composition test skipped");
			return;
		}
		const v1 = "ROOT-DESIGN-COMPOSITION-V1";
		for (const order of ["skills-first", "ancestor-first"] as const) {
			const harness = await startHarness({
				designContent: v1,
				forcedPrompt: true,
				skillsOrder: order,
			});
			try {
				await harness.prompt("Begin.");
				await harness.sendIdleHelperResult();
				await harness.prompt("Continue.");

				expect(harness.captures.length).toBe(3);
				for (const [index, capture] of harness.captures.entries()) {
					const text = wireText(capture);
					const promptDriven = index !== 1; // the idle helper turn skips before_agent_start
					expect({ order, request: index, designBlocks: text.split(v1).length - 1 }).toEqual({
						order,
						request: index,
						designBlocks: 1,
					});
					expect({ order, request: index, skillBlocks: text.split("<agent_skills>").length - 1 }).toEqual({
						order,
						request: index,
						skillBlocks: 1,
					});
					expect({ order, request: index, forced: text.includes("FORCED OVERRIDE") }).toEqual({
						order,
						request: index,
						forced: promptDriven,
					});
				}
			} finally {
				await harness.dispose();
			}
		}
	});
});
