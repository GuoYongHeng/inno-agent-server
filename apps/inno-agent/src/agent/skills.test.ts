import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGlobalSkillsSection, formatSkillsForPrompt, loadSkillsFromDir } from "./skills.js";

const roots: string[] = [];

function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "inno-skills-"));
	roots.push(dir);
	return dir;
}

function skill(dir: string, path: string, frontmatter: string, body = "Body"): void {
	const full = join(dir, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, `---\n${frontmatter}\n---\n${body}\n`);
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadSkillsFromDir", () => {
	it("loads a SKILL.md and stops descending into that directory", () => {
		const dir = root();
		skill(dir, "alpha/SKILL.md", "name: alpha\ndescription: Alpha skill");
		skill(dir, "alpha/nested/SKILL.md", "name: nested\ndescription: Must not load");
		const { skills } = loadSkillsFromDir(dir);
		expect(skills.map((s) => s.name)).toEqual(["alpha"]);
		expect(skills[0]).toMatchObject({ description: "Alpha skill", baseDir: join(dir, "alpha"), disableModelInvocation: false });
	});

	it("falls back to the directory name and only takes loose .md files that declare a description", () => {
		const dir = root();
		skill(dir, "by-dir/SKILL.md", "description: Named by directory");
		skill(dir, "loose.md", "name: loose\ndescription: Loose skill");
		skill(dir, "notes.md", "title: not a skill");
		const names = loadSkillsFromDir(dir).skills.map((s) => s.name).sort();
		expect(names).toEqual(["by-dir", "loose"]);
	});

	it("skips skills without a description and reports a warning for invalid names", () => {
		const dir = root();
		skill(dir, "no-desc/SKILL.md", "name: no-desc");
		skill(dir, "Bad_Name/SKILL.md", "description: Odd name");
		const result = loadSkillsFromDir(dir);
		expect(result.skills.map((s) => s.name)).toEqual(["Bad_Name"]);
		expect(result.diagnostics.map((d) => d.message)).toEqual(expect.arrayContaining([
			"description is required",
			expect.stringContaining("invalid characters"),
		]));
	});

	it("honours .ignore entries written by the skills panel for disabled skills", () => {
		const dir = root();
		skill(dir, "on/SKILL.md", "description: Enabled");
		skill(dir, "off/SKILL.md", "description: Disabled");
		writeFileSync(join(dir, ".ignore"), "off/\n");
		expect(loadSkillsFromDir(dir).skills.map((s) => s.name)).toEqual(["on"]);
	});

	it("supports negation, globs and comments in ignore files", () => {
		const dir = root();
		for (const name of ["draft-a", "draft-b", "keep"]) skill(dir, `${name}/SKILL.md`, "description: x");
		writeFileSync(join(dir, ".ignore"), "# drafts\ndraft-*/\n!draft-b/\n");
		expect(loadSkillsFromDir(dir).skills.map((s) => s.name).sort()).toEqual(["draft-b", "keep"]);
	});

	it("follows symlinked skill directories and ignores broken links and dot/node_modules entries", () => {
		const dir = root();
		const target = root();
		skill(target, "linked/SKILL.md", "description: Linked");
		symlinkSync(join(target, "linked"), join(dir, "linked"));
		symlinkSync(join(dir, "missing"), join(dir, "broken"));
		skill(dir, ".hidden/SKILL.md", "description: hidden");
		skill(dir, "node_modules/pkg/SKILL.md", "description: dependency");
		expect(loadSkillsFromDir(dir).skills.map((s) => s.name)).toEqual(["linked"]);
	});

	it("returns nothing for a missing directory", () => {
		expect(loadSkillsFromDir(join(tmpdir(), "inno-skills-does-not-exist"))).toEqual({ skills: [], diagnostics: [] });
	});
});

describe("formatSkillsForPrompt", () => {
	it("renders an escaped available_skills block and omits model-disabled skills", () => {
		const dir = root();
		skill(dir, "shown/SKILL.md", `description: "Uses <tags> & 'quotes'"`);
		skill(dir, "hidden/SKILL.md", "description: Hidden\ndisable-model-invocation: true");
		const block = formatSkillsForPrompt(loadSkillsFromDir(dir).skills);
		expect(block).toContain("<available_skills>");
		expect(block).toContain("<name>shown</name>");
		expect(block).toContain("Uses &lt;tags&gt; &amp; &apos;quotes&apos;");
		expect(block).toContain(`<location>${join(dir, "shown", "SKILL.md")}</location>`);
		expect(block).not.toContain("<name>hidden</name>");
	});

	it("returns an empty string when no skill is visible", () => {
		expect(formatSkillsForPrompt([])).toBe("");
	});
});

describe("buildGlobalSkillsSection", () => {
	it("returns a titled section for enabled skills and undefined otherwise", () => {
		const dir = root();
		expect(buildGlobalSkillsSection(dir)).toBeUndefined();
		expect(buildGlobalSkillsSection(undefined)).toBeUndefined();
		skill(dir, "alpha/SKILL.md", "description: Alpha");
		expect(buildGlobalSkillsSection(dir)).toContain("<name>alpha</name>");
		writeFileSync(join(dir, ".ignore"), "alpha/\n");
		expect(buildGlobalSkillsSection(dir)).toBeUndefined();
	});
});
