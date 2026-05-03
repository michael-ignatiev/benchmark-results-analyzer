import { ComparisonValidationError } from "./comparison-validation-error.js";
import { generateComparisonReportSummary } from "./report-summary.service.js";
import {
  evaluateThresholdRule,
  findMatchingThresholdRule,
  thresholdRuleAppliesToDirection,
} from "./threshold-rules.js";
import type {
  ChangeDirection,
  CompareRunsOptions,
  ComparisonFinding,
  ComparisonRunInput,
  ComparisonRunMetadata,
  ComparisonStatus,
  ComparisonSummary,
  Delta,
  DirectionalInterpretation,
  MetricWithIdentity,
  RunComparisonResult,
  ThresholdEvaluation,
  ThresholdRule,
} from "./types.js";
import type { CanonicalMetric } from "../metrics/types.js";

export function compareRuns(
  baseline: ComparisonRunInput,
  candidate: ComparisonRunInput,
  options: CompareRunsOptions = {},
): RunComparisonResult {
  const findings = compareCanonicalMetrics(baseline.metrics, candidate.metrics, options);
  const summary = summarizeFindings(findings);

  return {
    baseline: extractRunMetadata(baseline),
    candidate: extractRunMetadata(candidate),
    findings,
    summary,
    reportSummary: generateComparisonReportSummary(
      {
        summary,
        findings,
      },
      options.reportSummary,
    ),
  };
}

export function compareCanonicalMetrics(
  baselineMetrics: CanonicalMetric[],
  candidateMetrics: CanonicalMetric[],
  options: CompareRunsOptions = {},
): ComparisonFinding[] {
  const thresholdRules = options.thresholdRules ?? [];
  const baselineByKey = indexMetrics(baselineMetrics, "baseline");
  const candidateByKey = indexMetrics(candidateMetrics, "candidate");
  const keys = [...new Set([...baselineByKey.keys(), ...candidateByKey.keys()])].sort();

  return keys.map((key) => {
    const baselineMetric = baselineByKey.get(key);
    const candidateMetric = candidateByKey.get(key);
    const metric = baselineMetric ?? candidateMetric;

    if (metric === undefined) {
      throw new ComparisonValidationError(`Unable to resolve metric for comparison key "${key}"`);
    }

    const rule = findMatchingThresholdRule(metric, thresholdRules);

    if (baselineMetric === undefined || candidateMetric === undefined) {
      return buildMissingFinding(metric, baselineMetric, candidateMetric, rule?.rule);
    }

    validateComparableMetricPair(key, baselineMetric, candidateMetric);
    return buildComparableFinding(baselineMetric, candidateMetric, rule?.rule);
  });
}

export function metricIdentityKey(metric: CanonicalMetric): string {
  return `${metric.metricName}::${metric.aggregationType}::${metric.unit}`;
}

export function summarizeFindings(findings: ComparisonFinding[]): ComparisonSummary {
  return {
    totalMetrics: findings.length,
    comparedMetrics: findings.filter((finding) => finding.status !== "missing").length,
    regressions: findings.filter((finding) => finding.status === "regressed").length,
    improvements: findings.filter((finding) => finding.status === "improved").length,
    unchanged: findings.filter((finding) => finding.status === "unchanged").length,
    missing: findings.filter((finding) => finding.status === "missing").length,
    highSeverityRegressions: findings.filter(
      (finding) => finding.status === "regressed" && finding.severity === "high",
    ).length,
  };
}

function buildComparableFinding(
  baselineMetric: CanonicalMetric,
  candidateMetric: CanonicalMetric,
  rule: ThresholdRule | undefined,
): ComparisonFinding {
  const delta = calculateDelta(baselineMetric.valueNumeric, candidateMetric.valueNumeric);
  const interpretation = interpretDirection(baselineMetric.direction, delta.absolute);
  const thresholdEvaluation =
    delta.percent === null || rule === undefined
      ? undefined
      : evaluateThresholdRule(delta.percent, rule);
  const classification = classifyFinding(
    baselineMetric,
    delta,
    interpretation,
    thresholdEvaluation,
    rule,
  );

  return {
    metricName: baselineMetric.metricName,
    metricGroup: baselineMetric.metricGroup,
    aggregationType: baselineMetric.aggregationType,
    unit: baselineMetric.unit,
    baselineValue: baselineMetric.valueNumeric,
    candidateValue: candidateMetric.valueNumeric,
    deltaAbsolute: delta.absolute,
    deltaPercent: delta.percent,
    status: classification.status,
    severity: classification.severity,
    reason: classification.reason,
  };
}

