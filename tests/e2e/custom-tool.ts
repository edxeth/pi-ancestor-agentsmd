import { readFile } from "node:fs/promises";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "demo_read",
		label: "Demo read",
		description: "Read a file from disk and return its contents.",
		parameters: Type.Object({
			path: Type.String({ description: "File path to read" }),
		}),
		async execute(_toolCallId, params) {
			const abs = path.resolve(params.path);
			try {
				const text = await readFile(abs, "utf8");
				return { content: [{ type: "text", text }], details: {} };
			} catch (err) {
				return { content: [{ type: "text", text: String(err) }], details: {}, isError: true };
			}
		},
	});
}

