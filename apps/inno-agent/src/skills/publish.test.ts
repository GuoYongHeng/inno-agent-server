import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryObjectStore } from "../object-store/object-store.js";
import type { SkillCatalogRecord } from "./catalog-store.js";
import { materializeSkill, GLOBAL_SKILLS_WORKSPACE_DIR } from "./materialize.js";
import { publishSkillFromDir } from "./publish.js";
import { skillManifestObjectKey } from "./skill-object-key.js";

class MemoryCatalog {
	private readonly rows = new Map<string, SkillCatalogRecord>();

	async get(skillId: string): Promise<SkillCatalogRecord | null> {
		return this.rows.get(skillId) ?? null;
	}

	async upsertCatalog(record: {
		skillId: string;
		name: string;
		description: string;
		version: string;
		objectPrefix: string;
		disableModelInvocation?: boolean;
		publishedBy?: string | null;
		source?: string | null;
		ownerTenantId?: string | null;
	}): Promise<SkillCatalogRecord> {
		const row: SkillCatalogRecord = {
			skillId: record.skillId,
			name: record.name,
			description: record.description,
			version: record.version,
			objectPrefix: record.objectPrefix,
			disableModelInvocation: Boolean(record.disableModelInvocation),
			publishedAt: new Date().toISOString(),
			publishedBy: record.publishedBy ?? null,
			ownerTenantId: record.ownerTenantId ?? null,
			source: record.source ?? null,
		};
		this.rows.set(row.skillId, row);
		return row;
	}
}

describe("publishSkillFromDir + materializeSkill", () => {
	let dir = "";

	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});

	it("publishes to object storage and materializes into .global-skills", async () => {
		dir = mkdtempSync(join(tmpdir(), "inno-skill-pub-"));
		const skillDir = join(dir, "demo-skill");
		mkdirSync(skillDir);
		writeFileSync(join(skillDir, "SKILL.md"), "---\nname: demo-skill\ndescription: Demo skill for tests\n---\n# Hello\n");
		writeFileSync(join(skillDir, "notes.txt"), "note");

		const objects = new MemoryObjectStore();
		const catalog = new MemoryCatalog();
		const published = await publishSkillFromDir({
			objects,
			catalog: catalog as never,
			skillDir,
			source: "test",
		});
		expect(published.skillId).toBe("demo-skill");
		expect(published.unchanged).toBe(false);
		expect(await objects.head(skillManifestObjectKey(published.skillId, published.version))).not.toBeNull();

		const again = await publishSkillFromDir({
			objects,
			catalog: catalog as never,
			skillDir,
			source: "test",
		});
		expect(again.unchanged).toBe(true);
		expect(again.version).toBe(published.version);

		const workspace = join(dir, "ws");
		mkdirSync(workspace);
		const record = (await catalog.get("demo-skill"))!;
		const dest = await materializeSkill(objects, record, workspace);
		expect(dest).toContain(GLOBAL_SKILLS_WORKSPACE_DIR);
		expect(readFileSync(join(dest, "SKILL.md"), "utf-8")).toContain("Demo skill for tests");
		expect(readFileSync(join(dest, "notes.txt"), "utf-8")).toBe("note");

		// Second materialize is a no-op rewrite of matching hashes.
		await materializeSkill(objects, record, workspace);
	});
});
