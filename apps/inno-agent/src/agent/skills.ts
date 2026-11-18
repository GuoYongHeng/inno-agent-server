import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { logger } from "../logger.js";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

export interface Skill {
	name: string;
	description: string;
	/** Absolute path of the skill's markdown file. */
	filePath: string;
	/** Directory containing the skill file. */
	baseDir: string;
	/** Hidden from the prompt; invocable only by an explicit request. */
	disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
	type: "warning";
	message: string;
	path: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: SkillDiagnostic[];
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, unknown> {
	const normalized = content.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return {};
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return {};
	const parsed = parseYaml(normalized.slice(4, end));
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Ignore rules: the gitignore subset that skill directories use.
//   `name`, `name/`, `/name`, `*`, `?`, `**`, `!negation`, `# comment`
// ---------------------------------------------------------------------------

interface IgnoreRule {
	negated: boolean;
	dirOnly: boolean;
	regex: RegExp;
}

function toPosix(path: string): string {
	return path.split(sep).join("/");
}

function globToRegex(glob: string, anchored: boolean): RegExp {
	let out = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				// `**/` matches zero or more directories; a trailing `**` matches the rest.
				if (glob[i + 2] === "/") {
					out += "(?:.*/)?";
					i += 2;
				} else {
					out += ".*";
					i += 1;
				}
			} else {
				out += "[^/]*";
			}
		} else if (ch === "?") {
			out += "[^/]";
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	// Unanchored patterns without a slash match at any depth; an ignored
	// directory also hides everything beneath it.
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${out}(?:/.*)?$`);
}

function parseIgnoreRule(line: string, prefix: string): IgnoreRule | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
	let pattern = line.replace(/\s+$/, "");
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) {
		pattern = pattern.slice(1);
	}
	let dirOnly = false;
	if (pattern.endsWith("/")) {
		dirOnly = true;
		pattern = pattern.slice(0, -1);
	}
	if (!pattern) return null;
	const anchored = pattern.startsWith("/") || pattern.includes("/");
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	return { negated, dirOnly, regex: globToRegex(`${prefix}${pattern}`, anchored || prefix !== "") };
}

class IgnoreMatcher {
	private readonly rules: IgnoreRule[] = [];

	addDir(dir: string, rootDir: string): void {
		const rel = relative(rootDir, dir);
		const prefix = rel ? `${toPosix(rel)}/` : "";
		for (const fileName of IGNORE_FILE_NAMES) {
			const path = join(dir, fileName);
			if (!existsSync(path)) continue;
			try {
				for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
					const rule = parseIgnoreRule(line, prefix);
					if (rule) this.rules.push(rule);
				}
			} catch {
				// An unreadable ignore file must not stop skill discovery.
			}
		}
	}

	ignores(relPath: string, isDirectory: boolean): boolean {
		let ignored = false;
		for (const rule of this.rules) {
			if (rule.dirOnly && !isDirectory && !rule.regex.test(`${relPath}/`)) continue;
			const target = rule.dirOnly && isDirectory ? `${relPath}/` : relPath;
			if (rule.regex.test(target) || (rule.dirOnly && rule.regex.test(relPath))) {
				ignored = !rule.negated;
			}
		}
		return ignored;
	}
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function validateName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function loadSkillFromFile(filePath: string): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
	const diagnostics: SkillDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf-8");
	} catch (error) {
		diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "failed to read skill file", path: filePath });
		return { skill: null, diagnostics };
	}
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter(raw);
	} catch (error) {
		if (isDeclaredSkill) {
			diagnostics.push({ type: "warning", message: error instanceof Error ? error.message : "failed to parse skill file", path: filePath });
		}
		return { skill: null, diagnostics };
	}
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	// A loose markdown file is a skill only when it declares a description.
	if (!isDeclaredSkill && !hasDescription) return { skill: null, diagnostics };

	if (!hasDescription) {
		diagnostics.push({ type: "warning", message: "description is required", path: filePath });
	} else if ((description as string).length > MAX_DESCRIPTION_LENGTH) {
		diagnostics.push({ type: "warning", message: `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${(description as string).length})`, path: filePath });
	}
	const baseDir = dirname(filePath);
	const name = typeof frontmatter.name === "string" && frontmatter.name ? frontmatter.name : basename(baseDir);
	for (const message of validateName(name)) diagnostics.push({ type: "warning", message, path: filePath });
	if (!hasDescription) return { skill: null, diagnostics };
	return {
		skill: {
			name,
			description: description as string,
			filePath,
			baseDir,
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

function loadFromDir(
	dir: string,
	includeRootFiles: boolean,
	matcher: IgnoreMatcher,
	rootDir: string,
): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: SkillDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };
	matcher.addDir(dir, rootDir);
	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		// A directory holding SKILL.md is a skill root: do not look further.
		for (const entry of entries) {
			if (entry.name !== "SKILL.md") continue;
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile || matcher.ignores(toPosix(relative(rootDir, fullPath)), false)) continue;
			const result = loadSkillFromFile(fullPath);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // broken symlink
				}
			}
			if (matcher.ignores(toPosix(relative(rootDir, fullPath)), isDirectory)) continue;
			if (isDirectory) {
				const sub = loadFromDir(fullPath, false, matcher, rootDir);
				skills.push(...sub.skills);
				diagnostics.push(...sub.diagnostics);
				continue;
			}
			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
			const result = loadSkillFromFile(fullPath);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
		}
	} catch {
		// Unreadable directories contribute no skills.
	}
	return { skills, diagnostics };
}

/**
 * Discover skills below `dir`.
 *
 * - a directory containing SKILL.md is a skill root and is not searched further;
 * - otherwise direct `.md` children with a `description` are skills;
 * - subdirectories are searched for SKILL.md;
 * - `.gitignore` / `.ignore` / `.fdignore` files exclude entries (the skills
 *   panel writes disabled skills to `.ignore`).
 */
export function loadSkillsFromDir(dir: string): LoadSkillsResult {
	return loadFromDir(dir, true, new IgnoreMatcher(), dir);
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** Render skills as the `<available_skills>` block. Skills that disable model
 * invocation are omitted. Returns "" when nothing is visible. */
export function formatSkillsForPrompt(skills: Skill[]): string {
	const visible = skills.filter((skill) => !skill.disableModelInvocation);
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

/** Prompt section for the shared (global) skills directory, or `undefined` when
 * it holds no enabled skills. Failures never block a session from opening. */
export function buildGlobalSkillsSection(skillsDir: string | undefined): string | undefined {
	if (!skillsDir) return undefined;
	try {
		const { skills } = loadSkillsFromDir(skillsDir);
		const block = formatSkillsForPrompt(skills);
		return block.trim() ? `# 可用技能\n${block}` : undefined;
	} catch (err) {
		logger.warn({ err }, "failed to discover global skills");
		return undefined;
	}
}
