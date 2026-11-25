import type { InnoConfig } from "../config.js";

/** Live view of the current config. Tools read from it at call time so settings
 * changes take effect without a restart. */
export interface ConfigHolder {
	current: InnoConfig;
}
