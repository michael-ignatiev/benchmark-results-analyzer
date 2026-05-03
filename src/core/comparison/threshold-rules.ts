import type { CanonicalMetric } from "../metrics/types.js";
import type {
  DirectionalThresholds,
  RuleMatch,
  Severity,
  ThresholdEvaluation,
  ThresholdRule,
} from "./types.js";

export function findMatchingThresholdRule(
  metric: CanonicalMetric,
  rules: ThresholdRule[],
): RuleMatch | undefined {
  const matches = rules
    .map((rule, index): RuleMatch | undefined => {
      if (!ruleMatchesMetric(rule, metric)) {
        return undefined;
      }

      return {
        rule,
        index,
        specificity: ruleSpecificity(rule),
      };
    })
    .filter((match): match is RuleMatch => match !== undefined);

  return matches.sort(
    (left, right) => right.specificity - left.specificity || left.index - right.index,
  )[0];
}

export function evaluateThresholdRule(
  deltaPercent: number,
  rule: ThresholdRule,
): ThresholdEvaluation {
  if (deltaPercent === 0) {
    return { rule, severity: "none", thresholdPercent: null, direction: "none" };
  }

  const direction = deltaPercent > 0 ? "above" : "below";
  const thresholds =
    direction === "above" ? aboveThresholds(rule) : belowThresholds(rule);
  const severity =
    direction === "above"
      ? severityForAboveThreshold(deltaPercent, thresholds)
      : severityForBelowThreshold(deltaPercent, thresholds);
  const thresholdPercent = thresholdForSeverity(severity, thresholds);

  return {
    rule,
    severity,
    thresholdPercent,
    direction,
  };
}

export function thresholdRuleAppliesToDirection(
  rule: ThresholdRule,
  direction: ThresholdEvaluation["direction"],
): boolean {
  if (direction === "none") {
    return false;
  }

  const thresholds = direction === "above" ? aboveThresholds(rule) : belowThresholds(rule);
  return (
    thresholds.warn !== undefined ||
    thresholds.medium !== undefined ||
    thresholds.high !== undefined
  );
}

function ruleMatchesMetric(rule: ThresholdRule, metric: CanonicalMetric): boolean {
  if (rule.metricName !== undefined && rule.metricName !== metric.metricName) {
    return false;
  }

  if (
    rule.metricNamePattern !== undefined &&
    !wildcardPatternMatches(rule.metricNamePattern, metric.metricName)
  ) {
    return false;
  }

  if (rule.metricGroup !== undefined && rule.metricGroup !== metric.metricGroup) {
    return false;
  }

  if (rule.aggregationType !== undefined && rule.aggregationType !== metric.aggregationType) {
    return false;
  }

  if (rule.unit !== undefined && rule.unit !== metric.unit) {
    return false;
  }

  return rule.metricName !== undefined || rule.metricNamePattern !== undefined;
}

function ruleSpecificity(rule: ThresholdRule): number {
  let score = 0;

  if (rule.metricName !== undefined) {
    score += 100;
  }

  if (rule.metricNamePattern !== undefined) {
    score += 50;
  }

  if (rule.aggregationType !== undefined) {
    score += 20;
  }

  if (rule.unit !== undefined) {
    score += 10;
  }

  if (rule.metricGroup !== undefined) {
    score += 5;
  }

  return score;
}

function wildcardPatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(value);
}

function aboveThresholds(rule: ThresholdRule): DirectionalThresholds {
  return compactThresholds({
    warn: normalizeAboveThreshold(rule.warnAbovePercent),
    medium: normalizeAboveThreshold(rule.mediumAbovePercent),
    high: normalizeAboveThreshold(rule.highAbovePercent),
  });
}

function belowThresholds(rule: ThresholdRule): DirectionalThresholds {
  return compactThresholds({
    warn: normalizeBelowThreshold(rule.warnBelowPercent),
    medium: normalizeBelowThreshold(rule.mediumBelowPercent),
    high: normalizeBelowThreshold(rule.highBelowPercent),
  });
}

function compactThresholds(
  thresholds: Record<keyof DirectionalThresholds, number | undefined>,
): DirectionalThresholds {
  const compacted: DirectionalThresholds = {};

  if (thresholds.warn !== undefined) {
    compacted.warn = thresholds.warn;
  }

  if (thresholds.medium !== undefined) {
    compacted.medium = thresholds.medium;
  }

  if (thresholds.high !== undefined) {
    compacted.high = thresholds.high;
  }

  return compacted;
}

function severityForAboveThreshold(
  deltaPercent: number,
  thresholds: DirectionalThresholds,
): Severity {
  if (thresholds.high !== undefined && deltaPercent > thresholds.high) {
    return "high";
  }

  if (thresholds.medium !== undefined && deltaPercent > thresholds.medium) {
    return "medium";
  }

  if (thresholds.warn !== undefined && deltaPercent > thresholds.warn) {
    return "low";
  }

  return "none";
}

function severityForBelowThreshold(
  deltaPercent: number,
  thresholds: DirectionalThresholds,
): Severity {
  if (thresholds.high !== undefined && deltaPercent < thresholds.high) {
    return "high";
  }

  if (thresholds.medium !== undefined && deltaPercent < thresholds.medium) {
    return "medium";
  }

  if (thresholds.warn !== undefined && deltaPercent < thresholds.warn) {
    return "low";
  }

  return "none";
}

function thresholdForSeverity(
  severity: Severity,
  thresholds: DirectionalThresholds,
): number | null {
  if (severity === "high") {
    return thresholds.high ?? null;
  }

  if (severity === "medium") {
    return thresholds.medium ?? null;
  }

  if (severity === "low") {
    return thresholds.warn ?? null;
  }

  return null;
}

function normalizeAboveThreshold(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.abs(value);
}

function normalizeBelowThreshold(value: number | undefined): number | undefined {
  return value === undefined ? undefined : -Math.abs(value);
}
