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
  sortedEntries,
} from "../shared.js";
import type {
  BenchmarkParser,
  CanonicalMetric,
  MetricDirection,
  ParsedRunPayload,
} from "../types.js";

type K6MetricType = "counter" | "gauge" | "rate" | "trend";

interface MetricDescriptor {
  sourceValueKey: string;
  metricGroup: string;
  unit: string;
  aggregationType: string;
  direction: MetricDirection;
  transform?: (value: number) => number;
}

const K6_SOURCE_LABEL = "k6";

const K6_METRIC_TYPES = new Set<string>(["counter", "gauge", "rate", "trend"]);

const K6_SIGNATURE_METRICS = new Set<string>([
  "checks",
  "data_received",
  "data_sent",
  "dropped_iterations",
  "http_req_blocked",
  "http_req_connecting",
  "http_req_duration",
  "http_req_failed",
  "http_req_receiving",
  "http_req_sending",
  "http_req_tls_handshaking",
  "http_req_waiting",
  "http_reqs",
  "iteration_duration",
  "iterations",
  "vus",
  "vus_max",
]);

const LATENCY_METRICS = new Set<string>([
  "http_req_blocked",
  "http_req_connecting",
  "http_req_duration",
  "http_req_receiving",
  "http_req_sending",
  "http_req_tls_handshaking",
  "http_req_waiting",
]);

const TREND_AGGREGATION_ORDER = new Map<string, number>([
  ["avg", 0],
  ["min", 1],
  ["median", 2],
  ["max", 3],
  ["p50", 4],
  ["p75", 5],
  ["p90", 6],
  ["p95", 7],
  ["p99", 8],
]);

const GAUGE_AGGREGATIONS = ["value", "min", "max"] as const;
const COUNTER_AGGREGATIONS = ["count", "rate"] as const;

export class K6Parser implements BenchmarkParser {
  canParse(input: unknown, _filename?: string): boolean {
    const payload = maybeParseJsonObjectInput(input);

    if (payload === undefined || !isRecord(payload.metrics)) {
      return false;
    }

    return sortedEntries(payload.metrics).some(([metricName, rawMetric]) => {
      return K6_SIGNATURE_METRICS.has(metricName) || looksLikeK6Metric(rawMetric);
    });
  }

  parse(input: unknown, filename?: string): ParsedRunPayload {
    const payload = parseJsonObjectInput(input, K6_SOURCE_LABEL);
    const rawMetrics = payload.metrics;

    if (!isRecord(rawMetrics)) {
      throw invalidK6("missing metrics object");
    }

    const metrics = this.parseMetrics(rawMetrics);

    if (metrics.length === 0) {
      throw invalidK6("no supported k6 metrics found");
    }

    return {
      sourceType: "k6",
      suite: extractSuite(payload, filename),
      run: extractRun(payload, filename, rawMetrics),
      metrics,
    };
  }

  private parseMetrics(rawMetrics: Record<string, unknown>): CanonicalMetric[] {
    const canonicalMetrics: CanonicalMetric[] = [];

    for (const [metricName, rawMetric] of sortedEntries(rawMetrics)) {
      if (!isRecord(rawMetric)) {
        throw invalidK6(`metric "${metricName}" must be an object`);
      }

      const values = rawMetric.values;

      if (!isRecord(values)) {
        throw invalidK6(`metric "${metricName}" missing values object`);
      }

      const metricType = readMetricType(rawMetric.type, metricName);
      const contains = readNonEmptyString(rawMetric.contains);
      const descriptors = buildDescriptors(metricName, metricType, contains, values);

      if (descriptors.length === 0) {
        continue;
      }

      const commonMetadata = compactRecord({
        sourceMetricType: metricType,
        sourceContains: contains,
        thresholds: normalizeThresholds(rawMetric.thresholds),
      });

      for (const descriptor of descriptors) {
        const rawValue = values[descriptor.sourceValueKey];
        const numericValue = requireFiniteMetricValue(
          metricName,
          descriptor.sourceValueKey,
          rawValue,
        );
        const transformedValue = descriptor.transform
          ? descriptor.transform(numericValue)
          : numericValue;
        const metadata = compactRecord({
          ...commonMetadata,
          sourceValueKey: descriptor.sourceValueKey,
        });
        const metric: CanonicalMetric = {
          metricName,
          metricGroup: descriptor.metricGroup,
          unit: descriptor.unit,
          aggregationType: descriptor.aggregationType,
          valueNumeric: transformedValue,
          direction: descriptor.direction,
        };

        if (metadata !== undefined) {
          metric.metadata = metadata;
        }

        canonicalMetrics.push(metric);
      }
    }

    return canonicalMetrics;
  }
}

function buildDescriptors(
  metricName: string,
  metricType: K6MetricType,
  contains: string | undefined,
  values: Record<string, unknown>,
): MetricDescriptor[] {
  switch (metricType) {
    case "trend":
      return buildTrendDescriptors(metricName, contains, values);
    case "rate":
      return buildRateDescriptors(metricName, values);
    case "counter":
      return buildCounterDescriptors(metricName, contains, values);
    case "gauge":
      return buildGaugeDescriptors(metricName, values);
  }
}

