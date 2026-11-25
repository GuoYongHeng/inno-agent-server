// Child process used by file-lock.test.ts: appends N entries under the lock.
import { readJson, writeJson } from "./file-store.js";
import { withFileLock } from "./file-lock.js";

const [file, tag, count, useLock] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
	const step = () => writeJson(file!, [...readJson<string[]>(file!, []), `${tag}-${i}`]);
	if (useLock === "lock") withFileLock(`${file}.lock`, step); else step();
}
