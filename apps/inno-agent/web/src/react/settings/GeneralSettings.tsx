import { useState } from "react";
import { useTranslation } from "react-i18next";
import { themeStore, THEME_IDS, THEME_PREVIEW_COLORS } from "../../stores/theme-store.js";
import { settingsStore } from "../../stores/settings-store.js";
import { setLocale } from "../../i18n/index.js";
import { useStoreSnapshot } from "../hooks.js";
import { SettingsSection, SettingsCard, SettingsRow } from "./primitives.js";
import { Switch } from "../ui/Switch.js";

function ThemePicker() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(themeStore, () => ({ current: themeStore.current }));
	return (
		<div className="flex flex-wrap gap-2">
			{THEME_IDS.map((id) => {
				const active = state.current === id;
				return (
					<button
						key={id}
						type="button"
						aria-label={t(`settings.themeOptions.${id}`)}
						aria-pressed={active}
						title={t(`settings.themeOptions.${id}`)}
						onClick={() => void themeStore.save(id)}
						className={`flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full border py-1.5 pl-2 pr-3.5 text-xs transition-colors ${
							active
								? "border-[var(--inno-accent)] bg-[var(--inno-accent-soft)] font-medium text-[var(--inno-accent)]"
								: "border-[var(--inno-border)] text-[var(--inno-text-muted)] hover:border-[var(--inno-border-strong)] hover:text-[var(--inno-text)]"
						}`}
					>
						<span
							className="h-4 w-4 rounded-full border border-[var(--inno-border-strong)]"
							style={{ backgroundColor: THEME_PREVIEW_COLORS[id] }}
						/>
						{t(`settings.themeOptions.${id}`)}
					</button>
				);
			})}
		</div>
	);
}

function LanguageSelect() {
	const { t, i18n } = useTranslation();
	return (
		<select
			className="rounded-md border border-[var(--inno-border)] bg-[var(--inno-surface)] px-2 py-1 text-xs"
			value={i18n.language}
			onChange={(e) => setLocale(e.target.value as "zh-CN" | "en")}
		>
			<option value="zh-CN">{t("settings.languageOptions.zh-CN")}</option>
			<option value="en">{t("settings.languageOptions.en")}</option>
		</select>
	);
}

function MarkdownMathToggle() {
	const { t } = useTranslation();
	const state = useStoreSnapshot(settingsStore, () => ({
		enabled: settingsStore.settings?.ui?.mathSingleDollar === true,
		isSaving: settingsStore.isSavingMarkdown,
		isReady: settingsStore.settings !== null,
	}));
	return (
		<Switch
			checked={state.enabled}
			disabled={!state.isReady || state.isSaving}
			aria-label={t("settings.markdownMath.title")}
			onChange={(enabled) => void settingsStore.saveMathSingleDollar(enabled).catch(() => undefined)}
		/>
	);
}

export function GeneralSettings() {
	const { t } = useTranslation();
	return (
		<>
			<SettingsSection title={t("settings.tabs.general")} description={t("settings.sections.general.desc", "外观与语言偏好")}>
			<SettingsCard>
				<SettingsRow
					label={t("settings.theme")}
					description={t("settings.sections.general.themeDesc", "选择界面配色主题")}
					control={<ThemePicker />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.language")}
					description={t("settings.sections.general.languageDesc", "切换界面显示语言")}
					control={<LanguageSelect />}
				/>
			</SettingsCard>
			<SettingsCard>
				<SettingsRow
					label={t("settings.markdownMath.title")}
					description={t("settings.markdownMath.description")}
					control={<MarkdownMathToggle />}
				/>
			</SettingsCard>
			</SettingsSection>
		</>
	);
}