function buildTrendDescriptors(
  metricName: string,
  contains: string | undefined,
  values: Record<string, unknown>,
): MetricDescriptor[] {
  const metricGroup = metricGroupFor(metricName, "trend", contains);
  const unit = trendUnitFor(metricName, contains);
  const direction = directionFor(metricName, metricGroup, "trend");
  const descriptors = sortedEntries(values)
    .map(([sourceValueKey]) => {
      const aggregationType = normalizeTrendAggregation(sourceValueKey);

      if (aggregationType === undefined) {
        return undefined;
      }

      return {
        sourceValueKey,
        metricGroup,
        unit,
        aggregationType,
        direction,
      } satisfies MetricDescriptor;
    })
    .filter((descriptor): descriptor is MetricDescriptor => descriptor !== undefined);

  return descriptors.sort((left, right) => {
    const leftOrder = TREND_AGGREGATION_ORDER.get(left.aggregationType) ?? 100;
    const rightOrder = TREND_AGGREGATION_ORDER.get(right.aggregationType) ?? 100;
    return leftOrder - rightOrder || left.aggregationType.localeCompare(right.aggregationType);
  });
}

function buildRateDescriptors(
  metricName: string,
  values: Record<string, unknown>,
): MetricDescriptor[] {
  if (!Object.hasOwn(values, "rate")) {
    return [];
  }

  const metricGroup = metricGroupFor(metricName, "rate", undefined);

  return [
    {
      sourceValueKey: "rate",
      metricGroup,
      unit: "percent",
      aggregationType: "rate",
      direction: directionFor(metricName, metricGroup, "rate"),
      transform: (value) => {
        if (value < 0 || value > 1) {
          throw invalidK6(`metric "${metricName}" value "rate" must be between 0 and 1`);
        }

        return value * 100;
      },
    },
  ];
}

function buildCounterDescriptors(
  metricName: string,
  contains: string | undefined,
  values: Record<string, unknown>,
): MetricDescriptor[] {
  const descriptors: MetricDescriptor[] = [];

  for (const aggregationType of COUNTER_AGGREGATIONS) {
    if (!Object.hasOwn(values, aggregationType)) {
      continue;
    }

    const { metricGroup, unit, direction } = counterMetadataFor(
      metricName,
      contains,
      aggregationType,
    );

    descriptors.push({
      sourceValueKey: aggregationType,
      metricGroup,
      unit,
      aggregationType,
      direction,
    });
  }

  return descriptors;
}

function buildGaugeDescriptors(
  metricName: string,
  values: Record<string, unknown>,
): MetricDescriptor[] {
  const metricGroup = metricGroupFor(metricName, "gauge", undefined);

  return GAUGE_AGGREGATIONS.flatMap((aggregationType) => {
    if (!Object.hasOwn(values, aggregationType)) {
      return [];
    }

    return [
      {
        sourceValueKey: aggregationType,
        metricGroup,
        unit: "count",
        aggregationType,
        direction: "neutral",
      } satisfies MetricDescriptor,
    ];
  });
}

function normalizeTrendAggregation(sourceValueKey: string): string | undefined {
  if (sourceValueKey === "avg" || sourceValueKey === "min" || sourceValueKey === "max") {
    return sourceValueKey;
  }

  if (sourceValueKey === "med") {
    return "median";
  }

  const percentileMatch = /^p\((\d+(?:\.\d+)?)\)$/.exec(sourceValueKey);

  if (percentileMatch?.[1] !== undefined) {
    return `p${percentileMatch[1].replace(".", "_")}`;
  }

  return undefined;
}

function metricGroupFor(
  metricName: string,
  metricType: K6MetricType,
  contains: string | undefined,
): string {
  if (
    LATENCY_METRICS.has(metricName) ||
    (contains === "time" && metricName !== "iteration_duration")
  ) {
    return "latency";
  }

  if (metricName === "iteration_duration") {
    return "duration";
  }

  if (metricName === "http_req_failed" || metricName === "checks" || isFailureMetric(metricName)) {
    return "reliability";
  }

  if (metricName === "http_reqs") {
    return "throughput";
  }

  if (metricName === "vus" || metricName === "vus_max") {
    return "concurrency";
  }

  if (contains === "data" || metricName === "data_received" || metricName === "data_sent") {
    return "volume";
  }

  if (metricName === "iterations" || metricName === "dropped_iterations") {
    return "volume";
  }

  if (metricType === "counter") {
    return "volume";
  }

  return "custom";
}

function trendUnitFor(metricName: string, contains: string | undefined): string {
  if (contains === "time" || LATENCY_METRICS.has(metricName) || metricName.endsWith("_duration")) {
    return "ms";
  }

  if (contains === "data" || metricName.startsWith("data_")) {
    return "bytes";
  }

  return "count";
}

