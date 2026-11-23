import { logger } from "../logger.js";

/** Cap on how long a workspace_change event waits for the replica push. */
export const REPLICA_PUSH_TIMEOUT_MS = 10_000;

/**
 * Serialize replica pushes: at most one running plus one queued. A burst of
 * change events coalesces into at most two pushes — callers awaiting the gate
 * all unblock when the second (queued) push drains the pending flag.
 * Push errors are logged, never thrown: the SSE stream must continue.
 */
export function createReplicaPushGate(push: () => Promise<void>): () => Promise<void> {
	let running: Promise<void> | null = null;
	let pending = false;
	const drain = async () => {
		try {
			do {
				pending = false;
				try {
					await push();
				} catch (error) {
					logger.warn({ err: error }, "workspace replica push failed");
				}
			} while (pending);
		} finally {
			running = null;
		}
	};
	return () => {
		if (!running) running = drain();
		else pending = true;
		return running;
	};
}

export type ChangePublisher = ((event: unknown) => void) & {
	/** Resolves once every event handed to the publisher has been published. */
	drain(): Promise<void>;
};

/**
 * Wrap a publish callback so the event goes out only after the replica push
 * has resolved (or timed out — the push continues in the background either
 * way). With no gate the publish stays synchronous, unchanged behaviour.
 * `drain()` lets the caller wait for in-flight publishes, so a terminal event
 * (done) can never overtake a pending workspace_change.
 */
export function workspaceChangePublisher(
	publish: (event: unknown) => void,
	gate: (() => Promise<void>) | null,
): ChangePublisher {
	const inflight = new Set<Promise<void>>();
	const wrapped = ((event: unknown) => {
		if (!gate) {
			publish(event);
			return;
		}
		const task = (async () => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					gate(),
					new Promise((resolve) => { timer = setTimeout(resolve, REPLICA_PUSH_TIMEOUT_MS); }),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			publish(event);
		})().finally(() => inflight.delete(task));
		inflight.add(task);
	}) as ChangePublisher;
	wrapped.drain = async () => {
		while (inflight.size > 0) await Promise.all([...inflight]);
	};
	return wrapped;
}
