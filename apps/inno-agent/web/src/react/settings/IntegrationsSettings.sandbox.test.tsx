// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const saveSandbox = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../stores/settings-store.js", () => ({ settingsStore: { saveSandbox } }));

import type { InnoSettings } from "../../types/settings.js";
import { IntegrationsSettings } from "./IntegrationsSettings.js";

afterEach(() => { cleanup(); saveSandbox.mockClear(); });

const base = { defaultProvider: "p", defaultModel: "m", providers: {} } as unknown as InnoSettings;

function openCard() {
	fireEvent.click(screen.getAllByText("云端沙箱")[0]!);
}

describe("sandbox settings card", () => {
	it("is hidden when the operator manages the sandbox (authenticated mode)", () => {
		render(<IntegrationsSettings settings={{ ...base, sandboxEditable: false }} />);
		expect(screen.queryByText("云端沙箱")).toBeNull();
	});

	it("sends the edited settings, keeping the stored key when none is typed", async () => {
		render(<IntegrationsSettings settings={{ ...base, sandboxEditable: true, sandbox: { enabled: true, apiKey: "****abcd", requireApproval: "always", limits: { maxConcurrent: 3, maxSandboxes: 20, maxActiveMinutesPerDay: 480 } } }} />);
		openCard();
		fireEvent.change(screen.getByPlaceholderText(/pypi\.org/), { target: { value: "pypi.org\n\n *.github.com " } });
		fireEvent.change(screen.getByDisplayValue("480"), { target: { value: "120" } });
		fireEvent.change(screen.getByDisplayValue("每条命令都询问（推荐）"), { target: { value: "never" } });
		fireEvent.click(screen.getByText("common.save"));
		await waitFor(() => expect(saveSandbox).toHaveBeenCalledTimes(1));
		expect((saveSandbox.mock.calls[0] as unknown[])[0]).toMatchObject({
			enabled: true,
			apiKey: "****abcd",
			requireApproval: "never",
			allowInternetAccess: true,
			allowedDomains: ["pypi.org", "*.github.com"],
			limits: { maxConcurrent: 3, maxSandboxes: 20, maxActiveMinutesPerDay: 120 },
		});
	});

	it("will not save an enabled sandbox that has no key at all", () => {
		render(<IntegrationsSettings settings={{ ...base, sandboxEditable: true, sandbox: { enabled: true } }} />);
		openCard();
		expect((screen.getByText("common.save") as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText("e2b_…"), { target: { value: "e2b_new" } });
		expect((screen.getByText("common.save") as HTMLButtonElement).disabled).toBe(false);
	});

	it("shows a server rejection instead of failing silently", async () => {
		saveSandbox.mockRejectedValueOnce(new Error("limits.maxConcurrent must be a number >= 0"));
		render(<IntegrationsSettings settings={{ ...base, sandboxEditable: true, sandbox: { enabled: true, apiKey: "****abcd" } }} />);
		openCard();
		fireEvent.click(screen.getByText("common.save"));
		expect(await screen.findByRole("alert")).toHaveProperty("textContent", "limits.maxConcurrent must be a number >= 0");
	});
});
