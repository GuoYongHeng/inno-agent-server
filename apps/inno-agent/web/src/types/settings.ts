export interface InnoModelInfo {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
	baseUrl?: string;
}

export interface InnoProviderModel {
	id: string;
	name: string;
	reasoning: boolean;
	input: Array<"text" | "image">;
	contextWindow: number;
	maxTokens: number;
}

export interface InnoProviderSettings {
	baseUrl: string;
	apiKey: string; // masked
	api?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
}

export interface UpsertProviderRequest {
	providerId: string;
	baseUrl: string;
	apiKey: string;
	api: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
	bypassProxy?: boolean;
	models: InnoProviderModel[];
	makeDefault?: boolean;
	preserveApiKey?: boolean;
}

export interface PersonalChannelConfig {
	enabled: boolean;
	personalOnly?: boolean;
	allowedUserIds?: string[];
}

export interface PersonalBridgeChannelConfig extends PersonalChannelConfig {
	mode: "bridge";
	sidecarBaseUrl: string;
}

export interface PersonalILinkChannelConfig extends PersonalChannelConfig {
	mode?: "ilink";
}

export interface ChannelsSettingsPayload {
	feishu?: {
		appId: string;
		appSecret?: string;
	};
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalChannelConfig;
		wechat?: PersonalChannelConfig;
	};
	bridge?: {
		token: string;
	};
}


export interface SandboxSettings {
	enabled?: boolean;
	apiKey?: string; // masked
	domain?: string;
	template?: string;
	timeoutMinutes?: number;
	commandTimeoutSeconds?: number;
	allowInternetAccess?: boolean;
	allowedDomains?: string[];
	requireApproval?: "always" | "never";
	limits?: { maxConcurrent?: number; maxSandboxes?: number; maxActiveMinutesPerDay?: number };
}

export interface InnoSettings {
	defaultProvider: string;
	defaultModel: string;
	configuredModels?: InnoModelInfo[];
	availableModels?: InnoModelInfo[];
	providers: Record<string, InnoProviderSettings>;
	server?: { port: number };
	feishu?: { appId: string; appSecret: string }; // appSecret masked
	channels?: {
		feishu?: PersonalChannelConfig;
		qq?: PersonalBridgeChannelConfig;
		wechat?: PersonalILinkChannelConfig | PersonalBridgeChannelConfig;
		wecom?: { enabled: boolean };
	};
	bridge?: { token: string }; // masked
	github?: { token: string }; // masked
	tavily?: {
		apiKey: string; // masked
	};
	/** Remote sandbox (platform-level). Absent for tenants. */
	sandbox?: SandboxSettings;
	/** False in authenticated mode: the operator manages the sandbox, tenants cannot. */
	sandboxEditable?: boolean;
	/** Server-managed surfaces: hide tenant edit affordances for these. */
	serverManaged?: { providers?: boolean; tavily?: boolean; channelCredentials?: boolean };
	/** True when the server has E2B_API_KEY in its environment. */
	sandboxEnvKey?: boolean;
	contentHub?: {
		type: "github" | "bundle";
		owner: string;
		repo: string;
		ref: string;
		skillsPath: string;
		presetsPath: string;
		baseUrl: string;
		token: string; // masked
	};
	memory?: { l2Enabled: boolean; l3Enabled: boolean };
	smartInput?: SmartInputSettings;
	ui?: { theme: string; mathSingleDollar: boolean };
}

/** One literal keyword → allowed file formats with optional exclusions. */
export interface SmartInputRule {
	id: string;
	/** Built-in rules keep stable ids and win keyword resolution over generic user rules. */
	isPreset: boolean;
	keyword: string;
	/** Allowed extensions when `allExtensions` is false. */
	extensions: string[];
	/** Accept every file format before applying `excludeExtensions`. */
	allExtensions: boolean;
	/** Extensions rejected after the allow-list/all-formats check. */
	excludeExtensions: string[];
	enabled: boolean;
}

export interface SmartInputSettings {
	enabled: boolean;
	allowDrag: boolean;
	allowRightClick: boolean;
	allowAgentCommands: boolean;
	rules: SmartInputRule[];
}
