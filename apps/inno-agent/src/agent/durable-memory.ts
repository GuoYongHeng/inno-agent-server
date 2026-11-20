import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createL2Tools } from "../memory/l2/l2-tools.js";
import { createL3Tools, type ScopedL3Memory } from "../memory/l3/l3-tools.js";

export interface DurableMemoryToolOptions {
	sessionId: string;
	l2DataDir: string;
	workspaceDir: string;
	l2Enabled: boolean;
	l3?: {
		memory: Pick<ScopedL3Memory, "recall">;
		enabled: boolean;
	};
}

/** Memory surface for durable sessions: L2 archive resumes by content hash and
 * manifest without nested model calls; L3 recall is read-only. */
export function createDurableMemoryTools(options: DurableMemoryToolOptions): ToolRegistration[] {
	const l2Tools = createL2Tools(
		options.l2DataDir,
		() => options.l2Enabled,
		undefined,
		() => options.workspaceDir,
		true,
		true,
	);
	const l3Tools = options.l3
		? createL3Tools(options.l3.memory, () => options.sessionId, () => options.l3!.enabled)
		: [];
	return [...l2Tools, ...l3Tools];
}

/** Return native registrations. Every memory tool is idempotent or read-only, so
 * all are replay-safe: archive resumes by content hash and manifest. */
export function createDurableMemoryRegistrations(
	options: DurableMemoryToolOptions,
): ToolRegistration[] {
	return createDurableMemoryTools(options).map((tool) => ({ ...tool, replay: "safe" }));
}
