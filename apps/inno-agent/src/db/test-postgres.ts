import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Pool } from "pg";

export interface TemporaryPostgres {
	databaseUrl: string;
	close(): Promise<void>;
}

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Unable to allocate PostgreSQL test port");
	const port = address.port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function run(command: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk; });
		child.stderr.on("data", (chunk) => { output += chunk; });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${output}`)));
	});
}

export async function startTemporaryPostgres(): Promise<TemporaryPostgres> {
	const externalUrl = process.env.INNO_TEST_DATABASE_URL;
	if (externalUrl) {
		const databaseName = `inno_test_${randomUUID().replaceAll("-", "")}`;
		const admin = new Pool({ connectionString: externalUrl });
		const databaseUrl = new URL(externalUrl);
		databaseUrl.pathname = `/${databaseName}`;
		try {
			await admin.query(`CREATE DATABASE ${databaseName}`);
			return {
				databaseUrl: databaseUrl.toString(),
				async close() {
					await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
					await admin.end();
				},
			};
		} catch (err) {
			await admin.end();
			throw new Error(`Unable to create a temporary PostgreSQL database: ${String(err)}`);
		}
	}

	// No external URL: start a disposable ParadeDB container. A plain PostgreSQL
	// from initdb cannot be used because the schema needs pg_search.
	const image = process.env.INNO_TEST_PARADEDB_IMAGE ?? "paradedb/paradedb:v0.25.11-pg17";
	const port = await unusedPort();
	const name = `inno-it-${randomUUID().slice(0, 8)}`;
	let pool: Pool | undefined;
	try {
		await run("docker", ["run", "-d", "--rm", "--name", name, "-e", "POSTGRES_USER=inno", "-e", "POSTGRES_PASSWORD=inno", "-p", `127.0.0.1:${port}:5432`, image]);
		const databaseUrl = `postgresql://inno:inno@127.0.0.1:${port}/postgres`;
		pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 500 });
		const deadline = Date.now() + 60_000;
		while (true) {
			try {
				await pool.query("SELECT 1");
				break;
			} catch (err) {
				if (Date.now() >= deadline) throw err;
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
		return {
			databaseUrl,
			async close() {
				await pool?.end();
				await run("docker", ["rm", "-f", name]).catch(() => undefined);
			},
		};
	} catch (err) {
		await pool?.end();
		await run("docker", ["rm", "-f", name]).catch(() => undefined);
		throw new Error(`Integration tests need a ParadeDB database: set INNO_TEST_DATABASE_URL or make docker and the ${image} image available: ${String(err)}`);
	}
}
