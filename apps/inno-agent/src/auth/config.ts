export interface AuthRuntimeConfig {
	databaseUrl: string;
	secret: string;
	baseUrl: string;
	trustedOrigins: string[];
	allowSignUp: boolean;
}

export interface ListenConfig {
	host: string;
}

function readBoolean(value: string | undefined, fallback = false): boolean {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	throw new Error(`Invalid boolean value: ${value}`);
}

function readOrigins(value: string | undefined): string[] {
	if (!value) return [];
	return value.split(",").map((origin) => origin.trim()).filter(Boolean).map((origin) => {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			throw new Error(`Invalid trusted origin: ${origin}`);
		}
		return url.origin;
	});
}

/** Better-auth is the only runtime mode: every deployment needs a PostgreSQL
 * DATABASE_URL and a session secret. INNO_AUTH_MODE / INNO_MULTI_USER_ENABLED
 * / INNO_ALLOW_UNAUTHENTICATED_NETWORK are gone — a set-but-obsolete
 * INNO_AUTH_MODE is rejected rather than silently ignored. */
export function readAuthRuntimeConfig(env: NodeJS.ProcessEnv): AuthRuntimeConfig {
	const rawMode = env.INNO_AUTH_MODE?.trim();
	if (rawMode && rawMode !== "better-auth") {
		throw new Error(`Invalid INNO_AUTH_MODE: ${rawMode} (only better-auth is supported)`);
	}
	if (env.INNO_MULTI_USER_ENABLED !== undefined) {
		throw new Error("INNO_MULTI_USER_ENABLED is obsolete: multi-user is always on");
	}
	if (env.INNO_ALLOW_UNAUTHENTICATED_NETWORK !== undefined) {
		throw new Error("INNO_ALLOW_UNAUTHENTICATED_NETWORK is obsolete: requests are always authenticated");
	}

	const databaseUrl = env.DATABASE_URL?.trim();
	const secret = env.BETTER_AUTH_SECRET?.trim();
	const baseUrl = env.BETTER_AUTH_URL?.trim();
	const missing = [
		!databaseUrl && "DATABASE_URL",
		!secret && "BETTER_AUTH_SECRET",
		!baseUrl && "BETTER_AUTH_URL",
	].filter(Boolean);
	if (missing.length > 0) {
		throw new Error(`Server requires: ${missing.join(", ")}`);
	}
	if (secret!.length < 32) {
		throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
	}
	const parsedBaseUrl = new URL(baseUrl!);
	if (parsedBaseUrl.protocol !== "http:" && parsedBaseUrl.protocol !== "https:") {
		throw new Error("BETTER_AUTH_URL must use http or https");
	}

	return {
		databaseUrl: databaseUrl!,
		secret: secret!,
		baseUrl: parsedBaseUrl.origin,
		trustedOrigins: readOrigins(env.INNO_TRUSTED_ORIGINS),
		allowSignUp: readBoolean(env.INNO_AUTH_ALLOW_SIGNUP, true),
	};
}

export function readListenConfig(env: NodeJS.ProcessEnv): ListenConfig {
	return { host: env.INNO_HOST?.trim() || "127.0.0.1" };
}
