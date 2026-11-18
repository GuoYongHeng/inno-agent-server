/** Shared shapes for `ask_user_question` cards. */

export interface QuestionBridgeAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "chat" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	preview?: string;
}

export interface QuestionBridgeResult {
	answers: QuestionBridgeAnswer[];
	cancelled: boolean;
	error?: string;
}

/** A persistable pending question, so the card can be restored after a restart. */
export interface PersistedQuestion {
	questionId: string;
	sessionId: string;
	turnId: string;
	params: unknown;
	createdAt: string;
}

export type QuestionResponseStatus = "accepted" | "not_found" | "scope_mismatch" | "already_resolved";
