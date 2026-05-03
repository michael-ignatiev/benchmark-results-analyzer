import { generateComparisonReportSummary } from "../../comparisons/report-summary.service.js";
import type {
  ComparisonFinding,
  ComparisonStatus,
  ComparisonSummary,
  Severity,
  ThresholdRule,
} from "../../comparisons/types.js";
import type {
  PersistedComparisonFindingReadModel,
  PersistedComparisonReadModel,
} from "../../persistence/comparison-repository.js";

const STATUS_ORDER: ComparisonStatus[] = ["regressed", "improved", "unchanged", "missing"];
const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "none"];

export interface ReportResponse {
  data: {
    comparison: ReportComparisonMetadata;
    summary: ComparisonSummary;
    summaryText: string;
    groupedFindings: ReportGroupedFindings;
    chartSections: ReportChartSection[];
  };
}

export interface ReportComparisonMetadata {
  id: string;
  suiteId: string;
  baselineRunId: string;
  candidateRunId: string;
  createdAt: string;
  label?: string;
  thresholdRules?: ThresholdRule[];
}

export interface ReportGroupedFindings {
  byStatus: Array<ReportFindingGroup<ComparisonStatus>>;
  bySeverity: Array<ReportFindingGroup<Severity>>;
  byMetricGroup: Array<ReportFindingGroup<string>>;
}

export interface ReportFindingGroup<TGroupKey extends string> {
  key: TGroupKey;
  count: number;
  findings: PersistedComparisonFindingReadModel[];
}

export type ReportChartSection =
  | CountChartSection
  | MetricDeltaChartSection
  | MissingMetricsChartSection;

export interface CountChartSection {
  id: "finding-status-counts" | "finding-severity-counts";
  title: string;
  visualization: "bar";
  xKey: string;
  yKey: string;
  data: CountChartDatum[];
}

export interface CountChartDatum {
  key: string;
  label: string;
  count: number;
}

export interface MetricDeltaChartSection {
  id: "metric-percent-deltas";
  title: string;
  visualization: "bar";
  xKey: "metricKey";
  yKey: "deltaPercent";
  unit: "percent";
  data: MetricDeltaDatum[];
}

export interface MetricDeltaDatum {
  metricKey: string;
  metricName: string;
  metricGroup: string;
  aggregationType: string;
  unit: string;
  baselineValue: number;
  candidateValue: number;
  deltaPercent: number;
  deltaAbsolute: number;
  status: ComparisonStatus;
  severity: Severity;
}

export interface MissingMetricsChartSection {
  id: "missing-metrics";
  title: string;
  visualization: "table";
  data: MissingMetricDatum[];
}

export interface MissingMetricDatum {
  metricKey: string;
  metricName: string;
  metricGroup: string;
  aggregationType: string;
  unit: string;
  missingFrom: "baseline" | "candidate";
  baselineValue: number | null;
  candidateValue: number | null;
  severity: Severity;
}

export function buildReportResponse(
  comparison: PersistedComparisonReadModel,
): ReportResponse {
  const data: ReportResponse["data"] = {
    comparison: buildComparisonMetadata(comparison),
    summary: comparison.summary,
    summaryText: generateComparisonReportSummary({
      summary: comparison.summary,
      findings: comparison.findings,
    }),
    groupedFindings: groupFindings(comparison.findings),
    chartSections: buildChartSections(comparison),
  };

  return { data };
}

function buildComparisonMetadata(
  comparison: PersistedComparisonReadModel,
): ReportComparisonMetadata {
  const metadata: ReportComparisonMetadata = {
    id: comparison.id,
    suiteId: comparison.suiteId,
    baselineRunId: comparison.baselineRunId,
    candidateRunId: comparison.candidateRunId,
    createdAt: comparison.createdAt,
  };

  if (comparison.label !== undefined) {
    metadata.label = comparison.label;
  }

  if (comparison.thresholdRules !== undefined) {
    metadata.thresholdRules = comparison.thresholdRules;
  }

  return metadata;
}

function groupFindings(
  findings: PersistedComparisonFindingReadModel[],
): ReportGroupedFindings {
  return {
    byStatus: groupedFindings(STATUS_ORDER, findings, (finding) => finding.status),
    bySeverity: groupedFindings(SEVERITY_ORDER, findings, (finding) => finding.severity),
    byMetricGroup: groupedFindings(
      metricGroupKeys(findings),
      findings,
      (finding) => finding.metricGroup,
    ),
  };
}

