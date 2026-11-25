import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPresetsDir } from "./config.js";
import { writeFileSync } from "node:fs";

let dir: string | undefined;

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = undefined;
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
