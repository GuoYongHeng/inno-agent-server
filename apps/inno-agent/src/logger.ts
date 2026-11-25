import pino from "pino";
// pino-caller is a CJS module; at runtime its default export is the wrapper
// function, but TypeScript's CJS→ESM interop for this package doesn't expose
// callable signatures on the default. Cast through unknown as a workaround.
import _pinoCaller from "pino-caller";
const pinoCaller = _pinoCaller as unknown as (logger: pino.Logger) => pino.Logger;
import { createWriteStream, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";

/**
 * Where log lines go. Until `configureLogging` is called with a directory
 * (`logging.dir` in config.json) everything is written to stdout; the
 * platform (container runtime, systemd, `restart-dev.sh`) then owns the
 * files. Resolving `process.stdout.write` per call keeps it interceptable in
 * tests.
 */
let logDir: string | undefined;

/**
 * Writable stream that writes to stdout, or — when a log directory is
 * configured — lazily creates the directory and a `server-YYYY-MM-DD.log`
 * file on the first write and rotates to a new file each day.
 */
class LogStream extends Writable {
  private fileStream: ReturnType<typeof createWriteStream> | null = null;
  /** The date (YYYY-MM-DD) and directory the open fileStream belongs to. */
  private current = "";

  _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!logDir) {
      this.closeFile();
      process.stdout.write(chunk as string | Uint8Array);
      callback();
      return;
    }

    const today = new Date().toISOString().slice(0, 10); // "2026-06-09"
    const key = `${logDir}|${today}`;
    if (!this.fileStream || this.current !== key) {
      this.closeFile();
      try {
        mkdirSync(logDir, { recursive: true });
        this.fileStream = createWriteStream(join(logDir, `server-${today}.log`), { flags: "a" });
        this.current = key;
      } catch (err) {
        // An unwritable log directory must not take the server down.
        process.stderr.write(`[logger] cannot open log directory ${logDir}: ${String(err)}\n`);
        logDir = undefined;
        process.stdout.write(chunk as string | Uint8Array);
        callback();
        return;
      }
    }

    this.fileStream.write(chunk, encoding, callback as (error?: Error | null) => void);
  }

  private closeFile(): void {
    this.fileStream?.end();
    this.fileStream = null;
    this.current = "";
  }

  _final(callback: (error?: Error | null) => void): void {
    if (this.fileStream) {
      this.fileStream.end(callback);
    } else {
      callback();
    }
  }
}

/** Switch the logger to daily-rotated files in `dir`; `undefined` goes back to stdout. */
export function configureLogging(options: { dir?: string }): void {
  logDir = options.dir ? resolve(options.dir) : undefined;
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
  new LogStream(),
);

const logger = pinoCaller(rawLogger);

export { logger };
