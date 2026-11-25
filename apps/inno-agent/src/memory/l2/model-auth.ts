import type { Api, Model } from "@earendil-works/pi-ai";

/** Request credentials resolved for one model. */
export type ResolvedModelAuth =
	| { ok: true; apiKey?: string; headers?: Record<string, string> }
	| { ok: false; error: string };

/**
 * The only model-registry capability L2 wiki generation needs: resolve the API
 * key and headers for a model before a direct completion. Any registry that
 * exposes this method satisfies it, so L2 does not depend on a particular
 * agent runtime.
 */
export interface ModelAuthProvider {
	getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedModelAuth>;
}
