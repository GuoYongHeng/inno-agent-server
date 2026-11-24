import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Box, ChevronDown, Database, KeyRound, Globe, Search } from "lucide-react";
import { settingsStore } from "../../stores/settings-store.js";
import type { InnoSettings } from "../../types/settings.js";
import { inputCls } from "../ui/input.js";
import { SettingsSection } from "./primitives.js";

/* ---------- Content Hub (source for skill library + presets) ---------- */

function ContentHubSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const hub = settings.contentHub;
	const [open, setOpen] = useState(false);
	const [type, setType] = useState<"github" | "bundle">(hub?.type ?? "github");
	const [owner, setOwner] = useState(hub?.owner ?? "");
	const [repo, setRepo] = useState(hub?.repo ?? "");
	const [ref, setRef] = useState(hub?.ref ?? "");
	const [skillsPath, setSkillsPath] = useState(hub?.skillsPath ?? "");
	const [presetsPath, setPresetsPath] = useState(hub?.presetsPath ?? "");
	const [baseUrl, setBaseUrl] = useState(hub?.baseUrl ?? "");
	const [token, setToken] = useState(hub?.token ?? "");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		setType(hub?.type ?? "github");
		setOwner(hub?.owner ?? "");
		setRepo(hub?.repo ?? "");
		setRef(hub?.ref ?? "");
		setSkillsPath(hub?.skillsPath ?? "");
		setPresetsPath(hub?.presetsPath ?? "");
		setBaseUrl(hub?.baseUrl ?? "");
		setToken(hub?.token ?? "");
		setSaved(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [hub?.type, hub?.owner, hub?.repo, hub?.ref, hub?.skillsPath, hub?.presetsPath, hub?.baseUrl, hub?.token]);

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveContentHub({
				type,
				owner: owner.trim(),
				repo: repo.trim(),
				ref: ref.trim(),
				skillsPath: skillsPath.trim(),
				presetsPath: presetsPath.trim(),
				baseUrl: baseUrl.trim(),
				token: token.trim(),
			});
			setSaved(true);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	const sourceLabel = type === "github"
		? `GitHub · ${owner || "?"}/${repo || "?"}`
		: `${t("settings.contentHub.bundle", "自托管服务")} · ${baseUrl || "?"}`;

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Database size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.contentHub.title", "内容源(技能库 + 预设)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.contentHub.desc", "技能库和预设工作区从这里拉取。默认公共仓库,可改为私有 GitHub 仓库或自托管服务。")}
					</p>
					{!open && <p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">{sourceLabel}</p>}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					{/* Type selector */}
					<div className="flex flex-wrap items-center gap-1.5">
						<button
							onClick={() => setType("github")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "github" ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
						>
							GitHub
						</button>
						<button
							onClick={() => setType("bundle")}
							className={`flex h-7 items-center rounded-md border px-2.5 text-xs ${type === "bundle" ? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] text-[var(--inno-accent)]" : "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)]"}`}
						>
							{t("settings.contentHub.bundle", "自托管服务")}
						</button>
					</div>

					{type === "github" ? (
						<>
							<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
								<input className={inputCls} value={owner} onChange={(e) => { setOwner(e.target.value); setSaved(false); }} placeholder="owner" autoComplete="off" />
								<input className={inputCls} value={repo} onChange={(e) => { setRepo(e.target.value); setSaved(false); }} placeholder="repo" autoComplete="off" />
								<input className={inputCls} value={ref} onChange={(e) => { setRef(e.target.value); setSaved(false); }} placeholder="ref (main)" autoComplete="off" />
							</div>
							<div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
								<input className={inputCls} value={skillsPath} onChange={(e) => { setSkillsPath(e.target.value); setSaved(false); }} placeholder="skill-library" autoComplete="off" />
								<input className={inputCls} value={presetsPath} onChange={(e) => { setPresetsPath(e.target.value); setSaved(false); }} placeholder="workspace-templates" autoComplete="off" />
							</div>
						</>
					) : (
						<input className={inputCls} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setSaved(false); }} placeholder="https://hub.example.com" autoComplete="off" />
					)}

					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<input
							className={`${inputCls} flex-1 basis-44`}
							type="password"
							value={token}
							onChange={(e) => { setToken(e.target.value); setSaved(false); }}
							placeholder={t("settings.contentHub.tokenPlaceholder", "访问令牌(私有仓库 / 提额,可选)") ?? ""}
							autoComplete="off"
						/>
						<button
							disabled={saving}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.github.saved", "已保存") : t("common.save")}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

function TavilySettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const managed = settings.serverManaged?.tavily ?? false;
	const tavily = settings.tavily;
	const [open, setOpen] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);

	const maskedKey = tavily?.apiKey ?? "";
	const hasExistingKey = Boolean(maskedKey);
	const [keyDirty, setKeyDirty] = useState(false);

	useEffect(() => {
		setApiKey("");
		setKeyDirty(false);
		setSaved(false);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [maskedKey]);

	const dirty = keyDirty;

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveTavily(keyDirty ? apiKey.trim() : maskedKey);
			setSaved(true);
			setApiKey("");
			setKeyDirty(false);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	async function handleClear() {
		setSaving(true);
		setSaved(false);
		try {
			await settingsStore.saveTavily("");
			setSaved(true);
			setApiKey("");
			setKeyDirty(false);
		} catch {
			// error surfaced via store
		} finally {
			setSaving(false);
		}
	}

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Globe size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.tavily.title", "联网搜索 (Tavily)")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.tavily.desc", "为 agent 提供联网检索能力。需在 tavily.com 获取 API Key。")}
					</p>
					{!open && (
						<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{hasExistingKey ? `apiKey: ${maskedKey}` : t("settings.tavily.placeholder", "tvly-…")}
						</p>
					)}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-2.5">
					{managed ? (
						<p className="text-xs text-[var(--inno-text-muted)]">
							{hasExistingKey
								? t("settings.tavily.managed", "由服务端统一管理")
								: t("settings.tavily.notConfigured", "未配置")}
						</p>
					) : (
					<>
					<input
						className={inputCls}
						type="password"
						value={apiKey}
						onChange={(e) => { setApiKey(e.target.value); setKeyDirty(true); setSaved(false); }}
						placeholder={hasExistingKey ? maskedKey : (t("settings.tavily.placeholder", "tvly-…") ?? "")}
						autoComplete="off"
					/>
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<button
							disabled={saving || !dirty}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.tavily.saved", "已保存") : t("common.save")}
						</button>
						{hasExistingKey && (
							<button
								disabled={saving}
								onClick={() => void handleClear()}
								className="flex h-8 shrink-0 items-center rounded-md border border-[var(--inno-border)] px-3 text-xs text-[var(--inno-text-muted)] hover:bg-[var(--inno-surface-muted)] hover:text-[var(--inno-text)]"
							>
								{t("settings.tavily.clear", "清除")}
							</button>
						)}
					</div>
					</>
					)}
				</div>
			) : null}
		</div>
	);
}

/* ---------- Cloud sandbox (platform-level; local mode only) ---------- */

