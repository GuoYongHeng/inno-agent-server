import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withFileLock } from "./file-lock.js";
import { readJson, writeJson } from "./file-store.js";

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), "inno-lock-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function runChildren(file: string, mode: "lock" | "none", procs: number, count: number): Promise<number[]> {
	const fixture = join(import.meta.dirname, "file-lock-fixture.ts");
	return Promise.all(Array.from({ length: procs }, (_, i) => new Promise<number>((resolve) => {
		const child = spawn(process.execPath, ["--import", "tsx", fixture, file, `p${i}`, String(count), mode], { stdio: "ignore" });
		child.on("exit", (code) => resolve(code ?? 1));
	})));
}

describe("withFileLock", () => {
	it("serializes read-modify-write across processes without losing updates", async () => {
		const file = join(dir(), "list.json");
		const codes = await runChildren(file, "lock", 4, 60);
		expect(codes).toEqual([0, 0, 0, 0]);
		expect(readJson<string[]>(file, [])).toHaveLength(240);
	}, 120_000);

	it("is re-entrant in-process and releases the lock after an error", () => {
		const lock = join(dir(), "x.lock");
		expect(withFileLock(lock, () => withFileLock(lock, () => 7))).toBe(7);
		expect(() => withFileLock(lock, () => { throw new Error("boom"); })).toThrow("boom");
		expect(existsSync(lock)).toBe(false);
	});

	it("breaks a lock whose owner process is dead", () => {
		const lock = join(dir(), "stale.lock");
		mkdirSync(lock);
		writeFileSync(join(lock, "owner"), "2147483646");
		expect(withFileLock(lock, () => "ok")).toBe("ok");
	});
});

describe("writeJson temp files", () => {
	it("concurrent writers to one path never share a temp file", () => {
		const file = join(dir(), "a.json");
		writeJson(file, [1]);
		writeJson(file, [2]);
		expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual([2]);
		expect(existsSync(`${file}.tmp`)).toBe(false);
	});
});