function buildMissingFinding(
  metric: CanonicalMetric,
  baselineMetric: CanonicalMetric | undefined,
  candidateMetric: CanonicalMetric | undefined,
  rule: ThresholdRule | undefined,
): ComparisonFinding {
  const missingSeverity = rule?.missingSeverity ?? "none";

  return {
    metricName: metric.metricName,
    metricGroup: metric.metricGroup,
    aggregationType: metric.aggregationType,
    unit: metric.unit,
    baselineValue: baselineMetric?.valueNumeric ?? null,
    candidateValue: candidateMetric?.valueNumeric ?? null,
    deltaAbsolute: null,
    deltaPercent: null,
    status: "missing",
    severity: missingSeverity,
    reason:
      baselineMetric === undefined
        ? "Metric introduced in candidate but absent in baseline"
        : "Metric present in baseline but missing in candidate",
  };
}

function calculateDelta(baselineValue: number, candidateValue: number): Delta {
  return {
    absolute: candidateValue - baselineValue,
    percent: baselineValue === 0 ? null : ((candidateValue - baselineValue) / baselineValue) * 100,
  };
}

function classifyFinding(
  metric: CanonicalMetric,
  delta: Delta,
  interpretation: DirectionalInterpretation,
  thresholdEvaluation: ThresholdEvaluation | undefined,
  rule: ThresholdRule | undefined,
): Pick<ComparisonFinding, "status" | "severity" | "reason"> {
  if (delta.absolute === 0) {
    return {
      status: "unchanged",
      severity: "none",
      reason: `${metricLabel(metric)} was unchanged`,
    };
  }

  if (delta.percent === null) {
    return {
      status: interpretation.status,
      severity: "none",
      reason: `${metricLabel(metric)} ${changeVerb(interpretation.changeDirection)} by ${formatNumber(
        Math.abs(delta.absolute),
      )} ${metric.unit}. Baseline value is zero; percent delta not computed`,
    };
  }

  if (metric.direction === "neutral") {
    return classifyNeutralMetric(metric, delta, thresholdEvaluation, rule);
  }

  if (
    rule !== undefined &&
    thresholdEvaluation?.severity === "none" &&
    thresholdRuleAppliesToDirection(rule, thresholdEvaluation.direction)
  ) {
    return {
      status: "unchanged",
      severity: "none",
      reason: `${metricLabel(metric)} ${changeVerb(interpretation.changeDirection)} by ${formatPercent(
        Math.abs(delta.percent),
      )} relative to baseline, within configured tolerance`,
    };
  }

  const severity = thresholdEvaluation?.severity ?? "none";

  return {
    status: interpretation.status,
    severity,
    reason: buildDirectionalReason(metric, delta, interpretation, thresholdEvaluation),
  };
}

function classifyNeutralMetric(
  metric: CanonicalMetric,
  delta: Delta,
  thresholdEvaluation: ThresholdEvaluation | undefined,
  rule: ThresholdRule | undefined,
): Pick<ComparisonFinding, "status" | "severity" | "reason"> {
  const status = statusForNeutralRule(delta, thresholdEvaluation, rule);

  if (status === "unchanged") {
    return {
      status,
      severity: "none",
      reason: `${metricLabel(metric)} changed by ${formatPercent(
        Math.abs(delta.percent ?? 0),
      )} relative to baseline; metric direction is neutral`,
    };
  }

  return {
    status,
    severity: thresholdEvaluation?.severity ?? "none",
    reason: buildDirectionalReason(
      metric,
      delta,
      {
        status,
        changeDirection: delta.absolute > 0 ? "increase" : "decrease",
      },
      thresholdEvaluation,
    ),
  };
}

function buildDirectionalReason(
  metric: CanonicalMetric,
  delta: Delta,
  interpretation: DirectionalInterpretation,
  thresholdEvaluation: ThresholdEvaluation | undefined,
): string {
  const base = `${metricLabel(metric)} ${changeVerb(interpretation.changeDirection)} by ${formatPercent(
    Math.abs(delta.percent ?? 0),
  )} relative to baseline`;

  if (thresholdEvaluation === undefined || thresholdEvaluation.thresholdPercent === null) {
    return `${base}; no threshold rule configured`;
  }

  const statusLabel =
    interpretation.status === "regressed"
      ? "regression"
      : interpretation.status === "improved"
        ? "improvement"
        : "change";

  return `${base}, exceeding the ${formatPercent(
    Math.abs(thresholdEvaluation.thresholdPercent),
  )} ${statusLabel} threshold`;
}

