/**
 * Coverage for the `display.showUsageModels` opt-out.
 *
 * The setting defaults to `true`, so `/usage` keeps listing every model mapped
 * to a provider's live usage data (the released 17.1.2 behaviour). Turning it
 * off must drop the "Models with usage data" heading and its indented selector
 * lines, and change nothing else in the report.
 *
 * The ACP text builder in `usage-report.ts` and the TUI `/usage` command in
 * `command-controller.ts` each gate the model list at their call site; the TUI
 * side hands the resolved list to the fullscreen dashboard overlay.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController, renderUsageReports } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

const SELECTORS = ["test-provider/gpt-5.6", "test-provider/claude-sonnet-4.6"];

function settingsDouble(showUsageModels: boolean) {
	return { get: (key: string) => (key === "display.showUsageModels" ? showUsageModels : undefined) };
}

function usageReport(): UsageReport {
	return {
		provider: "test-provider",
		fetchedAt: 1_700_000_000_000,
		limits: [
			{
				id: "daily",
				label: "Daily",
				scope: { provider: "test-provider", accountId: "acct-1" },
				window: { id: "daily", label: "daily" },
				amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				status: "ok",
			},
		],
		metadata: { email: "user@example.test" },
	};
}

async function buildTuiText(showUsageModels: boolean): Promise<string> {
	const showUsageDashboard = vi.fn();
	const ctx = {
		settings: settingsDouble(showUsageModels),
		session: { getUsageReportingModelSelectors: () => SELECTORS },
		ui: { terminal: { columns: 100 } },
		showUsageDashboard,
		showWarning: vi.fn(),
		showError: vi.fn(),
	} as unknown as InteractiveModeContext;
	await new CommandController(ctx).handleUsageCommand([usageReport()]);
	expect(showUsageDashboard).toHaveBeenCalledTimes(1);
	const [reports, selectors] = showUsageDashboard.mock.calls[0] as [UsageReport[], string[]];
	// The overlay renders its detail view through this same public renderer, so
	// the resolved selector list is observable as report text.
	return stripVTControlCharacters(renderUsageReports(reports, theme, Date.now(), 120, () => undefined, selectors));
}

async function buildAcpText(showUsageModels: boolean): Promise<string> {
	return await buildUsageReportText({
		settings: settingsDouble(showUsageModels),
		session: {
			model: undefined,
			fetchUsageReports: async () => [usageReport()],
			getUsageReportingModelSelectors: () => SELECTORS,
		},
	} as never);
}

describe("display.showUsageModels", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	for (const [label, build] of [
		["ACP text", buildAcpText],
		["TUI aggregate", buildTuiText],
	] as const) {
		it(`${label}: enabled lists every model mapped to live usage data`, async () => {
			const text = await build(true);
			expect(text).toContain("Models with usage data");
			for (const selector of SELECTORS) expect(text).toContain(selector);
		});

		it(`${label}: disabled drops the block and nothing else`, async () => {
			const enabled = await build(true);
			const disabled = await build(false);

			expect(disabled).not.toContain("Models with usage data");
			for (const selector of SELECTORS) expect(disabled).not.toContain(selector);

			// Everything the opt-out removed is exactly the heading plus one line per
			// selector; the surrounding report survives line-for-line.
			const removed = enabled
				.split("\n")
				.filter(line => line.includes("Models with usage data") || SELECTORS.some(s => line.includes(s)));
			expect(removed).toHaveLength(SELECTORS.length + 1);
			expect(
				enabled
					.split("\n")
					.filter(line => !removed.includes(line))
					.join("\n"),
			).toBe(disabled);
		});
	}
});
