import { BadRequestException } from "@nestjs/common";
import type { CreatePersistedComparisonInput } from "../../comparisons/persisted-comparison.service.js";
import type { ComparisonStatus, Severity, ThresholdRule } from "../../comparisons/types.js";

const stringRuleFields = [
  "metricName",
  "metricNamePattern",
  "metricGroup",
  "aggregationType",
  "unit",
] as const;
const numberRuleFields = [
  "warnAbovePercent",
  "mediumAbovePercent",
  "highAbovePercent",
  "warnBelowPercent",
  "mediumBelowPercent",
  "highBelowPercent",
] as const;
const statusRuleFields = ["statusOnAbove", "statusOnBelow"] as const;
const statusValues = new Set<Extract<ComparisonStatus, "improved" | "regressed">>([
  "improved",
  "regressed",
]);
const severityValues = new Set<Severity>(["none", "low", "medium", "high"]);

export function parseCreateComparisonRequest(body: unknown): CreatePersistedComparisonInput {
  if (!isRecord(body)) {
    throw comparisonRequestValidationError("request body must be an object");
  }

  const baselineRunId = readRequiredString(body.baselineRunId, "baselineRunId");
  const candidateRunId = readRequiredString(body.candidateRunId, "candidateRunId");
  const label = readOptionalString(body.label, "label");
  const thresholdRules = readThresholdRules(body.thresholdRules);
  const input: CreatePersistedComparisonInput = {
    baselineRunId,
    candidateRunId,
  };

  if (label !== undefined) {
    input.label = label;
  }

  if (thresholdRules !== undefined) {
    input.thresholdRules = thresholdRules;
  }

  return input;
}

export function validateComparisonIdParam(value: unknown): string {
  return readRequiredString(value, "id");
}

function readThresholdRules(value: unknown): ThresholdRule[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseMaybeJson(value, "thresholdRules");

  if (!Array.isArray(parsed)) {
    throw comparisonRequestValidationError("thresholdRules must be an array");
  }

  return parsed.map((rule, index) => readThresholdRule(rule, index));
}

function readThresholdRule(value: unknown, index: number): ThresholdRule {
  if (!isRecord(value)) {
    throw comparisonRequestValidationError(`thresholdRules[${index}] must be an object`);
  }

  const rule: ThresholdRule = {};

  for (const field of stringRuleFields) {
    const parsed = readOptionalString(value[field], `thresholdRules[${index}].${field}`);

    if (parsed !== undefined) {
      rule[field] = parsed;
    }
  }

  if (rule.metricName === undefined && rule.metricNamePattern === undefined) {
    throw comparisonRequestValidationError(
      `thresholdRules[${index}] must include metricName or metricNamePattern`,
    );
  }

  for (const field of numberRuleFields) {
    const parsed = readOptionalNumber(value[field], `thresholdRules[${index}].${field}`);

    if (parsed !== undefined) {
      rule[field] = parsed;
    }
  }

  for (const field of statusRuleFields) {
    const parsed = readOptionalStatus(value[field], `thresholdRules[${index}].${field}`);

    if (parsed !== undefined) {
      rule[field] = parsed;
    }
  }

  const missingSeverity = readOptionalSeverity(
    value.missingSeverity,
    `thresholdRules[${index}].missingSeverity`,
  );

  if (missingSeverity !== undefined) {
    rule.missingSeverity = missingSeverity;
  }

  return rule;
}

function readRequiredString(value: unknown, label: string): string {
  const parsed = readString(value);

  if (parsed === undefined) {
    throw comparisonRequestValidationError(`${label} is required`);
  }

  return parsed;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = readString(value);

  if (parsed === undefined) {
    throw comparisonRequestValidationError(`${label} must be a non-empty string`);
  }

  return parsed;
}

function readString(value: unknown): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue !== "string") {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue === "string" && rawValue.trim().length > 0) {
    const parsed = Number(rawValue);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  throw comparisonRequestValidationError(`${label} must be numeric`);
}

function readOptionalStatus(
  value: unknown,
  label: string,
): Extract<ComparisonStatus, "improved" | "regressed"> | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = readString(value);

  if (parsed === undefined || !statusValues.has(parsed as Extract<ComparisonStatus, "improved" | "regressed">)) {
    throw comparisonRequestValidationError(`${label} must be "improved" or "regressed"`);
  }

  return parsed as Extract<ComparisonStatus, "improved" | "regressed">;
}

function readOptionalSeverity(value: unknown, label: string): Severity | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = readString(value);

  if (parsed === undefined || !severityValues.has(parsed as Severity)) {
    throw comparisonRequestValidationError(`${label} must be one of none, low, medium, high`);
  }

  return parsed as Severity;
}

function parseMaybeJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    return value;
  }

  if (value.trim().length === 0) {
    throw comparisonRequestValidationError(`${label} must be valid JSON`);
  }

  try {
    return JSON.parse(value);
  } catch {
    throw comparisonRequestValidationError(`${label} must be valid JSON`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function comparisonRequestValidationError(message: string): BadRequestException {
  return new BadRequestException({
    code: "COMPARISON_REQUEST_VALIDATION_ERROR",
    message,
  });
}
