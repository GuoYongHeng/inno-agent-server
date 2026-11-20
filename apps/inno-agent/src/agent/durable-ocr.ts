import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { InnoConfig } from "../config.js";
import type { ConfigHolder } from "./config-holder.js";
import { createOcrTools } from "./ocr-tools.js";
import { FileRecoveryStore, type RecoveryRecordStore } from "./recovery-store.js";

export interface DurableOcrToolOptions {
	sessionId: string;
	/** Where checkpoints live. Defaults to JSON files under `checkpointDir`. */
	records?: RecoveryRecordStore;
	checkpointDir?: string;
	workspaceDir: string;
	ocrApi?: InnoConfig["ocrApi"];
}

/** OCR jobs checkpoint their remote job ID before polling and cache the final
 * markdown. The remote API has no idempotency key, so a crash between remote
 * acceptance and the local job-ID commit can still duplicate one submission. */
export function createDurableOcrRegistrations(options: DurableOcrToolOptions): ToolRegistration[] {
	const holder = { current: { ocrApi: options.ocrApi } } as ConfigHolder;
	return createOcrTools(holder, {
		restrictToWorkspace: true,
		workspaceDir: options.workspaceDir,
		durable: {
			records: options.records ?? new FileRecoveryStore(() => {
				if (!options.checkpointDir) throw new Error("OCR checkpoints need a records store or a checkpoint directory");
				return options.checkpointDir;
			}, (value, sessionId) => (value as { operationId?: unknown })?.operationId?.toString().startsWith(`ocr_image:${sessionId}:`) === true),
			sessionId: options.sessionId,
			getOperationId: (toolCallId) => `ocr_image:${options.sessionId}:${toolCallId}`,
		},
	});
}
