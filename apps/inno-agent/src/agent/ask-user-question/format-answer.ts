// Vendored from @juicesharp/rpiv-ask-user-question 2.12.0 (MIT, see ./LICENSE).
// Only the schema, validation and response-envelope code is kept: the package's
// terminal UI is not used, and keeping the files here lets the durable runtime
// load them without the package or the coding-agent SDK it pulls in as a peer.

import type { QuestionAnswer } from "./types.js";

/**
 * Placeholder for empty / null answer text. Used uniformly across both variants — the
 * earlier `(no answer)` fallback in the dialog summary was accidental drift; tests pin
 * `(no input)` only.
 */
export const NO_INPUT_PLACEHOLDER = "(no input)";

export type FormatAnswerVariant = "summary" | "envelope";

/**
 * Format a `QuestionAnswer` to its scalar string form. `variant` is currently unused
 * across all branches (the chat branch that once distinguished `envelope` from
 * `summary` has been removed); it is retained on the signature for stability.
 * The `kind: "custom"` empty-string handling and the option fallback both unify on
 * `NO_INPUT_PLACEHOLDER`. Switch is exhaustive — non-`void` return enforces every
 * variant is handled.
 */
export function formatAnswerScalar(a: QuestionAnswer, _variant: FormatAnswerVariant): string {
	switch (a.kind) {
		case "multi":
			return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
		case "custom":
			return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
		case "option":
			return a.answer ?? NO_INPUT_PLACEHOLDER;
	}
}
