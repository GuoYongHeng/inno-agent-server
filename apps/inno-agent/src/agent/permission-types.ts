/** Shared shapes for workspace write/edit approval cards. */

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

export type AuthorizerVerdict =
	| { kind: "allow" }
	| { kind: "deny"; reason?: string }
	| { kind: "defer" };

export type PermissionResponseStatus = "accepted" | "not_found" | "scope_mismatch" | "already_resolved";
