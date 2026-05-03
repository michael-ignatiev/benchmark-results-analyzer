import { ParserValidationError } from "../parser-validation-error.js";
import {
  cloneSortedRecord,
  compactRecord,
  filenameBase,
  isRecord,
  maybeParseJsonObjectInput,
  parseJsonObjectInput,
  readFiniteNumber,
  readNonEmptyString,
} from "../shared.js";
import type {
  BenchmarkParser,
  CanonicalMetric,
  MetricDirection,
  ParsedRunPayload,
} from "../types.js";

interface CountMetricDefinition {
  sourceField: string;
  metricName: string;
  metricGroup: string;
  direction: MetricDirection;
  required: boolean;
}

interface DurationResult {
  valueMs: number;
  source: string;
}

const JEST_SOURCE_LABEL = "Jest";

const REQUIRED_COUNT_METRICS: CountMetricDefinition[] = [
  {
    sourceField: "numTotalTests",
    metricName: "tests_total",
    metricGroup: "tests",
    direction: "neutral",
    required: true,
  },
  {
    sourceField: "numPassedTests",
    metricName: "tests_passed",
    metricGroup: "tests",
    direction: "higher_is_better",
    required: true,
  },
  {
    sourceField: "numFailedTests",
    metricName: "tests_failed",
    metricGroup: "tests",
    direction: "lower_is_better",
    required: true,
  },
  {
    sourceField: "numTotalTestSuites",
    metricName: "test_suites_total",
    metricGroup: "tests",
    direction: "neutral",
    required: true,
  },
  {
    sourceField: "numPassedTestSuites",
    metricName: "test_suites_passed",
    metricGroup: "tests",
    direction: "higher_is_better",
    required: true,
  },
  {
    sourceField: "numFailedTestSuites",
    metricName: "test_suites_failed",
    metricGroup: "tests",
    direction: "lower_is_better",
    required: true,
  },
];

const OPTIONAL_COUNT_METRICS: CountMetricDefinition[] = [
  {
    sourceField: "numPendingTests",
    metricName: "tests_pending",
    metricGroup: "tests",
    direction: "neutral",
    required: false,
  },
  {
    sourceField: "numTodoTests",
    metricName: "tests_todo",
    metricGroup: "tests",
    direction: "neutral",
    required: false,
  },
  {
    sourceField: "numSkippedTests",
    metricName: "tests_skipped",
    metricGroup: "tests",
    direction: "neutral",
    required: false,
  },
  {
    sourceField: "numPendingTestSuites",
    metricName: "test_suites_pending",
    metricGroup: "tests",
    direction: "neutral",
    required: false,
  },
  {
    sourceField: "numRuntimeErrorTestSuites",
    metricName: "test_suites_runtime_error",
    metricGroup: "tests",
    direction: "lower_is_better",
    required: false,
  },
];

const ALL_COUNT_METRICS = [...REQUIRED_COUNT_METRICS, ...OPTIONAL_COUNT_METRICS];
const JEST_SIGNATURE_FIELDS = new Set([
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numTotalTestSuites",
  "numPassedTestSuites",
  "numFailedTestSuites",
  "testResults",
  "success",
  "wasInterrupted",
]);

export class JestParser implements BenchmarkParser {
  canParse(input: unknown, _filename?: string): boolean {
    const payload = maybeParseJsonObjectInput(input);

    if (payload === undefined) {
      return false;
    }

    const hasRequiredCounts = REQUIRED_COUNT_METRICS.every(
      (definition) => readFiniteNumber(payload[definition.sourceField]) !== undefined,
    );

    if (hasRequiredCounts) {
      return true;
    }

    return (
      Array.isArray(payload.testResults) &&
      Object.keys(payload).some((fieldName) => JEST_SIGNATURE_FIELDS.has(fieldName))
    );
  }

  parse(input: unknown, filename?: string): ParsedRunPayload {
    const payload = parseJsonObjectInput(input, JEST_SOURCE_LABEL);
    const metrics = parseMetrics(payload);
    const duration = requireDuration(payload);

    metrics.push(buildDurationMetric(duration));

    return {
      sourceType: "jest",
      suite: extractSuite(payload, filename),
      run: extractRun(payload, filename, duration),
      metrics,
    };
  }
}

