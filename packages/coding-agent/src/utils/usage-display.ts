import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";

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

/** Settings/session surface the `/usage` view resolver reads. */
export interface UsageViewInputs {
	showZeroUsageMeters?: boolean;
	showUsageModels?: boolean;
	getUsageReportingModelSelectors: (reports: UsageReport[]) => string[];
}

/** Reports and model selectors `/usage` displays, after both display opt-outs. */
export interface UsageView {
	displayReports: UsageReport[];
	usageModelSelectors: string[];
}

/**
 * Apply both `/usage` display opt-outs in one place so the TUI dashboard and
 * the ACP text builder cannot drift: zeroed supplemental meters drop first, and
 * the per-provider model list is skipped entirely when opted out (cheaper than
 * filtering it away in the renderer).
 */
export function resolveUsageView(reports: UsageReport[], inputs: UsageViewInputs): UsageView {
	const displayReports = filterUsageReportsForDisplay(reports, {
		showZeroUsageMeters: inputs.showZeroUsageMeters,
	});
	return {
		displayReports,
		usageModelSelectors:
			inputs.showUsageModels === false ? [] : inputs.getUsageReportingModelSelectors(displayReports),
	};
}
