/**
 * Bounded map of where pi-ai 0.99.2 puts the system prompt text in a wire
 * payload, verified against the installed dist/api/*.js builders (same table
 * the platform's skill guidance maintains for its own section):
 *
 * - openai-completions / mistral-conversations: `messages[0]` with role
 *   "system", or "developer" for reasoning models (same instruction text);
 *   under OpenRouter-Anthropic caching the content is a text-block array with
 *   `cache_control` metadata, exposed per text part.
 * - openai-responses / azure-openai-responses: `input[0]`, same role split.
 * - anthropic-messages: `system` is an array of `{type:"text", text,
 *   cache_control?}` blocks; under OAuth, `system[0]` is the Claude Code
 *   identity and the prompt sits in `system[1]`.
 * - bedrock-converse: `system` is an array of `{text}` blocks followed by a
 *   `{cachePoint}` block.
 * - openai-codex-responses: `instructions` is a string.
 * - google-generative-ai / google-vertex: `config.systemInstruction` is a
 *   string.
 *
 * The root-design payload reassertion runs at before_provider_request, which
 * executes after pi applies any before_agent_start forced prompt (that
 * projection replaces the leading system message with flat text built from
 * the base prompt, discarding every context_with_system head edit). A payload
 * holds at most one of the shapes above; unknown shapes yield no slots and
 * callers must fail open rather than guess. This table is provider coupling
 * by design: extend it only when pi-ai adds or moves a system-text carrier,
 * and keep every entry mechanical.
 */

export interface PayloadTextSlot {
	/** Current text of the slot; undefined when the slot carries no text. */
	read(): string | undefined;
	/** Replace the slot's text in place, leaving sibling fields untouched. */
	write(text: string): void;
}

/**
 * Slots for one leading `{role, content}` instruction message; role varies by
 * model, not by slot. Plain string content yields one slot. OpenRouter-Anthropic
 * cached instructions carry the text as text-block parts with cache metadata;
 * each text part becomes a slot whose write replaces only `text`, so
 * `cache_control` and sibling fields survive.
 */
function instructionMessageSlots(message: unknown): PayloadTextSlot[] {
	if (!message || typeof message !== "object") return [];
	// SAFETY: role and content are probed before the narrowed views are used.
	const head = message as { role?: unknown; content?: unknown };
	if (head.role !== "system" && head.role !== "developer") return [];
	if (typeof head.content === "string") {
		const instruction = message as { content: string };
		return [
			{
				read: () => instruction.content,
				write: (text: string) => {
					instruction.content = text;
				},
			},
		];
	}
	if (Array.isArray(head.content)) {
		const slots: PayloadTextSlot[] = [];
		for (const part of head.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			) {
				// SAFETY: the probe above proved type and text on this object.
				const textPart = part as { text: string };
				slots.push({
					read: () => textPart.text,
					write: (text: string) => {
						textPart.text = text;
					},
				});
			}
		}
		return slots;
	}
	return [];
}

/** Every system-text slot this payload shape exposes; empty for unknown shapes. */
export function payloadSystemSlots(payload: unknown): PayloadTextSlot[] {
	// SAFETY: every access below is guarded by typeof/Array.isArray probes on
	// the unknown payload; the Record view only names verified properties.
	if (!payload || typeof payload !== "object") return [];
	const record = payload as Record<string, unknown>;
	const slots: PayloadTextSlot[] = [];

	// openai-completions / mistral: messages[0]; openai-responses / azure: input[0].
	// A payload never carries both containers; probing both is harmless.
	slots.push(
		...instructionMessageSlots(Array.isArray(record.messages) ? (record.messages as unknown[])[0] : undefined),
		...instructionMessageSlots(Array.isArray(record.input) ? (record.input as unknown[])[0] : undefined),
	);

	// anthropic-messages ({type:"text",text}) and bedrock-converse ({text});
	// anthropic OAuth puts a fixed identity block first, cachePoint blocks carry no text.
	if (Array.isArray(record.system)) {
		for (const block of record.system as Array<Record<string, unknown>>) {
			if (
				block &&
				typeof block === "object" &&
				typeof block.text === "string" &&
				(block.type === undefined || block.type === "text")
			) {
				// SAFETY: the probe above proved `text` is a string on this object.
				const textBlock = block as { text: string };
				slots.push({
					read: () => textBlock.text,
					write: (text: string) => {
						textBlock.text = text;
					},
				});
			}
		}
	}

	// openai-codex-responses.
	if (typeof record.instructions === "string") {
		// SAFETY: the typeof probe above proved the field on this object.
		const instructions = record as { instructions: string };
		slots.push({
			read: () => instructions.instructions,
			write: (text: string) => {
				instructions.instructions = text;
			},
		});
	}

	// google-generative-ai / google-vertex.
	const config = record.config;
	if (config && typeof config === "object" && typeof (config as { systemInstruction?: unknown }).systemInstruction === "string") {
		// SAFETY: the typeof probe above proved the field on this object.
		const googleConfig = config as { systemInstruction: string };
		slots.push({
			read: () => googleConfig.systemInstruction,
			write: (text: string) => {
				googleConfig.systemInstruction = text;
			},
		});
	}

	return slots;
}
