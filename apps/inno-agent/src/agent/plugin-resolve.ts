import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve a file inside an installed package to an absolute path, walking up
 * from the given module so it works from both `src/` (tsx) and compiled
 * `dist/`. Needed for packages whose exports map blocks the subpath we must
 * load through jiti (jiti enforces exports for package specifiers; absolute
 * file paths bypass that).
 */
export function resolvePluginFile(fromModuleUrl: string, packageName: string, entryRelPath: string): string {
	let dir = dirname(fileURLToPath(fromModuleUrl));
	for (;;) {
		const candidate = join(dir, "node_modules", packageName, entryRelPath);
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) throw new Error(`Cannot resolve ${packageName}/${entryRelPath} from ${fromModuleUrl}`);
		dir = parent;
	}
}
