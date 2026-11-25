import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureLogging, logger } from "./logger.js";
import { readLoggingDir, readPresetsDir } from "./config.js";
import { writeFileSync } from "node:fs";

let dir: string | undefined;

afterEach(() => {
	configureLogging({});
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
});

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

describe("logger destination", () => {
	it("writes daily files into the configured directory and creates it lazily", async () => {
		dir = mkdtempSync(join(tmpdir(), "inno-logger-"));
		const logDir = join(dir, "nested", "logs");
		configureLogging({ dir: logDir });
		const previousLevel = logger.level;
		logger.level = "info"; // unit tests run with LOG_LEVEL=silent
		expect(existsSync(logDir)).toBe(false);
		logger.info("hello-from-logger-test");
		const read = () => existsSync(logDir) ? readdirSync(logDir).map((f) => readFileSync(join(logDir, f), "utf-8")).join("") : "";
		await until(() => read().includes("hello-from-logger-test"));
		expect(readdirSync(logDir)[0]).toMatch(/^server-\d{4}-\d{2}-\d{2}\.log$/);
		expect(read()).toContain("hello-from-logger-test");
		logger.level = previousLevel;
	});
});

describe("readLoggingDir", () => {
	it("reads logging.dir and ignores missing, blank or broken configs", () => {
		dir = mkdtempSync(join(tmpdir(), "inno-logger-cfg-"));
		const file = join(dir, "config.json");
		expect(readLoggingDir(file)).toBeUndefined();
		writeFileSync(file, "not json");
		expect(readLoggingDir(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ logging: { dir: "  " } }));
		expect(readLoggingDir(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ logging: { dir: "/var/log/inno" } }));
		expect(readLoggingDir(file)).toBe("/var/log/inno");
	});
});

describe("readPresetsDir", () => {
	it("reads presets.dir and ignores missing, blank or broken configs", () => {
		dir = mkdtempSync(join(tmpdir(), "inno-presets-cfg-"));
		const file = join(dir, "config.json");
		expect(readPresetsDir(file)).toBeUndefined();
		writeFileSync(file, "not json");
		expect(readPresetsDir(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ presets: { dir: "  " } }));
		expect(readPresetsDir(file)).toBeUndefined();
		writeFileSync(file, JSON.stringify({ presets: { dir: "/app/presets" } }));
		expect(readPresetsDir(file)).toBe("/app/presets");
	});
});
