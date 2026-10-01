import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import type { CustomEntry, SessionEntry, SessionMessageEntry, SessionProjection } from "@earendil-works/pi-coding-agent";
import {
	buildRootDesignCapture,
	decideRootDesignCapture,
	injectRootDesignSection,
	latestBranchCapture,
	parseRootDesignSnapshot,
	readRootDesignFile,
	reassertRootDesignSection,
	ROOT_DESIGN_SECTION,
	type RootDesignFile,
	type RootDesignSnapshot,
} from "../src/root-design.js";
import { payloadSystemSlots } from "../src/payload-system-slots.js";

type ContextMessage = SessionProjection["messages"][number];
type ContextMessageList = SessionProjection["messages"];

function capture(content: string): RootDesignSnapshot {
	return buildRootDesignCapture("/proj/DESIGN.md", content);
}

/** Pi's normal head shape: structured prompt with a sections record. */
function system(text: string): ContextMessage {
	return { role: "system", content: "", sections: { preamble: text }, timestamp: 1 };
}

function user(text: string): ContextMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 2 };
}

function customMessage(text: string): ContextMessage {
	return { role: "custom", customType: "early_note", content: [{ type: "text", text }], display: false, timestamp: 3 };
}

/** Wrap one transcript message in its persisted session entry shape. */
function messageEntry(message: ContextMessage): SessionEntry {
	const entry: SessionMessageEntry = { id: `m-${Math.random()}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", type: "message", message };
	return entry;
}

function captureEntry(value: RootDesignSnapshot): SessionEntry {
	const entry: CustomEntry = {
		id: `c-${Math.random()}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		type: "custom",
		customType: "ancestor-agentsmd:root-design-snapshot",
		data: value,
	};
	return entry;
}

function sectionOf(messages: ContextMessageList | undefined): string | undefined {
	const head = messages?.[0];
	const value = head && head.role === "system" && head.sections ? head.sections[ROOT_DESIGN_SECTION] : undefined;
	return value === null ? undefined : value;
}

/** Narrow an injected list to its (system) head without non-null assertions. */
function injectedHead(messages: ContextMessageList | undefined): Extract<ContextMessage, { role: "system" }> | undefined {
	const head = messages?.[0];
	return head && head.role === "system" ? head : undefined;
}

describe("root design capture decision", () => {
	const filePresent = (content: string): RootDesignFile => ({ status: "present", path: "/proj/DESIGN.md", content });
	const fileMissing: RootDesignFile = { status: "missing" };
	const fileUnknown: RootDesignFile = { status: "unknown" };

	function recorded(decision: ReturnType<typeof decideRootDesignCapture>): RootDesignSnapshot | undefined {
		return decision.action === "record" ? decision.capture : undefined;
	}

	function decisionWarning(decision: ReturnType<typeof decideRootDesignCapture>): string | undefined {
		return decision.action === "record" ? decision.warning : undefined;
	}

	test("records the file value once when no capture exists", () => {
		const recordedCapture = recorded(decideRootDesignCapture(undefined, filePresent("CONTENT"), true, "/proj/DESIGN.md"));
		expect(recordedCapture?.content).toBe("CONTENT");
		expect(recordedCapture?.block).toContain("CONTENT");
	});

	test("never records again once a capture exists, whatever the file does", () => {
		const existing = capture("ORIGINAL");
		expect(decideRootDesignCapture(existing, filePresent("CHANGED"), true, "/proj/DESIGN.md").action).toBe("none");
		expect(decideRootDesignCapture(existing, fileMissing, true, "/proj/DESIGN.md").action).toBe("none");
		expect(decideRootDesignCapture(existing, fileUnknown, true, "/proj/DESIGN.md").action).toBe("none");
	});

	test("records the empty state for a confirmed-absent file so a later file cannot change this session", () => {
		const recordedCapture = recorded(decideRootDesignCapture(undefined, fileMissing, true, "/proj/DESIGN.md"));
		expect(recordedCapture?.content).toBe("");
		expect(recordedCapture?.block).toBe("");
		expect(recordedCapture?.path).toBe("/proj/DESIGN.md");
	});

	test("freezes the empty state with a warning when the file is unreadable, so repair needs a new session", () => {
		const decision = decideRootDesignCapture(undefined, fileUnknown, true, "/proj/DESIGN.md");
		const recordedCapture = recorded(decision);
		expect(recordedCapture?.block).toBe("");
		expect(decision.action === "record" && decision.warning).toContain("new session");
	});

	test("freezes the empty state when the feature starts disabled, even with a readable file", () => {
		const recordedCapture = recorded(decideRootDesignCapture(undefined, filePresent("CONTENT"), false, "/proj/DESIGN.md"));
		expect(recordedCapture?.block).toBe("");
		expect(recordedCapture?.content).toBe("");
		expect(decisionWarning(decideRootDesignCapture(undefined, filePresent("CONTENT"), false, "/proj/DESIGN.md"))).toBeUndefined();
	});
});

