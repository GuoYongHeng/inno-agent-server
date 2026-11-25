import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimePaths } from "../runtime.js";
import type { WorkspaceMeta, WorkspaceRegistry } from "../workspace/workspace-registry.js";
import { logger } from "../logger.js";

/**
 * Preset templates surfaced in Simple Mode.
 *
 * Each preset is a directory under `paths.presetsDir` (`presets.dir` in
 * config.json, default `<codeDir>/presets`, baked into the image):
 *   - `preset.json` — `{ id, name, description, icon?, category?, skills? }`
 *     (`skills` are platform catalog skill ids; id must equal the directory name)
 *   - `agent.md`    — read-only instructions injected into the prompt (never
 *     copied into the user's workspace)
 *
 * Opening a preset creates/reuses an empty dedicated workspace for session
 * artifacts only. Bound skills are materialized from the skill catalog.
 */

export interface PresetMeta {
	id: string;
	name: string;
	description: string;
	icon?: string;
	category?: string;
	/** Platform `skill_catalog.skill_id` values bound to this preset. */
	skills: string[];
}

export const PRESET_UNAVAILABLE_CODE = "PRESET_UNAVAILABLE";

/** The requested preset is not part of the image. */
export class PresetUnavailableError extends Error {
	readonly code = PRESET_UNAVAILABLE_CODE;

	constructor(public readonly presetId: string) {
		super();
		this.name = "PresetUnavailableError";
	}
}

/** Only simple, single-segment ids — blocks path traversal. */
const PRESET_ID_RE = /^[a-zA-Z0-9._-]+$/;
const SKILL_ID_RE = /^[a-z0-9-]+$/;

function isValidPresetId(id: string): boolean {
	return PRESET_ID_RE.test(id) && id !== "." && id !== "..";
}

function parseSkills(raw: unknown, presetId: string): string[] {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) {
		logger.warn({ presetId }, "preset.json skills must be an array; ignoring");
		return [];
	}
	const out: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string") {
			logger.warn({ presetId, entry }, "preset.json skills entry is not a string; skipping");
			continue;
		}
		const id = entry.trim();
		if (!SKILL_ID_RE.test(id)) {
			logger.warn({ presetId, id }, "preset.json skills entry is not a valid skill id; skipping");
			continue;
		}
		if (!out.includes(id)) out.push(id);
	}
	return out;
}

function parsePresetMeta(rawText: string, id: string): PresetMeta | null {
	try {
		const raw = JSON.parse(rawText) as Partial<PresetMeta> & { skills?: unknown };
		const metaId = (raw.id ?? "").trim();
		// The declared id must match the directory name to keep instantiation safe.
		if (metaId !== id) {
			logger.warn({ metaId, id }, "preset.json id does not match directory name; skipping");
			return null;
		}
		const name = (raw.name ?? "").trim();
		if (!name) {
			logger.warn({ id }, "preset.json missing name; skipping");
			return null;
		}
		return {
			id,
			name,
			description: (raw.description ?? "").trim(),
			icon: raw.icon?.trim() || undefined,
			category: raw.category?.trim() || undefined,
			skills: parseSkills(raw.skills, id),
		};
	} catch (err) {
		logger.warn({ err, id }, "failed to parse preset.json; skipping");
		return null;
	}
}

function readPresetMeta(dir: string, id: string): PresetMeta | null {
	const metaPath = join(dir, "preset.json");
	if (!existsSync(metaPath)) return null;
	return parsePresetMeta(readFileSync(metaPath, "utf-8"), id);
}

/** List the presets shipped in the image (invalid ones are skipped). */
export function listPresets(paths: RuntimePaths): PresetMeta[] {
	const root = paths.presetsDir;
	if (!existsSync(root)) return [];
	const presets: PresetMeta[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (entry.name === "__MACOSX" || entry.name.startsWith(".") || entry.name.startsWith("_")) continue;
		if (!isValidPresetId(entry.name)) continue;
		const meta = readPresetMeta(join(root, entry.name), entry.name);
		if (meta) presets.push(meta);
	}
	return presets.sort((a, b) => a.name.localeCompare(b.name));
}

/** Look a preset up in the image. Throws `PresetUnavailableError` when it is not there. */
export function resolvePresetMeta(paths: RuntimePaths, presetId: string): PresetMeta {
	const id = presetId.trim();
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${presetId}`);
	}
	const meta = readPresetMeta(join(paths.presetsDir, id), id);
	if (!meta) throw new PresetUnavailableError(id);
	return meta;
}

/** Read-only preset instructions from the image; never written to the workspace. */
export function readPresetAgentMd(paths: RuntimePaths, presetId: string): string | undefined {
	const id = presetId.trim();
	if (!isValidPresetId(id)) return undefined;
	const agentPath = join(paths.presetsDir, id, "agent.md");
	if (!existsSync(agentPath)) return undefined;
	try {
		const content = readFileSync(agentPath, "utf-8").trim();
		return content || undefined;
	} catch (err) {
		logger.warn({ err, presetId: id }, "failed to read preset agent.md");
		return undefined;
	}
}

/**
 * Open a preset: return its stable dedicated workspace (empty of template
 * files). Repeatedly opening the same preset reuses one workspace so
 * conversations for that task stay together. `agent.md` and bound skills are
 * injected at session-open time from the image / skill catalog.
 */
export function instantiatePreset(
	_paths: RuntimePaths,
	registry: WorkspaceRegistry,
	meta: PresetMeta,
	tenantScope?: string,
): WorkspaceMeta {
	const id = meta.id;
	if (!isValidPresetId(id)) {
		throw new Error(`Invalid preset id: ${id}`);
	}
	const { ws, created } = registry.ensurePresetWorkspace(id, meta.name, tenantScope);
	const destDir = registry.resolveWorkspaceDir(ws.id);
	if (!destDir) {
		throw new Error(`Failed to resolve workspace dir for ${ws.id}`);
	}
	if (!created) {
		logger.info({ presetId: id, workspaceId: ws.id }, "reused existing preset workspace");
		return ws;
	}
	logger.info({ presetId: id, workspaceId: ws.id }, "created empty preset workspace");
	return ws;
}
