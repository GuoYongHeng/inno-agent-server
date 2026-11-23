import type { IncomingMessage as HttpReq, ServerResponse } from "node:http";
import { logger } from "../../logger.js";
import {
	PRESET_UNAVAILABLE_CODE,
	PresetUnavailableError,
	ensurePresetAvailable,
	instantiatePreset,
} from "../../presets/preset-store.js";
import type { RemoteContentSource } from "../../content-source/index.js";
import type { RuntimePaths } from "../../runtime.js";
import { TEMP_WORKSPACE_ID, type WorkspaceRegistry } from "../../workspace/workspace-registry.js";
import type { TenantStore } from "../../tenants/store.js";
import { claimRequestResource, getRequestTenant, ownsRequestResource, releaseRequestResource } from "../../tenants/http.js";
import { resolveRequestWorkspace } from "../../tenants/workspaces.js";
import type { WorkspaceReplica } from "../../workspace/workspace-replica.js";
import { HttpError, decodeRouteParam, json, readBody } from "../http-helpers.js";
import { handleDurableSessionResourceRoutes, type DurableHttpContext } from "../durable-routes.js";

/** Server-owned dependencies of the sessions routes. */
export interface SessionsRouteContext {
	workspaceRegistry: WorkspaceRegistry;
	paths: RuntimePaths;
	tenantStore?: TenantStore | null;
	workspaceReplica?: WorkspaceReplica | null;
	objectStorageDurable?: boolean;
	durableSessions: DurableHttpContext["service"];
	getContentSource: () => RemoteContentSource;
	getCachedPresetAvailability?: (presetId: string) => boolean | null;
}

/**
 * /api/sessions* route domain. Every session is a durable session: the
 * per-session routes live in durable-routes.ts, this file lists and creates them.
 */
