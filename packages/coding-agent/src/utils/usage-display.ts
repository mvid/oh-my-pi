import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";

function collapseSharedLimits(limits: UsageLimit[]): UsageLimit[] {
	const seenGroups = new Set<string>();
	let collapsed: UsageLimit[] | undefined;

	for (let index = 0; index < limits.length; index++) {
		const limit = limits[index]!;
		const group = limit.scope.sharedGroup;
		if (group !== undefined && seenGroups.has(group)) {
			collapsed ??= limits.slice(0, index);
			continue;
		}
		if (group !== undefined) seenGroups.add(group);
		collapsed?.push(limit);
	}

	return collapsed ?? limits;
}

/** Collapse routing-specific copies of a shared quota for user-facing usage views. */
export function collapseSharedUsageReports(reports: UsageReport[]): UsageReport[] {
	let collapsed: UsageReport[] | undefined;

	for (let index = 0; index < reports.length; index++) {
		const report = reports[index]!;
		const limits = collapseSharedLimits(report.limits);
		const displayReport = limits === report.limits ? report : { ...report, limits };
		if (displayReport !== report) {
			collapsed ??= reports.slice(0, index);
		}
		collapsed?.push(displayReport);
	}

	return collapsed ?? reports;
}

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

/** Reports and model selectors `/usage` displays, after display normalization and opt-outs. */
export interface UsageView {
	displayReports: UsageReport[];
	usageModelSelectors: string[];
}

/** Apply shared-quota collapsing and both `/usage` display opt-outs in one place. */
export function resolveUsageView(reports: UsageReport[], inputs: UsageViewInputs): UsageView {
	const collapsedReports = collapseSharedUsageReports(reports);
	const displayReports = filterUsageReportsForDisplay(collapsedReports, {
		showZeroUsageMeters: inputs.showZeroUsageMeters,
	});
	return {
		displayReports,
		usageModelSelectors:
			inputs.showUsageModels === false ? [] : inputs.getUsageReportingModelSelectors(displayReports),
	};
}
