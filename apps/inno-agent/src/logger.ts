import pino from "pino";
// pino-caller is a CJS module; at runtime its default export is the wrapper
// function, but TypeScript's CJS→ESM interop for this package doesn't expose
// callable signatures on the default. Cast through unknown as a workaround.
import _pinoCaller from "pino-caller";
const pinoCaller = _pinoCaller as unknown as (logger: pino.Logger) => pino.Logger;
import { Writable } from "node:stream";

/**
 * Logs always go to stdout — the platform (container runtime, systemd,
 * `restart-dev.sh`) owns rotation and retention. Resolving
 * `process.stdout.write` per call keeps it interceptable in tests.
 */
class StdoutStream extends Writable {
	_write(
		chunk: unknown,
		_encoding: BufferEncoding,
		callback: (error?: Error | null) => void,
	): void {
		process.stdout.write(chunk as string | Uint8Array);
		callback();
	}
}

/**
 * Shared Pino logger instance for HTTP request handling.
 *
 * Wrapped with {@link pinoCaller} to automatically record the TS source
 * location (file path + line number) for every log entry.
 */
const rawLogger = pino(
	{
		level: process.env.LOG_LEVEL ?? "info",
		timestamp: pino.stdTimeFunctions.isoTime,
	},
	new StdoutStream(),
);

const logger = pinoCaller(rawLogger);

export { logger };