function groupedFindings<TGroupKey extends string>(
  orderedKeys: TGroupKey[],
  findings: PersistedComparisonFindingReadModel[],
  groupKey: (finding: PersistedComparisonFindingReadModel) => TGroupKey,
): Array<ReportFindingGroup<TGroupKey>> {
  const groups = new Map<TGroupKey, PersistedComparisonFindingReadModel[]>(
    orderedKeys.map((key) => [key, []]),
  );

  for (const finding of findings) {
    const key = groupKey(finding);
    const group = groups.get(key) ?? [];
    group.push(finding);
    groups.set(key, group);
  }

  return orderedKeys.map((key) => {
    const grouped = groups.get(key) ?? [];
    return {
      key,
      count: grouped.length,
      findings: grouped,
    };
  });
}

function buildChartSections(
  comparison: PersistedComparisonReadModel,
): ReportChartSection[] {
  return [
    buildStatusCountsSection(comparison.summary),
    buildSeverityCountsSection(comparison.findings),
    buildPercentDeltaSection(comparison.findings),
    buildMissingMetricsSection(comparison.findings),
  ];
}

function buildStatusCountsSection(summary: ComparisonSummary): CountChartSection {
  const counts: Record<ComparisonStatus, number> = {
    regressed: summary.regressions,
    improved: summary.improvements,
    unchanged: summary.unchanged,
    missing: summary.missing,
  };

  return {
    id: "finding-status-counts",
    title: "Finding Status Counts",
    visualization: "bar",
    xKey: "status",
    yKey: "count",
    data: STATUS_ORDER.map((status) => ({
      key: status,
      label: labelForKey(status),
      count: counts[status],
    })),
  };
}

function buildSeverityCountsSection(
  findings: PersistedComparisonFindingReadModel[],
): CountChartSection {
  return {
    id: "finding-severity-counts",
    title: "Finding Severity Counts",
    visualization: "bar",
    xKey: "severity",
    yKey: "count",
    data: SEVERITY_ORDER.map((severity) => ({
      key: severity,
      label: labelForKey(severity),
      count: findings.filter((finding) => finding.severity === severity).length,
    })),
  };
}

function buildPercentDeltaSection(
  findings: PersistedComparisonFindingReadModel[],
): MetricDeltaChartSection {
  return {
    id: "metric-percent-deltas",
    title: "Metric Percent Deltas",
    visualization: "bar",
    xKey: "metricKey",
    yKey: "deltaPercent",
    unit: "percent",
    data: findings
      .filter(isPercentDeltaFinding)
      .sort(compareFindingIdentity)
      .map((finding) => ({
        metricKey: metricKey(finding),
        metricName: finding.metricName,
        metricGroup: finding.metricGroup,
        aggregationType: finding.aggregationType,
        unit: finding.unit,
        baselineValue: finding.baselineValue,
        candidateValue: finding.candidateValue,
        deltaPercent: finding.deltaPercent,
        deltaAbsolute: finding.deltaAbsolute,
        status: finding.status,
        severity: finding.severity,
      })),
  };
}

function buildMissingMetricsSection(
  findings: PersistedComparisonFindingReadModel[],
): MissingMetricsChartSection {
  return {
    id: "missing-metrics",
    title: "Missing Metrics",
    visualization: "table",
    data: findings
      .filter((finding) => finding.status === "missing")
      .sort(compareFindingIdentity)
      .map((finding) => ({
        metricKey: metricKey(finding),
        metricName: finding.metricName,
        metricGroup: finding.metricGroup,
        aggregationType: finding.aggregationType,
        unit: finding.unit,
        missingFrom: finding.baselineValue === null ? "baseline" : "candidate",
        baselineValue: finding.baselineValue,
        candidateValue: finding.candidateValue,
        severity: finding.severity,
      })),
  };
}

function isPercentDeltaFinding(
  finding: PersistedComparisonFindingReadModel,
): finding is PersistedComparisonFindingReadModel & {
  baselineValue: number;
  candidateValue: number;
  deltaAbsolute: number;
  deltaPercent: number;
} {
  return (
    finding.status !== "missing" &&
    finding.baselineValue !== null &&
    finding.candidateValue !== null &&
    finding.deltaAbsolute !== null &&
    finding.deltaPercent !== null
  );
}

function metricGroupKeys(findings: PersistedComparisonFindingReadModel[]): string[] {
  return [...new Set(findings.map((finding) => finding.metricGroup))].sort();
}

function compareFindingIdentity(
  left: ComparisonFinding,
  right: ComparisonFinding,
): number {
  return (
    left.metricGroup.localeCompare(right.metricGroup) ||
    left.metricName.localeCompare(right.metricName) ||
    left.aggregationType.localeCompare(right.aggregationType) ||
    left.unit.localeCompare(right.unit)
  );
}

function metricKey(finding: ComparisonFinding): string {
  return `${finding.metricName}::${finding.aggregationType}::${finding.unit}`;
}

function labelForKey(value: string): string {
  return value
    .split("_")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}
