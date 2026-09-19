import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event) => {
		const content = event.content;
		if (!Array.isArray(content)) return;
		let changed = false;
		const stripped = content.map((block) => {
			const bb = block as { type?: string; text?: string };
			if (bb.type !== "text" || typeof bb.text !== "string") return block;
			const next = bb.text.replace(/<project_instructions[\s\S]*?<\/project_instructions>\n?/g, "");
			if (next === bb.text) return block;
			changed = true;
			return { ...bb, text: next };
		});
		return changed ? { content: stripped } : undefined;
	});
}

