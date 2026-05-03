import type {
  ComparisonFinding,
  ComparisonReportSummaryOptions,
  ComparisonSummary,
  CriticalMetricSelector,
  Severity,
} from "./types.js";

export interface GenerateComparisonReportSummaryInput {
  summary: ComparisonSummary;
  findings: ComparisonFinding[];
}

const DEFAULT_MAX_FINDINGS_PER_SECTION = 3;
const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};
const DEFAULT_CRITICAL_SELECTORS: CriticalMetricSelector[] = [
  { metricName: "http_req_failed" },
  { metricName: "checks", aggregationType: "rate" },
  { metricName: "tests_failed" },
  { metricName: "test_suites_failed" },
  { metricName: "duration_total" },
  { metricGroup: "latency", aggregationType: "p95" },
  { metricGroup: "latency", aggregationType: "p99" },
  { metricGroup: "reliability" },
  { metricGroup: "duration" },
];

export function generateComparisonReportSummary(
  input: GenerateComparisonReportSummaryInput,
  options: ComparisonReportSummaryOptions = {},
): string {
  const maxFindingsPerSection = Math.max(1, options.maxFindingsPerSection ?? DEFAULT_MAX_FINDINGS_PER_SECTION);
  const criticalSelectors = options.criticalMetricSelectors ?? DEFAULT_CRITICAL_SELECTORS;
  const sentences = [
    buildOverview(input.summary),
    ...buildFindingSections(input.findings, criticalSelectors, maxFindingsPerSection),
  ];

  if (sentences.length === 1 && input.summary.regressions === 0 && input.summary.missing === 0) {
    sentences.push("No regressions or important missing metrics were detected.");
  }

  return sentences.join(" ");
}

function buildOverview(summary: ComparisonSummary): string {
  const parts = [
    countPhrase(summary.regressions, "regression"),
    countPhrase(summary.improvements, "improvement"),
    `${summary.unchanged} unchanged`,
    countPhrase(summary.missing, "missing metric"),
  ];
  const highSeveritySuffix =
    summary.highSeverityRegressions > 0
      ? `, including ${countPhrase(summary.highSeverityRegressions, "high-severity regression")}`
      : "";

  return `Compared ${countPhrase(summary.totalMetrics, "metric")}: ${parts.join(", ")}${highSeveritySuffix}.`;
}

function buildFindingSections(
  findings: ComparisonFinding[],
  criticalSelectors: CriticalMetricSelector[],
  maxFindingsPerSection: number,
): string[] {
  const regressions = findings
    .filter((finding) => finding.status === "regressed")
    .sort(compareImpactThenIdentity);
  const improvements = findings
    .filter((finding) => finding.status === "improved")
    .sort(compareImpactThenIdentity);
  const unchangedCritical = findings
    .filter(
      (finding) =>
        finding.status === "unchanged" && isCriticalFinding(finding, criticalSelectors),
    )
    .sort(compareCriticalThenIdentity);
  const importantMissing = findings
    .filter(
      (finding) =>
        finding.status === "missing" &&
        (finding.severity !== "none" || isCriticalFinding(finding, criticalSelectors)),
    )
    .sort(compareImpactThenIdentity);
  const sections: string[] = [];

  if (regressions.length > 0) {
    sections.push(
      `Regressions: ${formatFindingList(regressions, formatDirectionalFinding, maxFindingsPerSection)}.`,
    );
  }

  if (improvements.length > 0) {
    sections.push(
      `Improvements: ${formatFindingList(improvements, formatDirectionalFinding, maxFindingsPerSection)}.`,
    );
  }

  if (unchangedCritical.length > 0) {
    sections.push(
      `Unchanged critical metrics: ${formatFindingList(
        unchangedCritical,
        formatUnchangedFinding,
        maxFindingsPerSection,
      )}.`,
    );
  }

  if (importantMissing.length > 0) {
    sections.push(
      `Important missing metrics: ${formatFindingList(
        importantMissing,
        formatMissingFinding,
        maxFindingsPerSection,
      )}.`,
    );
  }

  return sections;
}

function formatFindingList(
  findings: ComparisonFinding[],
  formatter: (finding: ComparisonFinding) => string,
  maxFindings: number,
): string {
  const displayed = findings.slice(0, maxFindings).map(formatter);
  const remaining = findings.length - displayed.length;

  if (remaining > 0) {
    displayed.push(`and ${remaining} more`);
  }

  return displayed.join("; ");
}

