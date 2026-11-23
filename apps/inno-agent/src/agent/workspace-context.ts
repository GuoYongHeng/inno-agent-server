import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../logger.js";
import { formatSkillsForPrompt, loadSkillsFromDir } from "./skills.js";
import type { WorkspaceFileAccess } from "../workspace/workspace-files.js";

const WORKSPACE_AGENT_FILE = "agent.md";
const WORKSPACE_SKILLS_DIR = ".skills";

/** Build the same workspace prompt sections for legacy and durable sessions.
 * Private skills are prompt resources only; this does not install process-global
 * PI resources or make durable-only tools available to a skill. */
export function buildWorkspaceContextSections(workspaceDir: string): string[] {
	const sections: string[] = [];

	const agentFile = join(workspaceDir, WORKSPACE_AGENT_FILE);
	if (existsSync(agentFile)) {
		try {
			const content = readFileSync(agentFile, "utf-8").trim();
			if (content) {
				sections.push(`# 工作区上下文 (${WORKSPACE_AGENT_FILE})\n\n${content}`);
			}
		} catch (err) {
			logger.warn({ err }, "failed to read workspace agent.md");
			// Ignore unreadable agent.md
		}
	}

	const skillsDir = join(workspaceDir, WORKSPACE_SKILLS_DIR);
	if (existsSync(skillsDir)) {
		try {
			const { skills } = loadSkillsFromDir(skillsDir);
			if (skills.length > 0) {
				const block = formatSkillsForPrompt(skills);
				if (block.trim()) {
					sections.push(`# 本工作区私有技能\n${block}`);
				}
			}
		} catch (err) {
			logger.warn({ err }, "failed to discover workspace skills");
			// Ignore skill discovery failures
		}
	}

	return sections;
}

/** WorkspaceFileAccess variant of {@link buildWorkspaceContextSections}: reads
 * agent.md through `files.read` and materializes `.skills` via `withLocalDir`
 * so the same prompt sections work over store-backed workspaces. */
export async function buildWorkspaceContextSectionsFrom(files: WorkspaceFileAccess): Promise<string[]> {
	const sections: string[] = [];

	try {
		const body = await files.read(WORKSPACE_AGENT_FILE);
		const content = body ? Buffer.from(body).toString("utf-8").trim() : "";
		if (content) {
			sections.push(`# 工作区上下文 (${WORKSPACE_AGENT_FILE})\n\n${content}`);
		}
	} catch (err) {
		logger.warn({ err }, "failed to read workspace agent.md");
		// Ignore unreadable agent.md
	}

	try {
		const block = await files.withLocalDir(WORKSPACE_SKILLS_DIR, async (skillsDir) => {
			const { skills } = loadSkillsFromDir(skillsDir);
			return skills.length > 0 ? formatSkillsForPrompt(skills) : "";
		});
		if (block && block.trim()) {
			sections.push(`# 本工作区私有技能\n${block}`);
		}
	} catch (err) {
		logger.warn({ err }, "failed to discover workspace skills");
		// Ignore skill discovery failures
	}

	return sections;
}
