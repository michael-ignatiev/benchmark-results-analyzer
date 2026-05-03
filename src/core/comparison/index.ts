export { ComparisonValidationError } from "./comparison-validation-error.js";
export {
  generateComparisonReportSummary,
} from "./report-summary.service.js";
export type {
  GenerateComparisonReportSummaryInput,
} from "./report-summary.service.js";
export {
  compareCanonicalMetrics,
  compareRuns,
  metricIdentityKey,
  summarizeFindings,
} from "./comparison.service.js";
export {
  evaluateThresholdRule,
  findMatchingThresholdRule,
  thresholdRuleAppliesToDirection,
} from "./threshold-rules.js";
export type {
  ChangeDirection,
  CompareRunsOptions,
  ComparisonFinding,
  ComparisonRunInput,
  ComparisonRunMetadata,
  ComparisonReportSummaryOptions,
  ComparisonStatus,
  ComparisonSummary,
  CriticalMetricSelector,
  Delta,
  DirectionalInterpretation,
  DirectionalThresholds,
  IndexedMetric,
  MetricIdentity,
  MetricWithIdentity,
  RuleMatch,
  RunComparisonResult,
  Severity,
  ThresholdEvaluation,
  ThresholdRule,
} from "./types.js";
