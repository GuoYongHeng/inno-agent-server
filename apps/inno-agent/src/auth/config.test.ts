import { describe, expect, it } from "vitest";
import { readAuthRuntimeConfig, readListenConfig } from "./config.js";

const VALID_SECRET = "test-secret-with-at-least-32-characters";

function authEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		INNO_AUTH_MODE: "better-auth",
		DATABASE_URL: "postgresql://localhost:5432/inno_test",
		BETTER_AUTH_SECRET: VALID_SECRET,
		BETTER_AUTH_URL: "http://localhost:3000",
		...overrides,
	};
}

describe("auth runtime config", () => {
	it("requires the full better-auth environment", () => {
		expect(() => readAuthRuntimeConfig({})).toThrow("DATABASE_URL");
	});

	it("loads Better Auth and normalizes origins", () => {
		expect(readAuthRuntimeConfig(authEnv({
			BETTER_AUTH_URL: "https://agent.example.com/login",
			INNO_TRUSTED_ORIGINS: "https://app.example.com/path, http://localhost:5173",
		}))).toMatchObject({
			baseUrl: "https://agent.example.com",
			trustedOrigins: ["https://app.example.com", "http://localhost:5173"],
			allowSignUp: true,
		});
	});

	it.each(["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"])(
		"fails closed when %s is missing",
		(name) => {
			expect(() => readAuthRuntimeConfig(authEnv({ [name]: "" }))).toThrow(name);
		},
	);

	it("rejects a short Better Auth secret", () => {
		expect(() => readAuthRuntimeConfig(authEnv({ BETTER_AUTH_SECRET: "short" }))).toThrow("at least 32");
	});

	it("rejects the obsolete multi-user gate", () => {
		expect(() => readAuthRuntimeConfig(authEnv({ INNO_MULTI_USER_ENABLED: "true" }))).toThrow("INNO_MULTI_USER_ENABLED is obsolete");
	});

	it("rejects invalid mode and boolean values", () => {
		expect(() => readAuthRuntimeConfig({ INNO_AUTH_MODE: "disabled" })).toThrow("Invalid INNO_AUTH_MODE");
		expect(() => readAuthRuntimeConfig(authEnv({ INNO_AUTH_ALLOW_SIGNUP: "maybe" }))).toThrow("Invalid boolean");
	});
});

describe("listen config", () => {
	it("defaults to loopback", () => {
		expect(readListenConfig({}).host).toBe("127.0.0.1");
	});

	it("allows non-loopback listeners", () => {
		expect(readListenConfig({ INNO_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
	});
});
