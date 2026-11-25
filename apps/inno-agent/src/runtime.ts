import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPresetsDir } from "./config.js";

export interface RuntimePaths {
	codeDir: string;
	configDir: string;
	configPath: string;
	skillsDir: string;
	/** Preset workspace templates shipped in the image (like `skillsDir`). */
	presetsDir: string;
	workspaceDir: string;
	webDistDir: string;
}

export interface RuntimeCliOptions {
	config?: string;
	configDir?: string;
	home?: string;
	port?: number;
	skillsDir?: string;
	workspaceDir?: string;
}

export interface ParsedRuntimeArgs {
	options: RuntimeCliOptions;
	rest: string[];
}

const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

function packageRootFromCompiledSource(): string {
	return resolve(SOURCE_DIR, "..");
}

function invocationCwd(): string {
	return process.env.INIT_CWD && process.env.INIT_CWD.trim()
		? process.env.INIT_CWD
		: process.cwd();
}

function resolvePath(value: string | undefined, fallback: string): string {
	const raw = value && value.trim() ? value.trim() : fallback;
	return isAbsolute(raw) ? raw : resolve(invocationCwd(), raw);
}

function envPath(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim() ? value : undefined;
}

function parsePort(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const port = Number.parseInt(value, 10);
	return Number.isFinite(port) && port > 0 ? port : undefined;
}

export function parseRuntimeArgs(args: string[]): ParsedRuntimeArgs {
	const options: RuntimeCliOptions = {};
	const rest: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const readValue = (name: string): string => {
			const inline = arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : undefined;
			if (inline !== undefined) return inline;
			const value = args[++i];
			if (!value) throw new Error(`Missing value for ${name}`);
			return value;
		};

		if (arg === "--config" || arg.startsWith("--config=")) {
			options.config = readValue("--config");
		} else if (arg === "--config-dir" || arg.startsWith("--config-dir=")) {
			options.configDir = readValue("--config-dir");
		} else if (arg === "--home" || arg.startsWith("--home=")) {
			options.home = readValue("--home");
		} else if (arg === "--skills" || arg === "--skills-dir" || arg.startsWith("--skills=") || arg.startsWith("--skills-dir=")) {
			options.skillsDir = readValue(arg.startsWith("--skills-dir") ? "--skills-dir" : "--skills");
		} else if (arg === "--workspace" || arg === "--workspace-dir" || arg.startsWith("--workspace=") || arg.startsWith("--workspace-dir=")) {
			options.workspaceDir = readValue(arg.startsWith("--workspace-dir") ? "--workspace-dir" : "--workspace");
		} else if (arg === "--port" || arg.startsWith("--port=")) {
			const port = parsePort(readValue("--port"));
			if (!port) throw new Error(`Invalid port: ${arg}`);
			options.port = port;
		} else {
			rest.push(arg);
		}
	}

	return { options, rest };
}

export function resolveRuntimePaths(options: RuntimeCliOptions = {}): RuntimePaths {
	const codeDir = packageRootFromCompiledSource();
	const cwd = invocationCwd();
	const legacyConfigPath = join(cwd, ".inno", "config.json");
	const legacySkillsDir = join(cwd, ".inno", "skills");
	const defaultHome = existsSync(legacyConfigPath)
		? cwd
		: join(homedir(), ".inno-agent");

	const home = resolvePath(options.home ?? envPath("INNO_HOME"), defaultHome);
	const configDir = resolvePath(options.configDir ?? envPath("INNO_CONFIG_DIR"), existsSync(legacyConfigPath) ? join(cwd, ".inno") : join(home, "config"));
	const configPath = resolvePath(options.config ?? envPath("INNO_CONFIG_FILE"), join(configDir, "config.json"));
	// Platform path from config.json (`presets.dir`); no env/CLI override.
	const presetsDir = resolvePath(readPresetsDir(configPath), join(codeDir, "presets"));
	const skillsDir = resolvePath(options.skillsDir ?? envPath("INNO_SKILLS_DIR"), existsSync(legacySkillsDir) ? legacySkillsDir : join(home, "skills"));
	const workspaceDir = resolvePath(options.workspaceDir ?? envPath("INNO_WORKSPACE_DIR"), cwd);

	return {
		codeDir,
		configDir,
		configPath,
		skillsDir,
		presetsDir,
		workspaceDir,
		webDistDir: join(codeDir, "web", "dist"),
	};
}

export function applyRuntimeEnvironment(paths: RuntimePaths): void {
	process.env.INNO_CONFIG_DIR = paths.configDir;
	process.env.INNO_CONFIG_FILE = paths.configPath;
	process.env.INNO_SKILLS_DIR = paths.skillsDir;
	process.env.INNO_WORKSPACE_DIR = paths.workspaceDir;
}
