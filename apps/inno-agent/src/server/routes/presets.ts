import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { listPresets } from "../../presets/preset-store.js";
import type { RuntimePaths } from "../../runtime.js";
import { json } from "../http-helpers.js";

export interface PresetsRouteContext {
	paths: RuntimePaths;
}

/**
 * /api/presets and /api/preset-library route domain (ready-to-use workspace
 * templates). Returns true when the request was handled. Extracted verbatim
 * from server.ts during the P2 route split — behavior unchanged.
 */
export async function handlePresetsRoutes(
	_req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: PresetsRouteContext,
): Promise<boolean> {
	const { paths } = ctx;

	// Presets ship in the image (`presets.dir` in config.json). `/api/preset-library` is
	// kept as an alias for clients that still call it; `refresh` is ignored.
	if (method === "GET" && (url === "/api/presets" || url.split("?")[0] === "/api/preset-library")) {
		json(res, 200, listPresets(paths));
		return true;
	}

	return false;
}
