import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";

/** Controls whether untouched supplemental model and tier meters remain visible in formatted usage reports. */
export interface UsageDisplayOptions {
	showZeroUsageMeters?: boolean;
}

interface MeterState {
	allZero: boolean;
	supplemental: boolean;
}

function meterKey(report: UsageReport, limit: UsageLimit): string | undefined {
	const modelId = limit.scope.modelId?.trim().toLowerCase();
	if (modelId) return `${report.provider}\0model:${modelId}`;
	const tier = limit.scope.tier?.trim().toLowerCase();
	if (tier) return `${report.provider}\0tier:${tier}`;
	return undefined;
}

/** Hide zeroed supplemental meters without changing provider reports used for routing. */
export function filterUsageReportsForDisplay(reports: UsageReport[], options: UsageDisplayOptions = {}): UsageReport[] {
	if (options.showZeroUsageMeters !== false) return reports;

	const meters = new Map<string, MeterState>();
	for (const report of reports) {
		const hasBaseLimit = report.limits.some(limit => meterKey(report, limit) === undefined);
		for (const limit of report.limits) {
			const key = meterKey(report, limit);
			if (!key) continue;
			const state = meters.get(key) ?? { allZero: true, supplemental: true };
			state.allZero &&= resolveUsedFraction(limit) === 0;
			state.supplemental &&= hasBaseLimit;
			meters.set(key, state);
		}
	}

	const hidden = new Set(
		[...meters.entries()].filter(([, state]) => state.allZero && state.supplemental).map(([key]) => key),
	);
	if (hidden.size === 0) return reports;

	return reports.map(report => {
		const limits = report.limits.filter(limit => {
			const key = meterKey(report, limit);
			return key === undefined || !hidden.has(key);
		});
		return limits.length === report.limits.length ? report : { ...report, limits };
	});
}

/** Minimal settings surface the `/usage` model list reads. */
export interface UsageModelListSettings {
	get(path: "display.showUsageModels"): boolean;
}

/**
 * Models `/usage` lists per provider, honoring the `display.showUsageModels`
 * opt-out (default on, so only an explicit `false` hides the list).
 *
 * Both `/usage` surfaces resolve the list here (the TUI dashboard and the ACP
 * text builder) so the opt-out cannot drift between them, and neither walks the
 * model registry when the list is hidden: filtering it away in the renderer
 * instead would be wasted work.
 */
export function resolveUsageModelSelectors(
	reports: readonly UsageReport[],
	settings: UsageModelListSettings,
	getSelectors: (reports: readonly UsageReport[]) => string[],
): string[] {
	return settings.get("display.showUsageModels") === false ? [] : getSelectors(reports);
}
