export interface PresetMeta {
	id: string;
	name: string;
	description: string;
	icon?: string;
	category?: string;
	/** Platform catalog skill ids bound to this preset (optional in API responses). */
	skills?: string[];
}