export async function handleSessionsRoutes(
	req: HttpReq,
	res: ServerResponse,
	method: string,
	url: string,
	ctx: SessionsRouteContext,
): Promise<boolean> {
	const { workspaceRegistry, paths, getContentSource, getCachedPresetAvailability, tenantStore, durableSessions } = ctx;
	const workspaceReplica = ctx.workspaceReplica ?? null;

	// Every session subresource is protected before any metadata access.
	const sessionResourceMatch = /^\/api\/sessions\/([^/]+)(?:\/|$)/.exec(url.split("?", 1)[0]);
	if (sessionResourceMatch) {
		const id = decodeRouteParam(sessionResourceMatch[1]!);
		if (!await ownsRequestResource(req, tenantStore, "session", id)) {
			json(res, 404, { error: "Session not found" });
			return true;
		}
		if (await durableSessions.get(req, id)) {
			return handleDurableSessionResourceRoutes(req, res, method, url, id, {
				service: durableSessions,
				workspaceRegistry,
				tenantStore,
				workspaceReplica,
				objectStorageDurable: ctx.objectStorageDurable,
			});
		}
	}

	if (method === "GET" && url === "/api/sessions") {
		const tenant = getRequestTenant(req);
		if (!tenantStore && tenant) throw new Error("Tenant store is required for an authenticated request");
		const ownedSessionIds = tenant ? await tenantStore!.listResourceIds(tenant, "session") : null;
		// `limit`/`cursor` opt into cursor pagination; without them the legacy
		// full-array response is kept for existing clients.
		const query = new URL(url, "http://localhost").searchParams;
		const rawLimit = query.get("limit");
		const cursor = query.get("cursor")?.trim() || undefined;
		if (rawLimit !== null || cursor) {
			const parsed = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
			if (rawLimit !== null && (!Number.isInteger(parsed) || parsed < 1 || parsed > 500)) {
				json(res, 400, { error: "limit must be an integer between 1 and 500" });
				return true;
			}
			const page = await durableSessions.listPage(req, {
				...(Number.isInteger(parsed) ? { limit: parsed } : {}),
				...(cursor ? { cursor } : {}),
			});
			json(res, 200, {
				sessions: page.sessions.filter((summary) => !ownedSessionIds || ownedSessionIds.has(summary.id)),
				nextCursor: page.nextCursor,
			});
			return true;
		}
		const sessions = (await durableSessions.list(req))
			.filter((summary) => !ownedSessionIds || ownedSessionIds.has(summary.id))
			.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
		json(res, 200, sessions);
		return true;
	}

	if (method === "POST" && url === "/api/sessions") {
		const body = await readBody(req).catch((err: unknown) => {
			// An oversized body must still surface as 413 — only a missing or
			// malformed payload is treated as {}.
			if (err instanceof HttpError && err.statusCode === 413) throw err;
			return {};
		}) as Record<string, unknown>;
		const explicitWorkspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
		const presetId = typeof body.presetId === "string" ? body.presetId.trim() : "";
		const newWorkspaceSpec = body.newWorkspace && typeof body.newWorkspace === "object"
			? body.newWorkspace as { name?: unknown; isTemp?: unknown }
			: null;
		const tenant = getRequestTenant(req);
		const presetWorkspaceId = `preset-${presetId}${tenant ? `-${tenant.tenantId}` : ""}`;
		const existingPresetWorkspace = presetId
			? workspaceRegistry.getWorkspace(presetWorkspaceId)
			: null;
		if (existingPresetWorkspace && !await ownsRequestResource(req, tenantStore, "workspace", existingPresetWorkspace.id)) {
			json(res, 404, { error: "Workspace not found" });
			return true;
		}
		if (explicitWorkspaceId && explicitWorkspaceId !== TEMP_WORKSPACE_ID
			&& !await ownsRequestResource(req, tenantStore, "workspace", explicitWorkspaceId)) {
			json(res, 404, { error: "Workspace not found" });
			return true;
		}

		// `runtime` is accepted for older clients but only "durable" exists.
		if (body.runtime !== undefined && body.runtime !== "durable") {
			json(res, 400, { error: "runtime must be durable" });
			return true;
		}
		// Validate stale preset cards before creating anything. A preset that has
		// already been loaded keeps working through its stable workspace even if
		// the remote catalog later removes it.
		if (presetId && !existingPresetWorkspace) {
			try {
				await ensurePresetAvailable(
					paths,
					getContentSource(),
					presetId,
					getCachedPresetAvailability?.(presetId) ?? null,
				);
			} catch (err) {
				if (err instanceof PresetUnavailableError) {
					json(res, 404, {
						code: PRESET_UNAVAILABLE_CODE,
						presetId,
					});
				} else if (err instanceof Error && err.message.startsWith("Invalid preset id:")) {
					json(res, 400, { error: err.message, code: "INVALID_PRESET_ID", presetId });
				} else {
					logger.warn({ err, presetId }, "failed to prepare preset for session");
					json(res, 503, {
						error: "预设暂时不可用，请稍后重试",
						code: "PRESET_TEMPORARILY_UNAVAILABLE",
						presetId,
					});
				}
				return true;
			}
		}

		const workspace = presetId
			? existingPresetWorkspace ?? instantiatePreset(paths, workspaceRegistry, presetId, tenant?.tenantId)
			: newWorkspaceSpec && !newWorkspaceSpec.isTemp
				? workspaceRegistry.createWorkspace({
					name: typeof newWorkspaceSpec.name === "string" ? newWorkspaceSpec.name : undefined,
					isTemp: false,
				})
				: await resolveRequestWorkspace(req, workspaceRegistry, tenantStore, explicitWorkspaceId || TEMP_WORKSPACE_ID, workspaceReplica);
		if (!workspace) { json(res, 404, { error: "Workspace not found" }); return true; }
		if ((presetId && !existingPresetWorkspace) || (newWorkspaceSpec && !newWorkspaceSpec.isTemp)) {
			await claimRequestResource(req, tenantStore, "workspace", workspace.id);
		}
		let createdId = "";
		let claimed = false;
		try {
			const summary = await durableSessions.create(req, { workspaceId: workspace.id });
			createdId = summary.id;
			if (!workspaceRegistry.bindSession(summary.id, workspace.id)) throw new Error("Workspace not found");
			if (workspaceReplica && tenant) {
				await workspaceReplica.replicateWorkspace(tenant, workspace);
				await workspaceReplica.setSessionBinding(tenant, summary.id, workspace.id);
				const wsDir = workspaceRegistry.resolveWorkspaceDir(workspace.id);
				if (wsDir) await workspaceReplica.push(tenant, workspace.id, wsDir);
			}
			await claimRequestResource(req, tenantStore, "session", summary.id);
			claimed = true;
			json(res, 201, { id: summary.id, active: true, workspaceId: workspace.id, runtime: "durable" });
		} catch (error) {
			if (createdId) {
				await durableSessions.delete(req, createdId).catch(() => undefined);
				workspaceRegistry.unbindSession(createdId);
				if (claimed) await releaseRequestResource(req, tenantStore, "session", createdId).catch(() => undefined);
			}
			json(res, error instanceof Error && error.name === "DurableRuntimeDisabledError" ? 400 : 500, {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return true;
	}

	return false;
}