describe("root design capture parsing", () => {
	test("accepts a valid capture from branch entries", () => {
		const value = capture("CONTENT");
		const entries: SessionEntry[] = [captureEntry(value)];
		expect(latestBranchCapture(entries)).toEqual(value);
	});

	test("returns the last capture on the branch and ignores non-capture entries", () => {
		const entries: SessionEntry[] = [
			messageEntry(user("hello")),
			captureEntry(capture("FIRST")),
			messageEntry(user("more")),
		];
		expect(latestBranchCapture(entries)?.content).toBe("FIRST");
	});

	test("rejects malformed capture data", () => {
		const asEntry = (data: unknown) =>
			({
				type: "custom",
				customType: "ancestor-agentsmd:root-design-snapshot",
				data,
				id: "x",
				parentId: null,
				timestamp: "t",
			}) as CustomEntry;
		// SAFETY: asEntry builds deliberately malformed persistence payloads; the
		// parser must reject, never trust, untyped entry data.
		expect(parseRootDesignSnapshot(asEntry(capture("OK")))).toEqual(capture("OK"));
		expect(parseRootDesignSnapshot(asEntry({ ...capture("OK"), version: 2 }))).toBeUndefined();
		expect(parseRootDesignSnapshot(asEntry({ ...capture("OK"), contentHash: "" }))).toBeUndefined();
		expect(parseRootDesignSnapshot(asEntry({ ...capture("OK"), content: "x", block: 5 }))).toBeUndefined();
		// A timeline capture from discarded designs (reason field, empty block) is inert.
		expect(parseRootDesignSnapshot(asEntry({ ...capture("OK"), block: "", reason: "cleared" }))).toBeUndefined();
		expect(latestBranchCapture([asEntry(undefined)])).toBeUndefined();
	});
});

