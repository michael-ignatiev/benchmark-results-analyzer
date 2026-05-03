import type {
  ComparisonFinding,
  ComparisonSummary,
  PersistedComparisonReadModel,
  SuiteHistoryMetricPoint,
  SuiteHistoryMetricSelector,
} from "../index.js";

export function formatComparisonSummary(summary: ComparisonSummary): string {
  return [
    `${summary.regressions} regressions`,
    `${summary.improvements} improvements`,
    `${summary.unchanged} unchanged`,
    `${summary.missing} missing`,
  ].join(", ");
}

export function groupFindings(
  findings: ComparisonFinding[],
): Record<ComparisonFinding["status"], ComparisonFinding[]> {
  return {
    regressed: findings.filter((finding) => finding.status === "regressed"),
    improved: findings.filter((finding) => finding.status === "improved"),
    unchanged: findings.filter((finding) => finding.status === "unchanged"),
    missing: findings.filter((finding) => finding.status === "missing"),
  };
}

export function formatMarkdownReport(
  comparison: PersistedComparisonReadModel,
  summaryText: string,
): string {
  const grouped = groupFindings(comparison.findings);
  const lines = [
    `# Comparison ${comparison.id}`,
    "",
    summaryText,
    "",
    `- Baseline run: ${comparison.baselineRunId}`,
    `- Candidate run: ${comparison.candidateRunId}`,
    `- Created at: ${comparison.createdAt}`,
    `- Summary: ${formatComparisonSummary(comparison.summary)}`,
    "",
  ];

  for (const [title, findings] of [
    ["Regressions", grouped.regressed],
    ["Improvements", grouped.improved],
    ["Unchanged", grouped.unchanged],
    ["Missing Metrics", grouped.missing],
  ] as const) {
    lines.push(`## ${title}`);

    if (findings.length === 0) {
      lines.push("", "None.", "");
      continue;
    }

    lines.push("");

    for (const finding of findings) {
      lines.push(
        `- ${finding.metricName} ${finding.aggregationType} ${finding.unit}: ${finding.reason}`,
      );
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function metricSelectorKey(metric: SuiteHistoryMetricSelector): string {
  return `${metric.metricName}:${metric.aggregationType}:${metric.unit}`;
}

export function pointMetricKey(point: SuiteHistoryMetricPoint): string {
  return `${point.metricName}:${point.aggregationType}:${point.unit}`;
}

export function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
