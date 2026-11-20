import { describe, expect, it } from "vitest";
import { assertMigrationList } from "./migrations.js";
import { TENANT_MIGRATIONS, TENANT_SCHEMA_SQL } from "../tenants/schema.js";

describe("migration list", () => {
	it("accepts increasing versions and rejects duplicates, gaps backwards and non-integers", () => {
		expect(() => assertMigrationList([{ version: 1, name: "a", sql: "" }, { version: 2, name: "b", sql: "" }])).not.toThrow();
		expect(() => assertMigrationList([{ version: 1, name: "a", sql: "" }, { version: 1, name: "b", sql: "" }])).toThrow(/strictly increasing/);
		expect(() => assertMigrationList([{ version: 2, name: "a", sql: "" }, { version: 1, name: "b", sql: "" }])).toThrow(/strictly increasing/);
		expect(() => assertMigrationList([{ version: 0, name: "a", sql: "" }])).toThrow(/strictly increasing/);
		expect(() => assertMigrationList([{ version: 1.5, name: "a", sql: "" }])).toThrow(/strictly increasing/);
	});

	it("keeps the shipped tenant migrations well-formed and printable", () => {
		expect(() => assertMigrationList(TENANT_MIGRATIONS)).not.toThrow();
		for (const migration of TENANT_MIGRATIONS) expect(TENANT_SCHEMA_SQL).toContain(`-- ${migration.version} ${migration.name}`);
	});
});
