import { apiFetch } from "./client.js";
import type { InnoSettings, SandboxSettings, SmartInputSettings, UpsertProviderRequest, ChannelsSettingsPayload } from "../types/settings.js";

export async function getSettings(): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings");
}

export async function switchBackendModel(provider: string, model: string): Promise<Pick<InnoSettings, "defaultProvider" | "defaultModel">> {
	return apiFetch<Pick<InnoSettings, "defaultProvider" | "defaultModel">>("/api/settings/model", {
		method: "POST",
		body: JSON.stringify({ provider, model }),
	});
}

export async function upsertProvider(payload: UpsertProviderRequest): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/providers", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export async function deleteProviderApi(providerId: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>(`/api/settings/providers/${encodeURIComponent(providerId)}`, {
		method: "DELETE",
	});
}

export async function deleteModelApi(providerId: string, modelId: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>(
		`/api/settings/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`,
		{ method: "DELETE" },
	);
}

export interface ProbeModelsRequest {
	baseUrl: string;
	apiKey?: string;
	providerId?: string;
	api?: string;
}

export async function probeProviderModels(payload: ProbeModelsRequest): Promise<{ models: string[] }> {
	return apiFetch<{ models: string[] }>("/api/settings/providers/probe-models", {
		method: "POST",
		body: JSON.stringify(payload),
	});
}

export async function saveChannelsSettings(payload: ChannelsSettingsPayload): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/channels", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export interface MemorySettingsPatch {
	l2Enabled?: boolean;
	l3Enabled?: boolean;
}

export async function saveMemorySettings(patch: MemorySettingsPatch): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/memory", {
		method: "PUT",
		body: JSON.stringify(patch),
	});
}

export async function saveSmartInputSettings(payload: SmartInputSettings): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/smart-input", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export async function saveGithubSettings(token: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/github", {
		method: "PUT",
		body: JSON.stringify({ token }),
	});
}



export async function saveTavilySettings(apiKey: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/tavily", {
		method: "PUT",
		body: JSON.stringify({ apiKey }),
	});
}

export type SandboxSettingsPayload = Omit<SandboxSettings, "apiKey"> & { apiKey?: string };

export async function saveSandboxSettings(payload: SandboxSettingsPayload): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/sandbox", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export interface ContentHubPayload {
	type: "github" | "bundle";
	owner?: string;
	repo?: string;
	ref?: string;
	skillsPath?: string;
	baseUrl?: string;
	token?: string;
}

export async function saveContentHubSettings(payload: ContentHubPayload): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/content-hub", {
		method: "PUT",
		body: JSON.stringify(payload),
	});
}

export async function saveThemeSettings(theme: string): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/theme", {
		method: "PUT",
		body: JSON.stringify({ theme }),
	});
}

export async function saveMarkdownSettings(mathSingleDollar: boolean): Promise<InnoSettings> {
	return apiFetch<InnoSettings>("/api/settings/markdown", {
		method: "PUT",
		body: JSON.stringify({ mathSingleDollar }),
	});
}

export async function feishuQrRegister(): Promise<{ deviceCode: string; qrUrl: string; expiresIn: number; interval: number }> {
	return apiFetch<{ deviceCode: string; qrUrl: string; expiresIn: number; interval: number }>("/api/channels/feishu/qr-register", {
		method: "POST",
	});
}

export async function feishuQrStatus(deviceCode: string): Promise<{ status: string }> {
	return apiFetch<{ status: string }>(`/api/channels/feishu/qr-status?deviceCode=${encodeURIComponent(deviceCode)}`);
}

export async function wechatQrLogin(): Promise<{ qrId: string; qrUrl: string }> {
	return apiFetch<{ qrId: string; qrUrl: string }>("/api/channels/wechat/qr-login", {
		method: "POST",
	});
}

export async function wechatQrStatus(qrId: string): Promise<{ status: string; botId?: string }> {
	return apiFetch<{ status: string; botId?: string }>(`/api/channels/wechat/qr-status?qrId=${encodeURIComponent(qrId)}`);
}

export async function wechatStatus(): Promise<{ configured: boolean; connected: boolean; botId?: string; loggedIn?: boolean }> {
	return apiFetch<{ configured: boolean; connected: boolean; botId?: string; loggedIn?: boolean }>("/api/channels/wechat/status");
}
