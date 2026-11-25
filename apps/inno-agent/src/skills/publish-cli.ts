#!/usr/bin/env node
/**
 * Publish one skill directory (or every child of a skills root) into the
 * platform object store + skill_catalog. Requires DATABASE_URL and object
 * storage env/config the same way the server does.
 *
 *   npm run skills:publish -- ./skills/my-skill
 *   npm run skills:publish -- --root ./skills
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Pool } from "pg";
import { loadConfig } from "../config.js";
import { createObjectStore, normalizeObjectStorageConfig } from "../object-store/index.js";
import { resolveRuntimePaths } from "../runtime.js";
import { migrateTenantDatabase } from "../tenants/schema.js";
import { SkillCatalogStore } from "./catalog-store.js";
import { publishSkillFromDir, publishSkillsFromRoot } from "./publish.js";

function usage(): never {
	console.error("Usage: skills:publish <skill-dir> | --root <skills-root>");
	process.exit(2);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	let root: string | undefined;
	let skillDir: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!;
		if (arg === "--root") {
			root = args[++i];
			if (!root) usage();
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else if (!arg.startsWith("-")) {
			skillDir = arg;
		} else {
			usage();
		}
	}
	if (!root && !skillDir) usage();

	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) throw new Error("DATABASE_URL is required");

	const paths = resolveRuntimePaths();
	const config = existsSync(paths.configPath)
		? loadConfig(paths.configPath, { allowEmptyProviders: true })
		: undefined;
	const objects = createObjectStore(normalizeObjectStorageConfig(config?.objectStorage));
	const pool = new Pool({ connectionString: databaseUrl });
	try {
		await migrateTenantDatabase(pool);
		const catalog = new SkillCatalogStore(pool);
		const results = root
			? await publishSkillsFromRoot({
				objects,
				catalog,
				skillsRoot: isAbsolute(root!) ? root! : resolve(process.cwd(), root!),
				source: "publish-cli",
			})
			: [
				await publishSkillFromDir({
					objects,
					catalog,
					skillDir: isAbsolute(skillDir!) ? skillDir! : resolve(process.cwd(), skillDir!),
					source: "publish-cli",
				}),
			];
		for (const result of results) {
			console.log(JSON.stringify(result));
		}
		if (results.length === 0) {
			console.error("No skills published (empty root or missing SKILL.md)");
			process.exitCode = 1;
		}
	} finally {
		await pool.end();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
});