function formatDirectionalFinding(finding: ComparisonFinding): string {
  const severitySuffix = finding.severity === "none" ? "" : `, ${finding.severity}`;
  return `${metricLabel(finding)} ${finding.status} (${formatValue(
    finding.baselineValue,
    finding.unit,
  )} -> ${formatValue(finding.candidateValue, finding.unit)}, ${formatDelta(finding)}${severitySuffix})`;
}

function formatUnchangedFinding(finding: ComparisonFinding): string {
  if (finding.deltaAbsolute === 0) {
    return `${metricLabel(finding)} stayed at ${formatValue(finding.baselineValue, finding.unit)}`;
  }

  return `${metricLabel(finding)} remained within tolerance (${formatValue(
    finding.baselineValue,
    finding.unit,
  )} -> ${formatValue(finding.candidateValue, finding.unit)}, ${formatDelta(finding)})`;
}

function formatMissingFinding(finding: ComparisonFinding): string {
  const severitySuffix = finding.severity === "none" ? "" : `, ${finding.severity}`;

  if (finding.baselineValue === null) {
    return `${metricLabel(finding)} introduced in candidate at ${formatValue(
      finding.candidateValue,
      finding.unit,
    )}${severitySuffix}`;
  }

  return `${metricLabel(finding)} missing from candidate; baseline was ${formatValue(
    finding.baselineValue,
    finding.unit,
  )}${severitySuffix}`;
}

function formatDelta(finding: ComparisonFinding): string {
  if (finding.deltaPercent !== null) {
    return `${formatSignedNumber(finding.deltaPercent)}%`;
  }

  if (finding.deltaAbsolute !== null) {
    return `${formatSignedNumber(finding.deltaAbsolute)} ${unitLabel(finding.unit)}`.trim();
  }

  return "no delta";
}

function formatValue(value: number | null, unit: string): string {
  if (value === null) {
    return "n/a";
  }

  if (unit === "percent") {
    return `${formatNumber(value)}%`;
  }

  const formatted = formatNumber(value);
  const unitSuffix = unitLabel(unit);
  return unitSuffix.length === 0 ? formatted : `${formatted} ${unitSuffix}`;
}

function unitLabel(unit: string): string {
  return unit === "count" ? "" : unit;
}

function metricLabel(finding: ComparisonFinding): string {
  return `${finding.metricName} ${finding.aggregationType}`;
}

function isCriticalFinding(
  finding: ComparisonFinding,
  selectors: CriticalMetricSelector[],
): boolean {
  return selectors.some((selector) => selectorMatchesFinding(selector, finding));
}

function selectorMatchesFinding(
  selector: CriticalMetricSelector,
  finding: ComparisonFinding,
): boolean {
  if (selector.metricName !== undefined && selector.metricName !== finding.metricName) {
    return false;
  }

  if (selector.metricGroup !== undefined && selector.metricGroup !== finding.metricGroup) {
    return false;
  }

  if (
    selector.aggregationType !== undefined &&
    selector.aggregationType !== finding.aggregationType
  ) {
    return false;
  }

  if (selector.unit !== undefined && selector.unit !== finding.unit) {
    return false;
  }

  return (
    selector.metricName !== undefined ||
    selector.metricGroup !== undefined ||
    selector.aggregationType !== undefined ||
    selector.unit !== undefined
  );
}

function compareImpactThenIdentity(
  left: ComparisonFinding,
  right: ComparisonFinding,
): number {
  return (
    SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity] ||
    comparableMagnitude(right) - comparableMagnitude(left) ||
    metricLabel(left).localeCompare(metricLabel(right)) ||
    left.unit.localeCompare(right.unit)
  );
}

function compareCriticalThenIdentity(
  left: ComparisonFinding,
  right: ComparisonFinding,
): number {
  return (
    criticalRank(left) - criticalRank(right) ||
    metricLabel(left).localeCompare(metricLabel(right)) ||
    left.unit.localeCompare(right.unit)
  );
}

function comparableMagnitude(finding: ComparisonFinding): number {
  return Math.abs(finding.deltaPercent ?? finding.deltaAbsolute ?? 0);
}

function criticalRank(finding: ComparisonFinding): number {
  if (finding.metricGroup === "reliability") {
    return 0;
  }

  if (finding.metricName === "tests_failed" || finding.metricName === "test_suites_failed") {
    return 1;
  }

  if (finding.metricGroup === "latency" || finding.metricGroup === "duration") {
    return 2;
  }

  return 3;
}

function countPhrase(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

function formatSignedNumber(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
