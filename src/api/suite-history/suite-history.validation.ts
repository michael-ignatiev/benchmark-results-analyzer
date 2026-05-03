import { BadRequestException } from "@nestjs/common";
import { SOURCE_TYPES, type SourceType } from "../../parsers/types.js";
import type {
  SuiteHistoryFilters,
  SuiteHistoryMetricSelector,
  SuiteHistoryQuery,
} from "../../persistence/run-repository.js";

type QueryRecord = Record<string, unknown>;

export function parseSuiteHistoryRequest(
  suiteId: string,
  query: QueryRecord,
): SuiteHistoryQuery {
  const metricKeys = readMetricKeys(query);

  if (metricKeys.length === 0) {
    throw suiteHistoryValidationError("metrics query parameter is required");
  }

  const filters = readFilters(query);
  const parsed: SuiteHistoryQuery = {
    suiteId: readRequiredString(suiteId, "suiteId"),
    metrics: metricKeys.map(parseMetricKey),
  };

  if (filters.environment !== undefined) {
    parsed.environment = filters.environment;
  }

  if (filters.branchName !== undefined) {
    parsed.branchName = filters.branchName;
  }

  if (filters.sourceType !== undefined) {
    parsed.sourceType = filters.sourceType;
  }

  return parsed;
}

function readFilters(query: QueryRecord): SuiteHistoryFilters {
  const filters: SuiteHistoryFilters = {};
  const environment = readOptionalString(query.environment, "environment");
  const branchName =
    readOptionalString(query.branchName, "branchName") ??
    readOptionalString(query.branch, "branch");
  const sourceType = readOptionalSourceType(query.sourceType);

  if (environment !== undefined) {
    filters.environment = environment;
  }

  if (branchName !== undefined) {
    filters.branchName = branchName;
  }

  if (sourceType !== undefined) {
    filters.sourceType = sourceType;
  }

  return filters;
}

function readMetricKeys(query: QueryRecord): string[] {
  const rawValues = [...readStringList(query.metrics), ...readStringList(query.metric)];
  const uniqueValues: string[] = [];

  for (const value of rawValues.flatMap((rawValue) => rawValue.split(","))) {
    const trimmed = value.trim();

    if (trimmed.length > 0 && !uniqueValues.includes(trimmed)) {
      uniqueValues.push(trimmed);
    }
  }

  return uniqueValues;
}

function parseMetricKey(metricKey: string): SuiteHistoryMetricSelector {
  const [metricName, aggregationType, unit, extra] = metricKey.split("::");

  if (
    metricName === undefined ||
    aggregationType === undefined ||
    unit === undefined ||
    extra !== undefined ||
    metricName.trim().length === 0 ||
    aggregationType.trim().length === 0 ||
    unit.trim().length === 0
  ) {
    throw suiteHistoryValidationError(
      `metric key "${metricKey}" must use metricName::aggregationType::unit`,
    );
  }

  return {
    metricName: metricName.trim(),
    aggregationType: aggregationType.trim(),
    unit: unit.trim(),
  };
}

function readOptionalSourceType(value: unknown): SourceType | undefined {
  const sourceType = readOptionalString(value, "sourceType");

  if (sourceType === undefined) {
    return undefined;
  }

  if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
    throw suiteHistoryValidationError(`sourceType must be one of ${SOURCE_TYPES.join(", ")}`);
  }

  return sourceType as SourceType;
}

function readRequiredString(value: unknown, label: string): string {
  const parsed = readString(value);

  if (parsed === undefined) {
    throw suiteHistoryValidationError(`${label} is required`);
  }

  return parsed;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = readString(value);

  if (parsed === undefined) {
    throw suiteHistoryValidationError(`${label} must be a non-empty string`);
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

function readStringList(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const parsed = readString(item);
      return parsed === undefined ? [] : [parsed];
    });
  }

  const parsed = readString(value);
  return parsed === undefined ? [] : [parsed];
}

export function suiteHistoryValidationError(message: string): BadRequestException {
  return new BadRequestException({
    code: "SUITE_HISTORY_VALIDATION_ERROR",
    message,
  });
}
