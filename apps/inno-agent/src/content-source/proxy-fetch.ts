import { ProxyAgent, type Dispatcher } from "undici";
import { logger } from "../logger.js";

/**
 * Hub/bundle fetches go direct first; on a network-level failure they retry
 * once through the operator proxy (`INNO_HUB_PROXY`, falling back to
 * `HTTPS_PROXY`/`https_proxy`). Direct success never touches the proxy, so
 * healthy networks pay nothing.
 */
let proxyAgents = new Map<string, ProxyAgent>();

function proxyUrl(): string | undefined {
	return (
		process.env.INNO_HUB_PROXY?.trim() ||
		process.env.HTTPS_PROXY?.trim() ||
		process.env.https_proxy?.trim() ||
		undefined
	);
}

function agentFor(url: string): ProxyAgent {
	let agent = proxyAgents.get(url);
	if (!agent) {
		agent = new ProxyAgent(url);
		proxyAgents.set(url, agent);
	}
	return agent;
}

function isNetworkError(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	// HTTP responses (even 5xx) mean the network path worked — don't proxy those.
	return true;
}

export async function fetchRemote(url: string, init: RequestInit = {}): Promise<Response> {
	try {
		return await fetch(url, init);
	} catch (err) {
		const proxy = proxyUrl();
		if (!proxy || !isNetworkError(err)) throw err;
		logger.warn({ url, proxy }, "content-source: direct fetch failed, retrying through proxy");
		return await fetch(url, { ...init, dispatcher: agentFor(proxy) } as RequestInit & { dispatcher: Dispatcher });
	}
}
