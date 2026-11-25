import type { Pool, PoolClient } from "pg";

export interface SkillCatalogRecord {
	skillId: string;
	name: string;
	description: string;
	version: string;
	objectPrefix: string;
	disableModelInvocation: boolean;
	publishedAt: string;
	publishedBy: string | null;
	source: string | null;
}

export interface TenantSkillListing extends SkillCatalogRecord {
	enabled: boolean;
	installedAt: string | null;
}

interface CatalogRow {
	skill_id: string;
	name: string;
	description: string;
	version: string;
	object_prefix: string;
	disable_model_invocation: boolean;
	published_at: Date | string;
	published_by: string | null;
	source: string | null;
}

interface TenantSkillRow extends CatalogRow {
	enabled: boolean | null;
	installed_at: Date | string | null;
}

function asIso(value: Date | string | null | undefined): string | null {
	if (value == null) return null;
	return value instanceof Date ? value.toISOString() : String(value);
}

function mapCatalog(row: CatalogRow): SkillCatalogRecord {
	return {
		skillId: row.skill_id,
		name: row.name,
		description: row.description,
		version: row.version,
		objectPrefix: row.object_prefix,
		disableModelInvocation: Boolean(row.disable_model_invocation),
		publishedAt: asIso(row.published_at) ?? new Date(0).toISOString(),
		publishedBy: row.published_by,
		source: row.source,
	};
}

export class SkillCatalogStore {
	constructor(private readonly pool: Pool) {}

	async upsertCatalog(record: {
		skillId: string;
		name: string;
		description: string;
		version: string;
		objectPrefix: string;
		disableModelInvocation?: boolean;
		publishedBy?: string | null;
		source?: string | null;
	}): Promise<SkillCatalogRecord> {
		const result = await this.pool.query<CatalogRow>(
			`INSERT INTO skill_catalog (
				skill_id, name, description, version, object_prefix,
				disable_model_invocation, published_by, source, published_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
			ON CONFLICT (skill_id) DO UPDATE SET
				name = EXCLUDED.name,
				description = EXCLUDED.description,
				version = EXCLUDED.version,
				object_prefix = EXCLUDED.object_prefix,
				disable_model_invocation = EXCLUDED.disable_model_invocation,
				published_by = EXCLUDED.published_by,
				source = EXCLUDED.source,
				published_at = CURRENT_TIMESTAMP
			RETURNING *`,
			[
				record.skillId,
				record.name,
				record.description,
				record.version,
				record.objectPrefix,
				Boolean(record.disableModelInvocation),
				record.publishedBy ?? null,
				record.source ?? null,
			],
		);
		return mapCatalog(result.rows[0]!);
	}

	async get(skillId: string): Promise<SkillCatalogRecord | null> {
		const result = await this.pool.query<CatalogRow>(
			"SELECT * FROM skill_catalog WHERE skill_id = $1",
			[skillId],
		);
		return result.rows[0] ? mapCatalog(result.rows[0]) : null;
	}

	async listCatalog(): Promise<SkillCatalogRecord[]> {
		const result = await this.pool.query<CatalogRow>(
			"SELECT * FROM skill_catalog ORDER BY name ASC",
		);
		return result.rows.map(mapCatalog);
	}

	async listForTenant(tenantId: string): Promise<TenantSkillListing[]> {
		const result = await this.pool.query<TenantSkillRow>(
			`SELECT c.*, t.enabled, t.installed_at
			 FROM skill_catalog c
			 LEFT JOIN tenant_skills t
			   ON t.skill_id = c.skill_id AND t.tenant_id = $1
			 ORDER BY c.name ASC`,
			[tenantId],
		);
		return result.rows.map((row) => ({
			...mapCatalog(row),
			enabled: Boolean(row.enabled),
			installedAt: asIso(row.installed_at),
		}));
	}

	async listEnabledForTenant(tenantId: string): Promise<SkillCatalogRecord[]> {
		const result = await this.pool.query<CatalogRow>(
			`SELECT c.*
			 FROM tenant_skills t
			 JOIN skill_catalog c ON c.skill_id = t.skill_id
			 WHERE t.tenant_id = $1 AND t.enabled
			 ORDER BY c.name ASC`,
			[tenantId],
		);
		return result.rows.map(mapCatalog);
	}

	async setEnabled(tenantId: string, skillId: string, enabled: boolean): Promise<TenantSkillListing | null> {
		const exists = await this.get(skillId);
		if (!exists) return null;
		await this.pool.query(
			`INSERT INTO tenant_skills (tenant_id, skill_id, enabled, installed_at)
			 VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
			 ON CONFLICT (tenant_id, skill_id) DO UPDATE SET
				enabled = EXCLUDED.enabled,
				installed_at = CASE
					WHEN tenant_skills.enabled IS DISTINCT FROM EXCLUDED.enabled AND EXCLUDED.enabled
					THEN CURRENT_TIMESTAMP
					ELSE tenant_skills.installed_at
				END`,
			[tenantId, skillId, enabled],
		);
		const listing = await this.listForTenant(tenantId);
		return listing.find((entry) => entry.skillId === skillId) ?? null;
	}

	/**
	 * Enable every catalog skill the tenant does not already have a row for.
	 * Existing enable/disable choices are left untouched (ON CONFLICT DO NOTHING).
	 */
	async enableAllForTenant(tenantId: string, client?: PoolClient): Promise<number> {
		const db = client ?? this.pool;
		const result = await db.query(
			`INSERT INTO tenant_skills (tenant_id, skill_id, enabled, installed_at)
			 SELECT $1, skill_id, true, CURRENT_TIMESTAMP FROM skill_catalog
			 ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
			[tenantId],
		);
		return result.rowCount ?? 0;
	}

	/** Opt every tenant into catalog skills they have never seen (post-seed). */
	async enableAllForAllTenants(): Promise<number> {
		const result = await this.pool.query(
			`INSERT INTO tenant_skills (tenant_id, skill_id, enabled, installed_at)
			 SELECT tenants.id, skill_catalog.skill_id, true, CURRENT_TIMESTAMP
			 FROM tenants CROSS JOIN skill_catalog
			 ON CONFLICT (tenant_id, skill_id) DO NOTHING`,
		);
		return result.rowCount ?? 0;
	}
}
