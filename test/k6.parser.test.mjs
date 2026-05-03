import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  K6Parser,
  ParserValidationError,
  createDefaultParserRegistry,
} from "../dist/index.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/k6-summary.json", import.meta.url), "utf8"),
);

test("K6Parser canParse conservatively identifies k6 summary payloads", () => {
  const parser = new K6Parser();

  assert.equal(parser.canParse(fixture, "k6-summary.json"), true);
  assert.equal(parser.canParse(JSON.stringify(fixture), "k6-summary.json"), true);
  assert.equal(parser.canParse({ metrics: { custom: { values: { count: 1 } } } }), false);
  assert.equal(parser.canParse({ metrics: [] }), false);
});

test("K6Parser normalizes a k6 summary export into the canonical run payload", () => {
  const parser = new K6Parser();
  const parsed = parser.parse(fixture, "k6-summary.json");

  assert.equal(parsed.sourceType, "k6");
  assert.deepEqual(parsed.suite, {
    name: "checkout-load-test",
    scenarioName: "steady_load",
    tags: {
      component: "billing",
      team: "payments",
    },
  });
  assert.deepEqual(parsed.run, {
    label: "main-baseline",
    commitSha: "abc1234",
    branchName: "main",
    environment: "staging",
    runAt: "2026-04-02T12:00:00Z",
    durationMs: 60000,
    metadata: {
      sourceFilename: "k6-summary.json",
      k6MetricCount: 8,
      summaryTrendStats: ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)"],
    },
  });
  assert.equal(parsed.metrics.length, 20);

  assertCanonicalMetric(metric(parsed, "http_req_duration", "p95"), {
    metricName: "http_req_duration",
    metricGroup: "latency",
    unit: "ms",
    aggregationType: "p95",
    valueNumeric: 512.5,
    direction: "lower_is_better",
  });
  assert.deepEqual(metric(parsed, "http_req_duration", "p95").metadata, {
    sourceMetricType: "trend",
    sourceContains: "time",
    sourceValueKey: "p(95)",
    thresholds: {
      "p(95)<600": {
        ok: true,
      },
    },
  });

  assertCanonicalMetric(metric(parsed, "http_req_failed", "rate"), {
    metricName: "http_req_failed",
    metricGroup: "reliability",
    unit: "percent",
    aggregationType: "rate",
    valueNumeric: 1.2,
    direction: "lower_is_better",
  });

  assertCanonicalMetric(metric(parsed, "http_reqs", "rate"), {
    metricName: "http_reqs",
    metricGroup: "throughput",
    unit: "rps",
    aggregationType: "rate",
    valueNumeric: 25,
    direction: "higher_is_better",
  });
});

test("K6Parser tolerates missing optional suite and run metadata", () => {
  const parser = new K6Parser();
  const parsed = parser.parse({
    metrics: {
      iterations: {
        type: "counter",
        contains: "default",
        values: {
          count: 5,
        },
      },
    },
  });

  assert.deepEqual(parsed.suite, { name: "k6-suite" });
  assert.deepEqual(parsed.run, {
    metadata: {
      k6MetricCount: 1,
    },
  });
  assertCanonicalMetric(parsed.metrics[0], {
    metricName: "iterations",
    metricGroup: "volume",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 5,
    direction: "neutral",
  });
});

test("K6Parser normalizes units, aggregations, and directions for representative k6 metrics", () => {
  const parser = new K6Parser();
  const parsed = parser.parse(fixture);

  assertCanonicalMetric(metric(parsed, "http_req_duration", "median"), {
    metricName: "http_req_duration",
    metricGroup: "latency",
    unit: "ms",
    aggregationType: "median",
    valueNumeric: 200,
    direction: "lower_is_better",
  });
  assertCanonicalMetric(metric(parsed, "checks", "rate"), {
    metricName: "checks",
    metricGroup: "reliability",
    unit: "percent",
    aggregationType: "rate",
    valueNumeric: 99.8,
    direction: "higher_is_better",
  });
  assertCanonicalMetric(metric(parsed, "iterations", "rate"), {
    metricName: "iterations",
    metricGroup: "throughput",
    unit: "iterations_per_second",
    aggregationType: "rate",
    valueNumeric: 6.25,
    direction: "higher_is_better",
  });
  assertCanonicalMetric(metric(parsed, "data_received", "count"), {
    metricName: "data_received",
    metricGroup: "volume",
    unit: "bytes",
    aggregationType: "count",
    valueNumeric: 1048576,
    direction: "neutral",
  });
  assertCanonicalMetric(metric(parsed, "vus", "max"), {
    metricName: "vus",
    metricGroup: "concurrency",
    unit: "count",
    aggregationType: "max",
    valueNumeric: 8,
    direction: "neutral",
  });
});

test("K6Parser throws a clear validation error for malformed payload shape", () => {
  const parser = new K6Parser();

  assert.throws(
    () => parser.parse({ options: {} }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message === "Invalid k6 payload: missing metrics object",
  );
});

test("K6Parser throws a clear validation error for invalid metric values", () => {
  const parser = new K6Parser();

  assert.throws(
    () =>
      parser.parse({
        metrics: {
          http_req_duration: {
            type: "trend",
            contains: "time",
            values: {
              avg: "fast",
            },
          },
        },
      }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message ===
        'Invalid k6 payload: metric "http_req_duration" value "avg" must be a finite number',
  );

  assert.throws(
    () =>
      parser.parse({
        metrics: {
          http_req_failed: {
            type: "rate",
            contains: "default",
            values: {
              rate: 1.5,
            },
          },
        },
      }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message === 'Invalid k6 payload: metric "http_req_failed" value "rate" must be between 0 and 1',
  );
});

test("default parser registry resolves k6 payloads", () => {
  const registry = createDefaultParserRegistry();

  assert.equal(registry.parse(fixture).sourceType, "k6");
});

function metric(parsed, metricName, aggregationType) {
  const found = parsed.metrics.find(
    (candidate) =>
      candidate.metricName === metricName && candidate.aggregationType === aggregationType,
  );

  assert.ok(found, `Expected ${metricName}:${aggregationType} to be present`);
  return found;
}

function assertCanonicalMetric(actual, expected) {
  const { metadata: _metadata, ...actualWithoutMetadata } = actual;
  assert.deepEqual(actualWithoutMetadata, expected);
}