function counterMetadataFor(
  metricName: string,
  contains: string | undefined,
  aggregationType: "count" | "rate",
): Pick<MetricDescriptor, "metricGroup" | "unit" | "direction"> {
  if (contains === "data" || metricName === "data_received" || metricName === "data_sent") {
    return {
      metricGroup: aggregationType === "rate" ? "throughput" : "volume",
      unit: aggregationType === "rate" ? "bytes_per_second" : "bytes",
      direction: "neutral",
    };
  }

  if (metricName === "http_reqs" && aggregationType === "rate") {
    return {
      metricGroup: "throughput",
      unit: "rps",
      direction: "higher_is_better",
    };
  }

  if (metricName === "iterations" && aggregationType === "rate") {
    return {
      metricGroup: "throughput",
      unit: "iterations_per_second",
      direction: "higher_is_better",
    };
  }

  const metricGroup = metricGroupFor(metricName, "counter", contains);

  return {
    metricGroup,
    unit: "count",
    direction: directionFor(metricName, metricGroup, aggregationType),
  };
}

function directionFor(
  metricName: string,
  metricGroup: string,
  aggregationType: string,
): MetricDirection {
  if (metricGroup === "latency" || metricGroup === "duration") {
    return "lower_is_better";
  }

  if (metricName === "http_req_failed" || isFailureMetric(metricName)) {
    return "lower_is_better";
  }

  if (metricName === "checks" && aggregationType === "rate") {
    return "higher_is_better";
  }

  if (metricGroup === "throughput") {
    return "higher_is_better";
  }

  return "neutral";
}

function isFailureMetric(metricName: string): boolean {
  return /(?:^|_)(fail(?:ed|ure|s)?|error(?:s)?|dropped)(?:_|$)/.test(metricName);
}

function readMetricType(value: unknown, metricName: string): K6MetricType {
  if (typeof value !== "string" || !K6_METRIC_TYPES.has(value)) {
    throw invalidK6(`metric "${metricName}" type must be one of counter, gauge, rate, trend`);
  }

  return value as K6MetricType;
}

function requireFiniteMetricValue(metricName: string, valueKey: string, value: unknown): number {
  const numericValue = readFiniteNumber(value);

  if (numericValue === undefined) {
    throw invalidK6(`metric "${metricName}" value "${valueKey}" must be a finite number`);
  }

  return numericValue;
}

function extractSuite(payload: Record<string, unknown>, filename?: string): ParsedRunPayload["suite"] {
  const suite = isRecord(payload.suite) ? payload.suite : undefined;
  const rootGroup = isRecord(payload.root_group) ? payload.root_group : undefined;
  const suiteName =
    readNonEmptyString(suite?.name) ??
    readNonEmptyString(payload.suiteName) ??
    readNonEmptyString(rootGroup?.name) ??
    filenameBase(filename) ??
    "k6-suite";
  const scenarioName =
    readNonEmptyString(suite?.scenarioName) ??
    readNonEmptyString(payload.scenarioName) ??
    extractSingleScenarioName(payload);
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
  rawMetrics: Record<string, unknown>,
): ParsedRunPayload["run"] {
  const run = isRecord(payload.run) ? payload.run : undefined;
  const state = isRecord(payload.state) ? payload.state : undefined;
  const options = isRecord(payload.options) ? payload.options : undefined;
  const durationMs =
    readFiniteNumber(run?.durationMs) ??
    readFiniteNumber(payload.durationMs) ??
    readFiniteNumber(state?.testRunDurationMs);
  const runMetadata = compactRecord({
    sourceFilename: filename,
    k6MetricCount: Object.keys(rawMetrics).length,
    summaryTrendStats: Array.isArray(options?.summaryTrendStats)
      ? [...options.summaryTrendStats]
      : undefined,
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
  const runAt = readNonEmptyString(run?.runAt) ?? readNonEmptyString(payload.runAt);

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

  if (durationMs !== undefined) {
    normalizedRun.durationMs = durationMs;
  }

  if (runMetadata !== undefined) {
    normalizedRun.metadata = runMetadata;
  }

  return normalizedRun;
}

function extractSingleScenarioName(payload: Record<string, unknown>): string | undefined {
  const options = isRecord(payload.options) ? payload.options : undefined;
  const scenarios = isRecord(options?.scenarios) ? options.scenarios : undefined;

  if (scenarios === undefined) {
    return undefined;
  }

  const scenarioNames = Object.keys(scenarios);
  return scenarioNames.length === 1 ? scenarioNames[0] : undefined;
}

function normalizeThresholds(rawThresholds: unknown): Record<string, unknown> | undefined {
  if (!isRecord(rawThresholds)) {
    return undefined;
  }

  return cloneSortedRecord(rawThresholds);
}

function looksLikeK6Metric(rawMetric: unknown): boolean {
  if (!isRecord(rawMetric) || !isRecord(rawMetric.values)) {
    return false;
  }

  return typeof rawMetric.type === "string" && K6_METRIC_TYPES.has(rawMetric.type);
}

function invalidK6(reason: string): ParserValidationError {
  return new ParserValidationError(`Invalid k6 payload: ${reason}`, {
    sourceType: "k6",
    code: "INVALID_K6_PAYLOAD",
  });
}