describe("root design section injection", () => {
	test("adds the named section to the structured head exactly once", () => {
		const head = system("base prompt");
		const block = capture("DESIGN").block;
		const injected = injectRootDesignSection([head, user("hello")], block);
		expect(sectionOf(injected)).toContain("DESIGN");
		expect(injectedHead(injected)?.sections?.preamble).toBe("base prompt");
		expect(injected?.[1]).toEqual(user("hello"));
		expect(injectRootDesignSection(injected ?? [], block)).toBeUndefined();
	});

	test("overwrites a foreign value under the owned section name", () => {
		const head = { role: "system", content: "", sections: { [ROOT_DESIGN_SECTION]: "stale" }, timestamp: 1 } as ContextMessage;
		const injected = injectRootDesignSection([head, user("x")], capture("DESIGN").block);
		expect(sectionOf(injected!)).toContain("DESIGN");
	});

	test("appends to a flat string head with a presence check", () => {
		const block = capture("DESIGN").block;
		const flatHead: Extract<ContextMessage, { role: "system" }> = { role: "system", content: "flat prompt", timestamp: 1 };
		const injected = injectRootDesignSection([flatHead, user("x")], block);
		const head = injectedHead(injected);
		expect(head?.content).toBe(`flat prompt\n\n${block}`);
		expect(injectRootDesignSection(injected ?? [], block)).toBeUndefined();
	});

	test("returns the relocated list when the section is already correct but the head was misplaced", () => {
		const block = capture("DESIGN").block;
		const early = customMessage("early note");
		const head = system("base prompt");
		const withSection = injectRootDesignSection([head, user("x")], block);
		const relocatedOnly = injectRootDesignSection([early, ...(withSection ?? [])], block);
		// Relocation is a real repair: the misplacement must be fixed even when
		// the section value needs no change.
		expect(injectedHead(relocatedOnly)).toBeDefined();
		// The already-correct head object is kept as-is and moved to the front.
		expect(relocatedOnly?.[0]).toBe((withSection ?? [])[0]);
		expect(relocatedOnly?.[1]).toBe(early);
		expect(relocatedOnly?.length).toBe((withSection ?? []).length + 1);
		expect(sectionOf(relocatedOnly)).toContain("DESIGN");
	});

	test("relocates the original declaration ahead of early custom messages and injects", () => {
		const head = system("base prompt");
		const early = customMessage("early note");
		const hello = user("hello");
		const injected = injectRootDesignSection([early, head, hello], capture("DESIGN").block);
		// The declaration leads again (cloned to carry the section); the early
		// custom message and the user turn keep their relative order after it.
		const relocated = injectedHead(injected);
		expect(relocated?.sections?.preamble).toBe("base prompt");
		expect(sectionOf(injected)).toContain("DESIGN");
		expect(injected?.[1]).toBe(early);
		expect(injected?.[2]).toBe(hello);
	});

	test("skips injection without a head or for an empty captured value", () => {
		expect(injectRootDesignSection([user("no head")], capture("DESIGN").block)).toBeUndefined();
		const head = system("base");
		expect(injectRootDesignSection([head, user("x")], "")).toBeUndefined();
		// A head with neither sections nor string content fails open.
		const blockHead: Extract<ContextMessage, { role: "system" }> = { role: "system", content: [{ type: "text", text: "blocks" }], timestamp: 1 };
		expect(injectRootDesignSection([blockHead], capture("DESIGN").block)).toBeUndefined();
	});
});

describe("payload system slots and reassertion", () => {
	const block = capture("DESIGN").block;
	const piPrompt = "You are an expert coding assistant.\n\n<cwd>\n/project\n</cwd>";

	test("appends only to the pi-built anthropic text block, preserving identity and metadata", () => {
		const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." };
		const promptBlock = { type: "text", text: piPrompt, cache_control: { type: "ephemeral" } };
		const payload = { model: "m", system: [identity, promptBlock], messages: [{ role: "user", content: "hi" }] };
		const slots = payloadSystemSlots(payload);
		expect(slots.length).toBe(2);
		let changed = false;
		for (const slot of slots) {
			const next = reassertRootDesignSection(slot.read() ?? "", block);
			if (next === undefined) continue;
			slot.write(next);
			changed = true;
		}
		expect(changed).toBe(true);
		expect(identity.text).not.toContain("design_system");
		expect(promptBlock.text.startsWith(piPrompt)).toBe(true);
		expect(promptBlock.text.endsWith(block)).toBe(true);
		expect(promptBlock.cache_control).toEqual({ type: "ephemeral" });
		expect(JSON.stringify(payload.messages)).not.toContain("design_system");
		// Count in raw slot texts: JSON.stringify escapes the block's newlines.
		const occurrences = [identity.text, promptBlock.text].map((text) => text.split(block).length - 1);
		expect(occurrences).toEqual([0, 1]);
	});

	test("leaves payloads without a pi-built prompt untouched", () => {
		const payload = { model: "m", system: [{ type: "text", text: "foreign prompt" }] };
		for (const slot of payloadSystemSlots(payload)) {
			expect(reassertRootDesignSection(slot.read() ?? "", block)).toBeUndefined();
		}
	});

	test("targets each known carrier shape and never invents slots for unknown ones", () => {
		expect(payloadSystemSlots({ messages: [{ role: "system", content: piPrompt }] }).length).toBe(1);
		expect(payloadSystemSlots({ messages: [{ role: "developer", content: piPrompt }] }).length).toBe(1);
		expect(payloadSystemSlots({ input: [{ role: "system", content: piPrompt }] }).length).toBe(1);
		expect(payloadSystemSlots({ instructions: piPrompt }).length).toBe(1);
		expect(payloadSystemSlots({ config: { systemInstruction: piPrompt } }).length).toBe(1);
		expect(payloadSystemSlots({ system: [{ text: piPrompt }, { cachePoint: {} }] }).length).toBe(1);
		// Unknown shapes: no slots, fail open.
		expect(payloadSystemSlots(undefined)).toEqual([]);
		expect(payloadSystemSlots("text")).toEqual([]);
		expect(payloadSystemSlots({ messages: [{ role: "user", content: piPrompt }] })).toEqual([]);
		expect(payloadSystemSlots({})).toEqual([]);
	});

	test("reassertion is exactly-once and gated on the pi-built marker", () => {
		expect(reassertRootDesignSection(piPrompt, block)).toBe(`${piPrompt}\n\n${block}`);
		expect(reassertRootDesignSection(`${piPrompt}\n\n${block}`, block)).toBeUndefined();
		expect(reassertRootDesignSection("no cwd marker", block)).toBeUndefined();
		expect(reassertRootDesignSection("", block)).toBeUndefined();
	});
});

