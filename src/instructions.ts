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

/** Envelope tag for AGENTS.md context files. */
const AGENTS_TAG = "project_instructions";
/** DESIGN.md gets its own envelope so design guidance stays distinct from build instructions. */
const DESIGN_TAG = "design_system";

function isDesignFile(filepath: string) {
	return path.basename(path.resolve(filepath)) === "DESIGN.md";
}

/** Identify one scoped instruction block consistently across delivery paths. */
export function instructionHeader(filepath: string) {
	const resolved = path.resolve(filepath);
	const tag = isDesignFile(resolved) ? DESIGN_TAG : AGENTS_TAG;
	return `<${tag} path="${escapeXml(resolved)}" scope="${escapeXml(path.dirname(resolved) + path.sep)}">`;
}

/** Render one complete context file with its scope; DESIGN.md uses the design_system envelope. */
export function formatInstructions(file: AgentsFile) {
	if (isDesignFile(file.filepath)) {
		return `${instructionHeader(file.filepath)}
This block is the project DESIGN.md, its design system in the Google Stitch format. The complete file contents are already loaded below. No separate read is needed unless checking for changes.
Follow these design rules for interface work within the stated subtree. More-specific DESIGN.md files override broader ones.
<file_content>
${escapeXml(file.content)}
</file_content>
</${DESIGN_TAG}>`;
	}

	return `${instructionHeader(file.filepath)}
The complete file contents are already loaded below. No separate read is needed unless checking for changes.
Apply these instructions within the stated subtree, respecting narrower conditions and exceptions in the contents. More-specific repository instructions override conflicting broader repository guidance.
<file_content>
${escapeXml(file.content)}
</file_content>
</${AGENTS_TAG}>`;
}
