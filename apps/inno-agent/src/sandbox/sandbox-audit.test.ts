import { afterAll, describe, expect, it } from "vitest";
import { LocalDirSandboxProvider } from "./local-backend.js";
import { findOrphanSandboxes, removeOrphanSandboxes } from "./sandbox-audit.js";

const provider = new LocalDirSandboxProvider();
afterAll(() => provider.dispose());
const HOUR = 3_600_000;

describe("orphan sandbox audit", () => {
	it("reports only unreferenced sandboxes older than the grace period, and destroys them on request", async () => {
		const kept = await provider.create({ metadata: { app: "inno-agent", sessionId: "s-kept" } });
		const orphan = await provider.create({ metadata: { app: "inno-agent", sessionId: "s-gone", tenantId: "t1" } });
		const fresh = await provider.create({ metadata: { app: "inno-agent", sessionId: "s-new" } });
		provider.sandboxes.get(kept.id)!.createdAt = Date.now() - 5 * HOUR;
		provider.sandboxes.get(orphan.id)!.createdAt = Date.now() - 3 * HOUR;

		const orphans = await findOrphanSandboxes(provider, new Set([kept.id]));
		expect(orphans.map((o) => o.id)).toEqual([orphan.id]);
		expect(orphans[0]).toMatchObject({ sessionId: "s-gone", tenantId: "t1" });
		expect(provider.sandboxes.get(orphan.id)!.killed).toBe(false);

		const result = await removeOrphanSandboxes(provider, orphans);
		expect(result).toEqual({ removed: [orphan.id], failed: [] });
		expect(provider.sandboxes.get(orphan.id)!.killed).toBe(true);
		expect(provider.sandboxes.get(fresh.id)!.killed).toBe(false);
		expect(provider.sandboxes.get(kept.id)!.killed).toBe(false);
	});

	it("reports a failed destroy instead of throwing", async () => {
		const stuck = await provider.create({ metadata: { app: "inno-agent" } });
		provider.sandboxes.get(stuck.id)!.createdAt = 0;
		const failing = { ...provider, destroy: async () => { throw new Error("api down"); } } as unknown as LocalDirSandboxProvider;
		const [orphan] = await findOrphanSandboxes(provider, new Set());
		expect(await removeOrphanSandboxes(failing, [orphan!])).toEqual({ removed: [], failed: [{ id: orphan!.id, error: "api down" }] });
	});
});
