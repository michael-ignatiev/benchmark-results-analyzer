import type {
  CanonicalMetric,
  MetricDirection,
  SourceType,
} from "../metrics/types.js";
import type { ParsedRunPayload } from "../parsers/types.js";

export type ComparisonStatus = "improved" | "regressed" | "unchanged" | "missing";

export type Severity = "none" | "low" | "medium" | "high";

export interface ComparisonFinding {
  metricName: string;
  metricGroup: string;
  aggregationType: string;
  unit: string;
  baselineValue: number | null;
  candidateValue: number | null;
  deltaAbsolute: number | null;
  deltaPercent: number | null;
  status: ComparisonStatus;
  severity: Severity;
  reason: string;
}

export interface ComparisonSummary {
  totalMetrics: number;
  comparedMetrics: number;
  regressions: number;
  improvements: number;
  unchanged: number;
  missing: number;
  highSeverityRegressions: number;
}

export interface RunComparisonResult {
  baseline: ComparisonRunMetadata;
  candidate: ComparisonRunMetadata;
  findings: ComparisonFinding[];
  summary: ComparisonSummary;
  reportSummary: string;
}

export interface ComparisonRunMetadata {
  sourceType?: SourceType;
  suiteName?: string;
  scenarioName?: string;
  label?: string;
  commitSha?: string;
  branchName?: string;
  environment?: string;
  runAt?: string;
}

export interface ComparisonRunInput {
  sourceType?: SourceType;
  suite?: ParsedRunPayload["suite"];
  run?: ParsedRunPayload["run"];
  metrics: CanonicalMetric[];
}

export interface CompareRunsOptions {
  thresholdRules?: ThresholdRule[];
  reportSummary?: ComparisonReportSummaryOptions;
}

export interface ComparisonReportSummaryOptions {
  maxFindingsPerSection?: number;
  criticalMetricSelectors?: CriticalMetricSelector[];
}

export interface CriticalMetricSelector {
  metricName?: string;
  metricGroup?: string;
  aggregationType?: string;
  unit?: string;
}

export interface ThresholdRule {
  metricName?: string;
  metricNamePattern?: string;
  metricGroup?: string;
  aggregationType?: string;
  unit?: string;
  warnAbovePercent?: number;
  mediumAbovePercent?: number;
  highAbovePercent?: number;
  warnBelowPercent?: number;
  mediumBelowPercent?: number;
  highBelowPercent?: number;
  statusOnAbove?: Extract<ComparisonStatus, "improved" | "regressed">;
  statusOnBelow?: Extract<ComparisonStatus, "improved" | "regressed">;
  missingSeverity?: Severity;
}

export interface IndexedMetric {
  key: string;
  metric: CanonicalMetric;
}

export interface ThresholdEvaluation {
  rule: ThresholdRule;
  severity: Severity;
  thresholdPercent: number | null;
  direction: "above" | "below" | "none";
}

export type ChangeDirection = "increase" | "decrease" | "none";

export interface DirectionalInterpretation {
  status: ComparisonStatus;
  changeDirection: ChangeDirection;
}

export interface Delta {
  absolute: number;
  percent: number | null;
}

export interface RuleMatch {
  rule: ThresholdRule;
  index: number;
  specificity: number;
}

export interface DirectionalThresholds {
  warn?: number;
  medium?: number;
  high?: number;
}

export interface MetricIdentity {
  metricName: string;
  aggregationType: string;
  unit: string;
}

export interface MetricWithIdentity extends MetricIdentity {
  metricGroup: string;
  direction: MetricDirection;
}