function parseMetrics(payload: Record<string, unknown>): CanonicalMetric[] {
  return ALL_COUNT_METRICS.flatMap((definition) => {
    const value = payload[definition.sourceField];

    if (value === undefined && !definition.required) {
      return [];
    }

    return [buildCountMetric(definition, requireCount(value, definition.sourceField))];
  });
}

function buildCountMetric(
  definition: CountMetricDefinition,
  valueNumeric: number,
): CanonicalMetric {
  return {
    metricName: definition.metricName,
    metricGroup: definition.metricGroup,
    unit: "count",
    aggregationType: "count",
    valueNumeric,
    direction: definition.direction,
    metadata: {
      sourceField: definition.sourceField,
    },
  };
}

function buildDurationMetric(duration: DurationResult): CanonicalMetric {
  return {
    metricName: "duration_total",
    metricGroup: "duration",
    unit: "ms",
    aggregationType: "total",
    valueNumeric: duration.valueMs,
    direction: "lower_is_better",
    metadata: {
      source: duration.source,
    },
  };
}

function requireCount(value: unknown, sourceField: string): number {
  const numericValue = readFiniteNumber(value);

  if (
    numericValue === undefined ||
    !Number.isInteger(numericValue) ||
    numericValue < 0
  ) {
    throw invalidJest(`${sourceField} must be a non-negative integer`);
  }

  return numericValue;
}

function requireDuration(payload: Record<string, unknown>): DurationResult {
  const explicitDuration = readDurationFromExplicitFields(payload);

  if (explicitDuration !== undefined) {
    return explicitDuration;
  }

  const testResultsDuration = readDurationFromTestResults(payload);

  if (testResultsDuration !== undefined) {
    return testResultsDuration;
  }

  throw invalidJest("unable to determine total duration");
}

function readDurationFromExplicitFields(
  payload: Record<string, unknown>,
): DurationResult | undefined {
  const run = isRecord(payload.run) ? payload.run : undefined;
  const durationCandidates = [
    { value: readFiniteNumber(run?.durationMs), source: "run.durationMs" },
    { value: readFiniteNumber(payload.durationMs), source: "durationMs" },
    { value: readFiniteNumber(payload.duration), source: "duration" },
  ];
  const candidate = durationCandidates.find((item) => item.value !== undefined);

  if (candidate?.value === undefined) {
    return undefined;
  }

  validateDuration(candidate.value, candidate.source);

  return {
    valueMs: candidate.value,
    source: candidate.source,
  };
}

function readDurationFromTestResults(
  payload: Record<string, unknown>,
): DurationResult | undefined {
  const rootStartTime = readFiniteNumber(payload.startTime);
  const testResults = Array.isArray(payload.testResults) ? payload.testResults : undefined;

  if (testResults === undefined || testResults.length === 0) {
    return undefined;
  }

  const startTimes: number[] = [];
  const endTimes: number[] = [];
  const runtimes: number[] = [];

  for (const [index, rawResult] of testResults.entries()) {
    if (!isRecord(rawResult)) {
      throw invalidJest(`testResults[${index}] must be an object`);
    }

    collectFiniteNumber(rawResult.startTime, startTimes);
    collectFiniteNumber(rawResult.endTime, endTimes);

    if (isRecord(rawResult.perfStats)) {
      collectFiniteNumber(rawResult.perfStats.start, startTimes);
      collectFiniteNumber(rawResult.perfStats.end, endTimes);
      collectFiniteNumber(rawResult.perfStats.runtime, runtimes);
    }
  }

  if (rootStartTime !== undefined && endTimes.length > 0) {
    const durationMs = Math.max(...endTimes) - rootStartTime;
    validateDuration(durationMs, "testResults endTime - startTime");
    return {
      valueMs: durationMs,
      source: "testResults.endTime-startTime",
    };
  }

  if (startTimes.length > 0 && endTimes.length > 0) {
    const durationMs = Math.max(...endTimes) - Math.min(...startTimes);
    validateDuration(durationMs, "testResults endTime - testResults startTime");
    return {
      valueMs: durationMs,
      source: "testResults.endTime-testResults.startTime",
    };
  }

  if (runtimes.length > 0) {
    const durationMs = runtimes.reduce((sum, runtime) => sum + runtime, 0);
    validateDuration(durationMs, "testResults perfStats runtime");
    return {
      valueMs: durationMs,
      source: "testResults.perfStats.runtime",
    };
  }

  return undefined;
}

