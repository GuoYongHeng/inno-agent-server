import type { IncomingMessage } from "node:http";
import type { ResourceKind, TenantContext, TenantStore } from "./store.js";
import { enterTenantContext } from "./current.js";
import { HttpError } from "../server/http-helpers.js";

const requestTenants = new WeakMap<IncomingMessage, TenantContext>();

/** Tenant identity is populated only from the verified server-side session. */
export function setRequestTenant(req: IncomingMessage, context: TenantContext, store: TenantStore): void {
	requestTenants.set(req, context);
	enterTenantContext(context, store);
}

export function getRequestTenant(req: IncomingMessage): TenantContext | null {
	return requestTenants.get(req) ?? null;
}

/** Every authenticated request carries a verified tenant — a missing context
 * is a server wiring bug, not a mode. */
export function requireRequestTenant(req: IncomingMessage): TenantContext {
	const tenant = requestTenants.get(req);
	if (!tenant) throw new HttpError(500, "Missing tenant context on an authenticated request");
	return tenant;
}

/** Internal request-shaped scope for background services that already restore
 * verified tenant ALS. No socket or client-supplied identity is involved. */
export function createBackgroundRequest(context?: TenantContext, store?: TenantStore): IncomingMessage {
	const req = {} as IncomingMessage;
	if (context) {
		if (!store) throw new Error("A tenant store is required for a background tenant scope");
		setRequestTenant(req, context, store);
	}
	return req;
}

export async function ownsRequestResource(
	req: IncomingMessage,
	store: TenantStore,
	kind: ResourceKind,
	resourceId: string,
): Promise<boolean> {
	return store.ownsResource(requireRequestTenant(req), kind, resourceId);
}

export async function claimRequestResource(
	req: IncomingMessage,
	store: TenantStore,
	kind: ResourceKind,
	resourceId: string,
): Promise<void> {
	await store.claimResource(requireRequestTenant(req), kind, resourceId);
}

export async function releaseRequestResource(
	req: IncomingMessage,
	store: TenantStore,
	kind: ResourceKind,
	resourceId: string,
): Promise<void> {
	await store.releaseResource(requireRequestTenant(req), kind, resourceId);
}
