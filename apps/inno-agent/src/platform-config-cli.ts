import { Pool } from "pg";
import {
	pickMutableConfig,
	readRawConfigFile,
	savePlatformConfigDoc,
	type PlatformConfigDoc,
} from "./platform-config.js";

/**
 * Operator CLI: write the server-managed platform config (provider catalog,
 * channel endpoints/credentials, Tavily, content hub) into the
 * `platform_config` row. This row is the single source of truth — the
 * deployed config.json must not contain these keys.
 *
 * Usage: DATABASE_URL=... npx tsx src/platform-config-cli.ts <file.json>
 *        DATABASE_URL=... npx tsx src/platform-config-cli.ts --print
 *
 * With a file argument the row is replaced with the server-managed keys
 * found in that file (keys absent from the file are dropped). With
 * `--print` the current document is dumped and nothing is written.
 */

const args = process.argv.slice(2);
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
	console.error("DATABASE_URL is required");
	process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });
try {
	if (args.includes("--print")) {
		const result = await pool.query<{ config: string }>(
			"SELECT config FROM platform_config WHERE id = 1",
		);
		console.log(result.rows[0] ? JSON.stringify(JSON.parse(result.rows[0].config), null, 2) : "(no platform_config row)");
	} else {
		const file = args[0];
		if (!file) {
			console.error("usage: platform-config-cli <file.json> | --print");
			process.exit(1);
		}
		const doc: PlatformConfigDoc = pickMutableConfig(readRawConfigFile(file));
		if (Object.keys(doc).length === 0) {
			console.error(`${file} contains no server-managed keys (providers, channels, feishu, bridge, github, contentHub, tavily)`);
			process.exit(1);
		}
		await savePlatformConfigDoc(pool, doc);
		console.log(`platform_config updated: ${Object.keys(doc).sort().join(", ")}`);
	}
} finally {
	await pool.end();
}