function interpretDirection(
  direction: CanonicalMetric["direction"],
  deltaAbsolute: number,
): DirectionalInterpretation {
  if (deltaAbsolute === 0) {
    return { status: "unchanged", changeDirection: "none" };
  }

  if (direction === "neutral") {
    return {
      status: "unchanged",
      changeDirection: deltaAbsolute > 0 ? "increase" : "decrease",
    };
  }

  if (direction === "lower_is_better") {
    return {
      status: deltaAbsolute > 0 ? "regressed" : "improved",
      changeDirection: deltaAbsolute > 0 ? "increase" : "decrease",
    };
  }

  return {
    status: deltaAbsolute > 0 ? "improved" : "regressed",
    changeDirection: deltaAbsolute > 0 ? "increase" : "decrease",
  };
}

function statusForNeutralRule(
  delta: Delta,
  thresholdEvaluation: ThresholdEvaluation | undefined,
  rule: ThresholdRule | undefined,
): ComparisonStatus {
  if (rule === undefined || thresholdEvaluation?.severity === "none") {
    return "unchanged";
  }

  if (delta.absolute > 0) {
    return rule.statusOnAbove ?? "unchanged";
  }

  if (delta.absolute < 0) {
    return rule.statusOnBelow ?? "unchanged";
  }

  return "unchanged";
}

function indexMetrics(
  metrics: CanonicalMetric[],
  runRole: "baseline" | "candidate",
): Map<string, CanonicalMetric> {
  const indexed = new Map<string, CanonicalMetric>();

  for (const metric of metrics) {
    validateMetric(metric, runRole);
    const key = metricIdentityKey(metric);

    if (indexed.has(key)) {
      throw new ComparisonValidationError(
        `Duplicate ${runRole} metric identity "${key}"`,
        "DUPLICATE_METRIC_IDENTITY",
      );
    }

    indexed.set(key, metric);
  }

  return indexed;
}

function validateMetric(metric: CanonicalMetric, runRole: "baseline" | "candidate"): void {
  const identity: MetricWithIdentity = metric;
  const requiredFields: Array<keyof MetricWithIdentity> = [
    "metricName",
    "metricGroup",
    "aggregationType",
    "unit",
    "direction",
  ];

  for (const field of requiredFields) {
    if (typeof identity[field] !== "string" || identity[field].trim().length === 0) {
      throw new ComparisonValidationError(`${runRole} metric ${field} must be a non-empty string`);
    }
  }

  if (!Number.isFinite(metric.valueNumeric)) {
    throw new ComparisonValidationError(`${runRole} metric valueNumeric must be a finite number`);
  }
}

function validateComparableMetricPair(
  key: string,
  baselineMetric: CanonicalMetric,
  candidateMetric: CanonicalMetric,
): void {
  if (baselineMetric.direction !== candidateMetric.direction) {
    throw new ComparisonValidationError(
      `Metric "${key}" has conflicting directions between baseline and candidate`,
    );
  }
}

function extractRunMetadata(input: ComparisonRunInput): ComparisonRunMetadata {
  const metadata: ComparisonRunMetadata = {};

  if (input.sourceType !== undefined) {
    metadata.sourceType = input.sourceType;
  }

  if (input.suite?.name !== undefined) {
    metadata.suiteName = input.suite.name;
  }

  if (input.suite?.scenarioName !== undefined) {
    metadata.scenarioName = input.suite.scenarioName;
  }

  if (input.run?.label !== undefined) {
    metadata.label = input.run.label;
  }

  if (input.run?.commitSha !== undefined) {
    metadata.commitSha = input.run.commitSha;
  }

  if (input.run?.branchName !== undefined) {
    metadata.branchName = input.run.branchName;
  }

  if (input.run?.environment !== undefined) {
    metadata.environment = input.run.environment;
  }

  if (input.run?.runAt !== undefined) {
    metadata.runAt = input.run.runAt;
  }

  return metadata;
}

function metricLabel(metric: CanonicalMetric): string {
  if (metric.metricGroup === "custom") {
    return `${metric.metricName} ${metric.aggregationType}`;
  }

  return `${metric.aggregationType} ${metric.metricGroup}`;
}

function changeVerb(changeDirection: ChangeDirection): string {
  if (changeDirection === "increase") {
    return "increased";
  }

  if (changeDirection === "decrease") {
    return "decreased";
  }

  return "changed";
}

function formatPercent(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