function collectFiniteNumber(value: unknown, target: number[]): void {
  const numericValue = readFiniteNumber(value);

  if (numericValue !== undefined) {
    target.push(numericValue);
  }
}

function validateDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw invalidJest(`${label} must be a non-negative duration in milliseconds`);
  }
}

function extractSuite(
  payload: Record<string, unknown>,
  filename?: string,
): ParsedRunPayload["suite"] {
  const suite = isRecord(payload.suite) ? payload.suite : undefined;
  const displayName = isRecord(payload.displayName) ? payload.displayName : undefined;
  const suiteName =
    readNonEmptyString(suite?.name) ??
    readNonEmptyString(payload.suiteName) ??
    readNonEmptyString(displayName?.name) ??
    filenameBase(filename) ??
    "jest-suite";
  const scenarioName =
    readNonEmptyString(suite?.scenarioName) ?? readNonEmptyString(payload.scenarioName);
  const tags = isRecord(suite?.tags)
    ? cloneSortedRecord(suite.tags)
    : isRecord(payload.tags)
      ? cloneSortedRecord(payload.tags)
      : undefined;
  const normalizedSuite: ParsedRunPayload["suite"] = { name: suiteName };

  if (scenarioName !== undefined) {
    normalizedSuite.scenarioName = scenarioName;
  }

  if (tags !== undefined) {
    normalizedSuite.tags = tags;
  }

  return normalizedSuite;
}

function extractRun(
  payload: Record<string, unknown>,
  filename: string | undefined,
  duration: DurationResult,
): ParsedRunPayload["run"] {
  const run = isRecord(payload.run) ? payload.run : undefined;
  const startTime = readFiniteNumber(payload.startTime);
  const metadata = compactRecord({
    sourceFilename: filename,
    jestTestResultCount: Array.isArray(payload.testResults) ? payload.testResults.length : undefined,
    success: typeof payload.success === "boolean" ? payload.success : undefined,
    wasInterrupted:
      typeof payload.wasInterrupted === "boolean" ? payload.wasInterrupted : undefined,
    durationSource: duration.source,
  });
  const normalizedRun: ParsedRunPayload["run"] = {};
  const label = readNonEmptyString(run?.label) ?? readNonEmptyString(payload.label);
  const commitSha = readNonEmptyString(run?.commitSha) ?? readNonEmptyString(payload.commitSha);
  const branchName =
    readNonEmptyString(run?.branchName) ??
    readNonEmptyString(run?.branch) ??
    readNonEmptyString(payload.branchName) ??
    readNonEmptyString(payload.branch);
  const environment =
    readNonEmptyString(run?.environment) ?? readNonEmptyString(payload.environment);
  const runAt =
    readNonEmptyString(run?.runAt) ??
    readNonEmptyString(payload.runAt) ??
    isoStringFromEpochMs(startTime);

  if (label !== undefined) {
    normalizedRun.label = label;
  }

  if (commitSha !== undefined) {
    normalizedRun.commitSha = commitSha;
  }

  if (branchName !== undefined) {
    normalizedRun.branchName = branchName;
  }

  if (environment !== undefined) {
    normalizedRun.environment = environment;
  }

  if (runAt !== undefined) {
    normalizedRun.runAt = runAt;
  }

  normalizedRun.durationMs = duration.valueMs;

  if (metadata !== undefined) {
    normalizedRun.metadata = metadata;
  }

  return normalizedRun;
}

function isoStringFromEpochMs(value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function invalidJest(reason: string): ParserValidationError {
  return new ParserValidationError(`Invalid Jest payload: ${reason}`, {
    sourceType: "jest",
    code: "INVALID_JEST_PAYLOAD",
  });
}
