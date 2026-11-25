import type { TenantStateKv } from "../tenants/state-store.js";

export const BTW_STATE_VERSION = 1 as const;
export const BTW_INTERRUPTED_ERROR = "回答在应用关闭时中断，请重试";

export type BtwExchangeStatus = "pending" | "done" | "error";

export interface BtwExchangeState {
	id: string;
	question: string;
	answer: string;
	status: BtwExchangeStatus;
	error?: string;
	broughtBack?: boolean;
}

export interface BtwTabState {
	id: string;
	number: number;
	draft: string;
	scrollTop: number;
	exchanges: BtwExchangeState[];
}

export interface BtwSessionState {
	nextTabNumber: number;
	activeTabId: string | null;
	tabs: BtwTabState[];
}

export interface BtwWindowGeometry {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Window chrome shared by every session of a tenant (`btw:window`). */
export interface BtwWindowState {
	window: BtwWindowGeometry;
	windowInitialized: boolean;
	minimized: boolean;
}

export interface BtwStateResponse {
	session: BtwSessionState;
	window: BtwWindowGeometry;
	windowInitialized: boolean;
	minimized: boolean;
}

const DEFAULT_WINDOW: BtwWindowGeometry = {
	x: 0,
	y: 0,
	width: 520,
	height: 420,
};

const WINDOW_KEY = "btw:window";
const sessionKey = (sessionId: string) => `btw:session:${sessionId}`;

/** Sessions whose pending exchanges were already reconciled in this process. */
let restored = new Set<string>();

function defaultSession(): BtwSessionState {
	return { nextTabNumber: 1, activeTabId: null, tabs: [] };
}

function finiteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeExchange(raw: unknown, restorePending: boolean): BtwExchangeState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = typeof item.id === "string" && item.id ? item.id : "";
	const question = typeof item.question === "string" ? item.question : "";
	const answer = typeof item.answer === "string" ? item.answer : "";
	const status = item.status === "pending" || item.status === "done" || item.status === "error"
		? item.status
		: null;
	if (!id || !question || !status) return null;

	const interrupted = restorePending && status === "pending";
	return {
		id,
		question,
		answer,
		status: interrupted ? "error" : status,
		...(typeof item.error === "string" && item.error ? { error: item.error } : {}),
		...(interrupted ? { error: BTW_INTERRUPTED_ERROR } : {}),
		...(item.broughtBack === true ? { broughtBack: true } : {}),
	};
}

function normalizeTab(raw: unknown, restorePending: boolean): BtwTabState | null {
	if (!raw || typeof raw !== "object") return null;
	const item = raw as Record<string, unknown>;
	const id = typeof item.id === "string" && item.id ? item.id : "";
	const number = finiteNumber(item.number, 0);
	if (!id || number < 1) return null;
	const rawExchanges = Array.isArray(item.exchanges) ? item.exchanges : [];
	return {
		id,
		number: Math.floor(number),
		draft: typeof item.draft === "string" ? item.draft : "",
		scrollTop: Math.max(0, finiteNumber(item.scrollTop, 0)),
		exchanges: rawExchanges
			.map((exchange) => normalizeExchange(exchange, restorePending))
			.filter((exchange): exchange is BtwExchangeState => exchange !== null),
	};
}

function normalizeSession(raw: unknown, restorePending: boolean): BtwSessionState {
	if (!raw || typeof raw !== "object") return defaultSession();
	const item = raw as Record<string, unknown>;
	const tabs = (Array.isArray(item.tabs) ? item.tabs : [])
		.map((tab) => normalizeTab(tab, restorePending))
		.filter((tab): tab is BtwTabState => tab !== null);
	const maxNumber = tabs.reduce((max, tab) => Math.max(max, tab.number), 0);
	const requestedNext = finiteNumber(item.nextTabNumber, 1);
	const activeTabId = typeof item.activeTabId === "string" && tabs.some((tab) => tab.id === item.activeTabId)
		? item.activeTabId
		: (tabs[0]?.id ?? null);
	return {
		nextTabNumber: Math.max(1, Math.floor(requestedNext), maxNumber + 1),
		activeTabId,
		tabs,
	};
}

function normalizeWindow(raw: unknown): BtwWindowState {
	const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
	const rawWindow = item.window && typeof item.window === "object" ? item.window as Record<string, unknown> : {};
	return {
		window: {
			x: finiteNumber(rawWindow.x, DEFAULT_WINDOW.x),
			y: finiteNumber(rawWindow.y, DEFAULT_WINDOW.y),
			width: Math.max(1, finiteNumber(rawWindow.width, DEFAULT_WINDOW.width)),
			height: Math.max(1, finiteNumber(rawWindow.height, DEFAULT_WINDOW.height)),
		},
		windowInitialized: item.windowInitialized === true,
		minimized: item.minimized === true,
	};
}

/**
 * Load one session's BTW state. The first read of a session in this process
 * turns exchanges still marked `pending` into errors (their request died with
 * the previous process) and persists that; later reads return stored state so
 * exchanges that are genuinely in flight stay pending.
 */
export async function readBtwState(kv: TenantStateKv, sessionId: string): Promise<BtwStateResponse> {
	const win = normalizeWindow(await kv.get<unknown>(WINDOW_KEY));
	const raw = await kv.get<unknown>(sessionKey(sessionId));
	const restoreKey = `${kv.scope ?? ""}\0${sessionId}`;
	let session: BtwSessionState;
	if (raw === undefined) {
		session = defaultSession();
	} else if (!restored.has(restoreKey)) {
		session = normalizeSession(raw, true);
		await kv.set(sessionKey(sessionId), session);
	} else {
		session = normalizeSession(raw, false);
	}
	restored.add(restoreKey);
	return { session, ...win };
}

export async function writeBtwState(kv: TenantStateKv, sessionId: string, input: BtwStateResponse): Promise<BtwStateResponse> {
	const current = normalizeWindow(await kv.get<unknown>(WINDOW_KEY));
	const win: BtwWindowState = {
		window: {
			x: finiteNumber(input.window.x, current.window.x),
			y: finiteNumber(input.window.y, current.window.y),
			width: Math.max(1, finiteNumber(input.window.width, current.window.width)),
			height: Math.max(1, finiteNumber(input.window.height, current.window.height)),
		},
		windowInitialized: input.windowInitialized === true,
		minimized: input.minimized === true,
	};
	const session = normalizeSession(input.session, false);
	await kv.set(WINDOW_KEY, win);
	await kv.set(sessionKey(sessionId), session);
	restored.add(`${kv.scope ?? ""}\0${sessionId}`);
	return { session, ...win };
}

export async function clearSessionBtw(kv: TenantStateKv, sessionId: string): Promise<void> {
	await kv.delete(sessionKey(sessionId));
	restored.delete(`${kv.scope ?? ""}\0${sessionId}`);
}

export function resetBtwStoreForTests(): void {
	restored = new Set<string>();
}