describe("root design file classification", () => {
	async function makeRoot(files: Record<string, string>) {
		const root = await mkdtemp(path.join(tmpdir(), "paa-file-"));
		for (const [relative, content] of Object.entries(files)) {
			await writeFile(path.join(root, relative), content, "utf8");
		}
		return {
			root,
			cleanup: () => rm(root, { recursive: true, force: true }),
		};
	}

	test("classifies an absent file as missing", async () => {
		const tree = await makeRoot({});
		try {
			expect(await readRootDesignFile(tree.root)).toEqual({ status: "missing" });
		} finally {
			await tree.cleanup();
		}
	});

	test("classifies a readable file as present at its canonical-root path", async () => {
		const tree = await makeRoot({ "DESIGN.md": "CONTENT" });
		try {
			const file = await readRootDesignFile(tree.root);
			expect(file.status).toBe("present");
			expect(file.status === "present" && file.content).toBe("CONTENT");
			expect(file.status === "present" && file.path).toBe(path.join(tree.root, "DESIGN.md"));
		} finally {
			await tree.cleanup();
		}
	});

	test("classifies a root-escaping symlink as rejected containment, not present guidance", async () => {
		const outside = await makeRoot({ "DESIGN.md": "ESCAPED" });
		const tree = await makeRoot({});
		try {
			await symlink(path.join(outside.root, "DESIGN.md"), path.join(tree.root, "DESIGN.md"));
			expect(await readRootDesignFile(tree.root)).toEqual({ status: "missing" });
		} finally {
			await tree.cleanup();
			await outside.cleanup();
		}
	});

	test("defers on a directory occupying the design path", async () => {
		const tree = await makeRoot({});
		try {
			await mkdir(path.join(tree.root, "DESIGN.md"));
			expect(await readRootDesignFile(tree.root)).toEqual({ status: "unknown" });
		} finally {
			await tree.cleanup();
		}
	});

	test("defers when the session root denies traversal instead of recording a durable clear", async () => {
		if (typeof process.getuid === "function" && process.getuid() === 0) {
			// Root ignores permission bits; the denial scenario cannot be staged.
			return;
		}
		const tree = await makeRoot({ "DESIGN.md": "CONTENT" });
		try {
			await chmod(tree.root, 0o000);
			let file: RootDesignFile;
			try {
				file = await readRootDesignFile(tree.root);
			} finally {
				await chmod(tree.root, 0o755);
			}
			expect(file).toEqual({ status: "unknown" });
		} finally {
			await tree.cleanup();
		}
	});
});
