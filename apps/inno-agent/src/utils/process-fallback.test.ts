import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler } from "./process-fallback.js";

function setup(shuttingDown = false, exitTimeoutMs?: number, onClose?: () => void | Promise<void>) {
	const state = { shuttingDown };
	const server = { close: vi.fn<(callback: () => void) => void>() };
	const exit = vi.fn<(code: number) => void>();
	const shutdown = createGracefulShutdownHandler({ server, exit, exitTimeoutMs, onClose }, state);
	return { state, server, exit, shutdown };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

describe("graceful shutdown handler", () => {
	it("closes the server and claims the shared shutdown state", () => {
		const { state, server, exit, shutdown } = setup();

		shutdown();

		expect(state.shuttingDown).toBe(true);
		expect(server.close).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
		expect(exit).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("exits immediately on a second call without repeating cleanup", () => {
		const { server, exit, shutdown } = setup();

		shutdown();
		shutdown();

		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(server.close).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
	});

	it("forces exit at eight seconds even when close callbacks never finish", async () => {
		const { exit, shutdown } = setup();

		shutdown();
		await vi.advanceTimersByTimeAsync(7_999);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("waits for the server and the cleanup hook before exiting", async () => {
		let finishCleanup!: () => void;
		const cleanup = new Promise<void>((resolve) => { finishCleanup = resolve; });
		const { server, exit, shutdown } = setup(false, undefined, () => cleanup);

		shutdown();
		server.close.mock.calls[0]![0]();
		await vi.advanceTimersByTimeAsync(0);
		expect(exit).not.toHaveBeenCalled();
		finishCleanup();
		await vi.advanceTimersByTimeAsync(0);
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(8_000);
		expect(exit).toHaveBeenCalledTimes(1);
	});

	it("uses an injected exit timeout", async () => {
		const { exit, shutdown } = setup(false, 50);

		shutdown();
		await vi.advanceTimersByTimeAsync(49);
		expect(exit).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("exits without cleanup when the shared shutdown state is already claimed", () => {
		const { server, exit, shutdown } = setup(true);

		shutdown();

		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(server.close).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("closes authentication resources before exiting", async () => {
		const onClose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
		const { server, exit, shutdown } = setup(false, undefined, onClose);
		server.close.mockImplementation((callback) => callback());

		shutdown();
		await vi.advanceTimersByTimeAsync(0);

		expect(onClose).toHaveBeenCalledOnce();
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
	});

	it("still exits when closing the server throws", async () => {
		const { server, exit, shutdown } = setup();
		server.close.mockImplementation(() => { throw new Error("server close failed"); });

		shutdown();
		await vi.advanceTimersByTimeAsync(0);

		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(vi.getTimerCount()).toBe(0);
	});
});
