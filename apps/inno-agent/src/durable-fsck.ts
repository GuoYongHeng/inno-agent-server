#!/usr/bin/env node
/**
 * Offline consistency check for durable session data.
 *   node dist/durable-fsck.js --data-dir <dir> [--repair]
 * Lists orphaned session directories (data whose catalog record is gone) and
 * per-root disk usage as JSON. `--repair` removes the orphans. Safe to run
 * while the server is up: create writes the catalog before any data and delete
 * removes the catalog record first, so a live session is never an orphan.
 */
import { auditDurableData } from "./agent/durable-audit.js";
import { resolveRuntimePaths } from "./runtime.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = value("--data-dir") ?? resolveRuntimePaths().dataDir;
const results = auditDurableData(dataDir, { repair: flag("--repair") });
console.log(JSON.stringify({ dataDir, repaired: flag("--repair"), roots: results }, null, 2));
process.exit(results.some((r) => r.error || (r.orphans.length && !r.removed)) ? 1 : 0);
