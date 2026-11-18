import type { SessionContextUsage } from "../shared/context-usage.js";

/** Minimal message shape; the runtime's own message types satisfy it. */
export interface UsageMessage {
	readonly role: string;
	readonly content?: unknown;
	readonly stopReason?: string;
	readonly usage?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

/** The slice of a session that context accounting reads. A structural type, so
 * it does not tie this module to a particular agent runtime. */
interface ContextSession {
	getContextUsage(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	readonly systemPrompt: string;
	readonly messages: readonly UsageMessage[];
	getAllTools(): ReadonlyArray<{
		name: string;
		description?: string;
		parameters?: unknown;
	}>;
	getActiveToolNames(): string[];
}

/** Characters assumed for an image block (matches the SDK's heuristic). */
const ESTIMATED_IMAGE_CHARS = 4800;

function contentChars(content: unknown): number {
	if (typeof content === "string") return content.length;
	if (!Array.isArray(content)) return 0;
	let chars = 0;
	for (const block of content) {
		if (block?.type === "text" && block.text) chars += block.text.length;
		else if (block?.type === "image") chars += ESTIMATED_IMAGE_CHARS;
	}
	return chars;
}

/** Conservative chars/4 token estimate for one message. */
export function estimateMessageTokens(message: UsageMessage): number {
	const m = message as unknown as Record<string, any>;
	let chars = 0;
	switch (m.role) {
		case "system":
			chars = contentChars(m.content);
			for (const section of Object.values(m.sections ?? {})) if (typeof section === "string") chars += section.length;
			if (m.toolsAdded) chars += JSON.stringify(m.toolsAdded).length;
			break;
		case "user":
		case "custom":
		case "toolResult":
			chars = contentChars(m.content);
			break;
		case "assistant":
			for (const block of m.content ?? []) {
				if (block.type === "text") chars += block.text.length;
				else if (block.type === "thinking") chars += block.thinking.length;
				else if (block.type === "toolCall") chars += block.name.length + JSON.stringify(block.arguments).length;
			}
			break;
		case "bashExecution":
			chars = String(m.command ?? "").length + String(m.output ?? "").length;
			break;
		case "branchSummary":
		case "compactionSummary":
			chars = String(m.summary ?? "").length;
			break;
		default:
			return 0;
	}
	return Math.ceil(chars / 4);
}

export function unavailableContextUsage(sessionId: string, status: "inactive" | "unavailable"): SessionContextUsage {
	return { sessionId, status, source: "sdk", tokens: null, contextWindow: null, percent: null, breakdown: [] };
}

/** Categories are heuristic weights, calibrated to the provider's reported context
 * total. Tool results stay in messages; tool schemas are counted only once.
 */
export function buildContextUsage(sessionId: string, session: ContextSession): SessionContextUsage {
	const usage = session.getContextUsage();
	if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) {
		return unavailableContextUsage(sessionId, "unavailable");
	}
	const base = { sessionId, contextWindow: usage.contextWindow };
	if (usage.tokens === null) {
		return { ...base, status: "pending", source: "sdk", tokens: null, percent: null, breakdown: [] };
	}
	const weights = { system: 0, tools: 0, messages: 0, skills: 0 };
	const estimateText = (text: string) => Math.ceil(text.length / 4);
	const prompt = session.systemPrompt.replace(/<available_skills>[\s\S]*?<\/available_skills>/g, (block) => {
		weights.skills += estimateText(block);
		return "";
	});
	weights.system = estimateText(prompt);
	const active = new Set(session.getActiveToolNames());
	for (const tool of session.getAllTools()) {
		if (!active.has(tool.name)) continue;
		weights.tools += estimateText(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }));
	}
	for (const message of session.messages) weights.messages += estimateMessageTokens(message);
	const entries = Object.entries(weights) as Array<[keyof typeof weights, number]>;
	const weightTotal = entries.reduce((sum, [, value]) => sum + value, 0);
	// Before the first successful provider response the SDK only estimates messages,
	// omitting the system prompt and schemas. Include them in the initial estimate.
	const hasUsage = session.messages.some((m) => m.role === "assistant" && m.stopReason !== "error" && m.stopReason !== "aborted"
		&& m.usage !== undefined && m.usage.input + m.usage.output + m.usage.cacheRead + m.usage.cacheWrite > 0);
	const rawTotal = hasUsage ? usage.tokens : weightTotal;
	if (!Number.isFinite(rawTotal) || rawTotal < 0) return unavailableContextUsage(sessionId, "unavailable");
	const tokens = Math.round(rawTotal);
	// Largest-remainder allocation keeps the category tokens equal to the total.
	const parts = entries.map(([id, weight]) => {
		const exact = weightTotal ? tokens * weight / weightTotal : (id === "messages" ? tokens : 0);
		return { id, tokens: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	let remaining = tokens - parts.reduce((sum, part) => sum + part.tokens, 0);
	for (const part of [...parts].sort((a, b) => b.remainder - a.remainder)) {
		if (remaining-- > 0) part.tokens++;
	}
	return {
		...base, status: "ready", source: hasUsage ? "sdk" : "estimated", tokens,
		percent: tokens / usage.contextWindow * 100,
		breakdown: parts.map(({ id, tokens }) => ({ id, tokens, percent: tokens / usage.contextWindow * 100 })),
	};
}

export interface DurableContextUsageInput {
	contextWindow: number;
	instructions: string;
	tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
	messages: readonly UsageMessage[];
}

/** Context usage for a durable session. The total follows the provider's last
 * reported usage plus an estimate for what came after it; before the first
 * response everything is estimated. */
export function buildDurableContextUsage(sessionId: string, input: DurableContextUsageInput): SessionContextUsage {
	const { messages } = input;
	let lastUsageIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		const usage = message.usage;
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted"
			&& usage && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
			lastUsageIndex = i;
			break;
		}
	}
	let tokens = 0;
	if (lastUsageIndex >= 0) {
		const usage = messages[lastUsageIndex]!.usage!;
		tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		for (const message of messages.slice(lastUsageIndex + 1)) tokens += estimateMessageTokens(message);
	}
	return buildContextUsage(sessionId, {
		getContextUsage: () => ({ tokens, contextWindow: input.contextWindow, percent: null }),
		systemPrompt: input.instructions,
		messages,
		getAllTools: () => input.tools,
		getActiveToolNames: () => input.tools.map((tool) => tool.name),
	});
}
