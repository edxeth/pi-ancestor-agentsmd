import path from "node:path";
import type { AgentsFile } from "./core.js";

function escapeXml(text: string) {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

/** Identify one scoped instruction block consistently across delivery paths. */
export function instructionHeader(filepath: string) {
	const resolved = path.resolve(filepath);
	return `<project_instructions path="${escapeXml(resolved)}" scope="${escapeXml(path.dirname(resolved) + path.sep)}">`;
}

/** Render complete repository instructions with their scope. */
export function formatInstructions(file: AgentsFile) {
	return `${instructionHeader(file.filepath)}
The complete file contents are already loaded below. No separate read is needed unless checking for changes.
Apply these instructions within the stated subtree, respecting narrower conditions and exceptions in the contents. More-specific repository instructions override conflicting broader repository guidance.
<file_content>
${escapeXml(file.content)}
</file_content>
</project_instructions>`;
}
