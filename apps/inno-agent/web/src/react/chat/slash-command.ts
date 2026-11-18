/**
 * A command offered by the slash palette next to the app actions. The agent no
 * longer publishes any, so the palette currently lists app actions only; the
 * type stays because the palette and the smart-input bubbles are shaped by it.
 */
export interface SlashCommandItem {
	/** Command name without the leading slash. Skills use the `skill:<name>` form. */
	name: string;
	description?: string;
	source: "extension" | "prompt" | "skill";
	webSafe?: boolean;
}
