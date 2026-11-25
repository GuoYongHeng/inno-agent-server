#!/usr/bin/env node
/**
 * Import every skill from the configured content hub into the platform
 * object store + skill_catalog, then enable them for all tenants. This is
 * the deployment-time distribution path: the hub is consulted once here
 * (typically by an init container), never at runtime.
 *
 *   DATABASE_URL=... node dist/skills/import-hub-cli.js
 *
 * Reads config.json for `contentHub` and `objectStorage` exactly like the
 * server does; object storage env vars override the file the same way.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createContentSource, type RemoteItem } from "../content-source/index.js";
import { createObjectStore, normalizeObjectStorageConfig } from "../object-store/index.js";
import { resolveRuntimePaths } from "../runtime.js";
import { ensureDir } from "../storage/file-store.js";
import { migrateTenantDatabase } from "../tenants/schema.js";
import { SkillCatalogStore } from "./catalog-store.js";
import { publishSkillFromDir } from "./publish.js";

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	const paths = resolveRuntimePaths();
	if (!existsSync(paths.configPath)) {
		throw new Error(`config.json not found at ${paths.configPath} — the hub location lives there`);
	}
	const config = loadConfig(paths.configPath, { allowEmptyProviders: true });
	const hub = config.contentHub;
	if (!hub) throw new Error("config.json has no contentHub block — nothing to import from");

	const objects = createObjectStore(normalizeObjectStorageConfig(config.objectStorage));
	const source = createContentSource(hub);
	const items: RemoteItem[] = await source.listItems("skills", { forceRefresh: true });
	if (items.length === 0) {
		console.log("content hub returned no skills — nothing to import");
		return;
	}

	const pool = new Pool({ connectionString: databaseUrl });
	try {
		await migrateTenantDatabase(pool);
		const catalog = new SkillCatalogStore(pool);
		let published = 0;
		const failures: string[] = [];
		for (const item of items) {
			const tempRoot = mkdtempSync(join(tmpdir(), "inno-hub-import-"));
			try {
				const target = join(tempRoot, item.name);
				ensureDir(target);
				await source.downloadItem("skills", item.name, target);
				await publishSkillFromDir({
					objects,
					catalog,
					skillDir: target,
					source: "hub-import",
				});
				published += 1;
				console.log(`published ${item.name}`);
			} catch (err) {
				failures.push(item.name);
				console.error(`failed ${item.name}: ${err instanceof Error ? err.message : String(err)}`);
			} finally {
				rmSync(tempRoot, { recursive: true, force: true });
			}
		}
		const enabled = await catalog.enableAllForAllTenants();
		console.log(`hub import complete: ${published}/${items.length} published, ${enabled} tenant skill rows enabled`);
		if (published === 0) process.exitCode = 1;
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