function SandboxSettingsCard({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	const sandbox = settings.sandbox;
	const maskedKey = sandbox?.apiKey ?? "";
	const hasKey = Boolean(maskedKey) || Boolean(settings.sandboxEnvKey);
	const [open, setOpen] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [enabled, setEnabled] = useState(sandbox?.enabled ?? false);
	const [apiKey, setApiKey] = useState("");
	const [approval, setApproval] = useState<"always" | "never">(sandbox?.requireApproval ?? "always");
	const [internet, setInternet] = useState(sandbox?.allowInternetAccess !== false);
	const [domains, setDomains] = useState((sandbox?.allowedDomains ?? []).join("\n"));
	const [maxConcurrent, setMaxConcurrent] = useState(String(sandbox?.limits?.maxConcurrent ?? 3));
	const [maxSandboxes, setMaxSandboxes] = useState(String(sandbox?.limits?.maxSandboxes ?? 20));
	const [maxMinutes, setMaxMinutes] = useState(String(sandbox?.limits?.maxActiveMinutesPerDay ?? 480));
	const [timeoutMinutes, setTimeoutMinutes] = useState(String(sandbox?.timeoutMinutes ?? 30));
	const [commandTimeout, setCommandTimeout] = useState(String(sandbox?.commandTimeoutSeconds ?? 600));
	const [domain, setDomain] = useState(sandbox?.domain ?? "");
	const [template, setTemplate] = useState(sandbox?.template ?? "");

	function touched<T>(setter: (value: T) => void) {
		return (value: T) => { setter(value); setSaved(false); setError(null); };
	}

	async function handleSave() {
		setSaving(true);
		setSaved(false);
		setError(null);
		const num = (value: string) => Number(value.trim() === "" ? Number.NaN : value);
		try {
			await settingsStore.saveSandbox({
				enabled,
				// Omitted when untouched so the stored (or environment) key is kept.
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : { apiKey: maskedKey || "****" }),
				requireApproval: approval,
				allowInternetAccess: internet,
				allowedDomains: domains.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
				limits: { maxConcurrent: num(maxConcurrent), maxSandboxes: num(maxSandboxes), maxActiveMinutesPerDay: num(maxMinutes) },
				timeoutMinutes: num(timeoutMinutes),
				commandTimeoutSeconds: num(commandTimeout),
				domain,
				template,
			});
			setSaved(true);
			setApiKey("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const labelCls = "grid gap-1 text-xs text-[var(--inno-text-muted)]";
	const checkCls = "flex items-center gap-2 text-xs text-[var(--inno-text)]";
	const summary = enabled
		? t("settings.sandbox.enabled", "启用沙箱")
		: t("settings.sandbox.title", "云端沙箱");

	return (
		<div className="min-w-0 rounded-lg bg-[var(--inno-surface)] p-4">
			<button className="inno-settings-card-toggle flex w-full min-w-0 items-start gap-2 text-left" onClick={() => setOpen((v) => !v)}>
				<Box size={16} className="mt-0.5 shrink-0 text-[var(--inno-text)]" />
				<div className="min-w-0 flex-1">
					<h4 className="break-words text-sm font-medium text-[var(--inno-text)]">{t("settings.sandbox.title", "云端沙箱")}</h4>
					<p className="mt-1 max-w-full break-words text-xs leading-relaxed text-[var(--inno-text-muted)]">
						{t("settings.sandbox.desc", "让 agent 在隔离的 E2B 云沙箱里运行命令和读写文件。")}
					</p>
					{!open && (
						<p className="mt-1 break-all text-xs leading-relaxed text-[var(--inno-text-subtle)]">
							{sandbox?.enabled ? `${summary} · ${maskedKey || "E2B_API_KEY"}` : t("common.off", "未启用")}
						</p>
					)}
				</div>
				<ChevronDown size={14} className={`mt-1 shrink-0 text-[var(--inno-text-subtle)] transition-transform ${open ? "rotate-180" : ""}`} />
			</button>

			{open ? (
				<div className="mt-3 grid gap-3">
					<label className={checkCls}>
						<input type="checkbox" checked={enabled} onChange={(e) => touched(setEnabled)(e.target.checked)} />
						{t("settings.sandbox.enabled", "启用沙箱")}
					</label>
					<label className={labelCls}>
						{t("settings.sandbox.apiKey", "E2B API Key")}
						<input
							className={inputCls}
							type="password"
							value={apiKey}
							onChange={(e) => touched(setApiKey)(e.target.value)}
							placeholder={maskedKey || "e2b_…"}
							autoComplete="off"
						/>
						{!maskedKey && settings.sandboxEnvKey ? <span>{t("settings.sandbox.apiKeyEnv", "已从服务器环境变量 E2B_API_KEY 读取")}</span> : null}
					</label>
					<label className={labelCls}>
						{t("settings.sandbox.approval", "执行命令前询问")}
						<select className={inputCls} value={approval} onChange={(e) => touched(setApproval)(e.target.value as "always" | "never")}>
							<option value="always">{t("settings.sandbox.approvalAlways", "每条命令都询问（推荐）")}</option>
							<option value="never">{t("settings.sandbox.approvalNever", "不询问")}</option>
						</select>
						<span>{t("settings.sandbox.approvalHint", "")}</span>
					</label>
					<label className={checkCls}>
						<input type="checkbox" checked={internet} onChange={(e) => touched(setInternet)(e.target.checked)} />
						{t("settings.sandbox.internet", "允许沙箱访问互联网")}
					</label>
					{internet ? (
						<label className={labelCls}>
							{t("settings.sandbox.allowedDomains", "只允许访问这些地址")}
							<textarea className={`${inputCls} min-h-[72px] py-2`} value={domains} onChange={(e) => touched(setDomains)(e.target.value)} placeholder="pypi.org&#10;*.github.com" />
							<span>{t("settings.sandbox.allowedDomainsHint", "")}</span>
						</label>
					) : null}
					<div className="grid gap-2">
						<span className="text-xs font-medium text-[var(--inno-text)]">{t("settings.sandbox.limits", "用量上限（0 表示不限）")}</span>
						<div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
							<label className={labelCls}>{t("settings.sandbox.maxConcurrent", "同时运行的沙箱数")}
								<input className={inputCls} inputMode="numeric" value={maxConcurrent} onChange={(e) => touched(setMaxConcurrent)(e.target.value)} />
							</label>
							<label className={labelCls}>{t("settings.sandbox.maxSandboxes", "沙箱总数")}
								<input className={inputCls} inputMode="numeric" value={maxSandboxes} onChange={(e) => touched(setMaxSandboxes)(e.target.value)} />
							</label>
							<label className={labelCls}>{t("settings.sandbox.maxActiveMinutesPerDay", "每日运行分钟数（UTC）")}
								<input className={inputCls} inputMode="numeric" value={maxMinutes} onChange={(e) => touched(setMaxMinutes)(e.target.value)} />
							</label>
						</div>
					</div>
					<div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
						<label className={labelCls}>{t("settings.sandbox.timeoutMinutes", "沙箱空闲存活（分钟）")}
							<input className={inputCls} inputMode="numeric" value={timeoutMinutes} onChange={(e) => touched(setTimeoutMinutes)(e.target.value)} />
						</label>
						<label className={labelCls}>{t("settings.sandbox.commandTimeoutSeconds", "单条命令超时（秒）")}
							<input className={inputCls} inputMode="numeric" value={commandTimeout} onChange={(e) => touched(setCommandTimeout)(e.target.value)} />
						</label>
					</div>
					<details>
						<summary className="cursor-pointer text-xs text-[var(--inno-text-muted)]">{t("settings.sandbox.advanced", "高级")}</summary>
						<div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
							<label className={labelCls}>{t("settings.sandbox.domain", "自部署 E2B 域名")}
								<input className={inputCls} value={domain} onChange={(e) => touched(setDomain)(e.target.value)} />
							</label>
							<label className={labelCls}>{t("settings.sandbox.template", "沙箱模板")}
								<input className={inputCls} value={template} onChange={(e) => touched(setTemplate)(e.target.value)} />
							</label>
						</div>
					</details>
					<p className="text-xs leading-relaxed text-[var(--inno-text-subtle)]">{t("settings.sandbox.restartNote", "")}</p>
					{error ? <p role="alert" className="text-xs text-red-500">{error}</p> : null}
					<div className="flex items-center gap-2">
						<button
							disabled={saving || (enabled && !hasKey && !apiKey.trim())}
							onClick={() => void handleSave()}
							className="flex h-8 shrink-0 items-center rounded-md inno-primary-button px-3 text-xs text-white disabled:opacity-50"
						>
							{saving ? t("common.loading") : saved ? t("settings.sandbox.saved", "已保存") : t("common.save")}
						</button>
					</div>
				</div>
			) : null}
		</div>
	);
}

/* ---------- Integrations category page ---------- */

export function IntegrationsSettings({ settings }: { settings: InnoSettings }) {
	const { t } = useTranslation();
	return (
		<SettingsSection title={t("settings.tabs.integrations")} description={t("settings.sections.integrations.desc", "内容源与联网搜索等外部服务")}>
			<ContentHubSettings settings={settings} />
			<TavilySettings settings={settings} />
			{settings.sandboxEditable !== false ? <SandboxSettingsCard settings={settings} /> : null}
		</SettingsSection>
	);
}
