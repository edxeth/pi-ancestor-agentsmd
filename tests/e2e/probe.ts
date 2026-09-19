import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.PROBE_LOG;
if (!LOG) throw new Error("PROBE_LOG env var is required");

function digest(v: unknown): string {
	const s = JSON.stringify(v, (_k, val) =>
		typeof val === "bigint" ? String(val) : val,
	);
	return createHash("sha256").update(s ?? "null").digest("hex").slice(0, 12);
}

function preview(content: unknown): string | undefined {
	if (typeof content === "string") return content.slice(0, 60);
	if (Array.isArray(content))
		return content
			.map((b) => {
				const bb = b as { type?: string; text?: string };
				return bb.type === "text" ? "text:" + (bb.text ?? "").slice(0, 40) : bb.type;
			})
			.join("|")
			.slice(0, 80);
	return undefined;
}

export default function (pi: ExtensionAPI) {
	let ctxSeq = 0;
	let reqSeq = 0;
	pi.on("session_start", async (event, ctx) => {
		const manager = (ctx as { sessionManager?: Record<string, unknown> }).sessionManager;
		const sessionStart = event as { reason?: unknown };
		appendFileSync(
			LOG,
			JSON.stringify({
				kind: "session_start",
				pid: process.pid,
				reason: sessionStart.reason,
				hasBuildContextEntries: typeof manager?.buildContextEntries,
				hasGetBranch: typeof manager?.getBranch,
				nContextEntries: Array.isArray((manager?.buildContextEntries as (() => unknown[]) | undefined)?.())
					? ((manager!.buildContextEntries as () => unknown[])().length)
					: null,
			}) + "\n",
		);
	});
	pi.on("context", async (event) => {
		ctxSeq += 1;
		const messages = (event.messages as unknown[]).map((m) => {
			const mm = m as Record<string, unknown>;
			return {
				role: mm.role,
				customType: mm.customType,
				ts: mm.timestamp,
				msgHash: digest(m),
				contentHash: digest(mm.content),
				preview: preview(mm.content),
			};
		});
		appendFileSync(LOG, JSON.stringify({ kind: "context", seq: ctxSeq, messages }) + "\n");
	});
	pi.on("before_provider_request", async (event) => {
		reqSeq += 1;
		const payload = event.payload as Record<string, unknown>;
		const raw = (payload?.messages ?? payload?.input ?? []) as unknown[];
		const messages = (raw as unknown[]).map((m) => {
			const mm = m as Record<string, unknown>;
			return { role: mm.role, hash: digest(m), preview: preview(mm.content) };
		});
		appendFileSync(
			LOG,
			JSON.stringify({
				kind: "provider_request",
				seq: reqSeq,
				model: payload?.model,
				nMessages: messages.length, payloadShape: payload?.messages ? "messages" : payload?.input ? "input" : "none",
				messages,
			}) + "\n",
		);
	});
}

