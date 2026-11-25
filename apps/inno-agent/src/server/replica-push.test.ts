import { describe, expect, it } from "vitest";
import { createReplicaPushGate, workspaceChangePublisher } from "./replica-push.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createReplicaPushGate", () => {
	it("coalesces a burst into at most two pushes", async () => {
		let calls = 0;
		let release: (() => void) | undefined;
		const gate = createReplicaPushGate(async () => {
			calls++;
			if (calls === 1) await new Promise<void>((done) => { release = done; });
		});
		const waits = Array.from({ length: 5 }, () => gate());
		release!();
		await Promise.all(waits);
		await tick();
		expect(calls).toBe(2); // one running + one queued for events 2..5
	});

	it("swallows push failures so the stream continues", async () => {
		const gate = createReplicaPushGate(async () => { throw new Error("store down"); });
		await expect(gate()).resolves.toBeUndefined();
	});
});

describe("workspaceChangePublisher", () => {
	it("publishes only after the push resolves", async () => {
		const order: string[] = [];
		let release: (() => void) | undefined;
		const gate = () => new Promise<void>((done) => { release = () => { order.push("push"); done(); }; });
		const publish = workspaceChangePublisher(() => order.push("publish"), gate);
		publish({ type: "workspace_change" });
		await tick();
		expect(order).toEqual([]); // still waiting on the push
		release!();
		await tick();
		expect(order).toEqual(["push", "publish"]);
	});

	it("still publishes when the push fails", async () => {
		const published: unknown[] = [];
		const gate = createReplicaPushGate(async () => { throw new Error("push failed"); });
		const publish = workspaceChangePublisher((event) => published.push(event), gate);
		publish({ type: "workspace_change" });
		await tick();
		expect(published).toHaveLength(1);
	});

	it("publishes synchronously with no gate", () => {
		const published: unknown[] = [];
		const publish = workspaceChangePublisher((event) => published.push(event), null);
		publish({ type: "workspace_change" });
		expect(published).toHaveLength(1);
	});

	it("drain() resolves only after every pending event has been published, in order", async () => {
		const order: string[] = [];
		let release!: () => void;
		const pushed = new Promise<void>((resolve) => { release = resolve; });
		const gate = () => pushed;
		const publisher = workspaceChangePublisher((event) => { order.push(String(event)); }, gate);
		publisher("a");
		publisher("b");
		let drained = false;
		const drain = publisher.drain().then(() => { drained = true; });
		await Promise.resolve();
		expect(order).toEqual([]);
		expect(drained).toBe(false);
		release();
		await drain;
		expect(order).toEqual(["a", "b"]);
		expect(drained).toBe(true);
	});

	it("drain() is immediate without a gate", async () => {
		const seen: unknown[] = [];
		const publisher = workspaceChangePublisher((event) => { seen.push(event); }, null);
		publisher(1);
		await publisher.drain();
		expect(seen).toEqual([1]);
	});
});
