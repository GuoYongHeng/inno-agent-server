import type { ToolRegistration } from "@earendil-works/pi-durable";
import type { ChannelRegistry } from "../channels/channel.js";
import { FileChannelOutbox, type ChannelOutbox } from "../channels/channel-outbox.js";
import { createChannelTools } from "../channels/channel-tools.js";

export interface DurableChannelToolOptions {
	sessionId: string;
	/** Where send intents live. Defaults to JSON files under `outboxDir`. */
	outbox?: ChannelOutbox;
	outboxDir?: string;
	workspaceDir: string;
	/** Workspace file access seam for send_file_to_channel resolution/snapshot. */
	files?: import("../workspace/workspace-files.js").WorkspaceFileAccess;
	channelRegistry: ChannelRegistry;
}

/** File sends recover from a persisted payload snapshot. Completion caching
 * prevents another send after the marker commits; the earlier crash window is
 * explicitly at-least-once because channel APIs have no common idempotency key. */
export function createDurableChannelRegistrations(options: DurableChannelToolOptions): ToolRegistration[] {
	return createChannelTools({
		channelRegistry: options.channelRegistry,
		workspaceDir: options.workspaceDir,
		files: options.files,
		allowWorkspaceFallback: true,
		durable: {
			outbox: resolveChannelOutbox(options),
			getOperationId: (toolCallId) => `send_file_to_channel:${options.sessionId}:${toolCallId}`,
		},
	});
}

export function resolveChannelOutbox(options: { outbox?: ChannelOutbox; outboxDir?: string }): ChannelOutbox {
	if (options.outbox) return options.outbox;
	if (!options.outboxDir) throw new Error("Channel sends need an outbox store or an outbox directory");
	return new FileChannelOutbox(options.outboxDir);
}
