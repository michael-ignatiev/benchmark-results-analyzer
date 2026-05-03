import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  JestParser,
  ParserValidationError,
  createDefaultParserRegistry,
} from "../dist/index.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/jest-results.json", import.meta.url), "utf8"),
);

test("JestParser canParse conservatively identifies Jest JSON output", () => {
  const parser = new JestParser();

  assert.equal(parser.canParse(fixture, "jest-results.json"), true);
  assert.equal(parser.canParse(JSON.stringify(fixture), "jest-results.json"), true);
  assert.equal(parser.canParse({ numTotalTests: 1 }), false);
  assert.equal(parser.canParse({ metrics: { tests_total: { values: { count: 1 } } } }), false);
});

test("JestParser normalizes Jest JSON output into the canonical run payload", () => {
  const parser = new JestParser();
  const parsed = parser.parse(fixture, "jest-results.json");

  assert.equal(parsed.sourceType, "jest");
  assert.deepEqual(parsed.suite, {
    name: "checkout-unit-tests",
    scenarioName: "ci",
    tags: {
      package: "benchmark-results-analyzer",
      runner: "jest",
    },
  });
  assert.deepEqual(parsed.run, {
    label: "main-unit-tests",
    commitSha: "def5678",
    branchName: "main",
    environment: "ci",
    runAt: "2026-04-29T10:00:00.000Z",
    durationMs: 6421,
    metadata: {
      sourceFilename: "jest-results.json",
      jestTestResultCount: 2,
      success: false,
      wasInterrupted: false,
      durationSource: "testResults.endTime-startTime",
    },
  });
  assert.equal(parsed.metrics.length, 11);

  assertCanonicalMetric(metric(parsed, "tests_total", "count"), {
    metricName: "tests_total",
    metricGroup: "tests",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 14,
    direction: "neutral",
  });
  assertCanonicalMetric(metric(parsed, "tests_passed", "count"), {
    metricName: "tests_passed",
    metricGroup: "tests",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 10,
    direction: "higher_is_better",
  });
  assertCanonicalMetric(metric(parsed, "tests_failed", "count"), {
    metricName: "tests_failed",
    metricGroup: "tests",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 2,
    direction: "lower_is_better",
  });
  assertCanonicalMetric(metric(parsed, "test_suites_total", "count"), {
    metricName: "test_suites_total",
    metricGroup: "tests",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 5,
    direction: "neutral",
  });
  assertCanonicalMetric(metric(parsed, "test_suites_failed", "count"), {
    metricName: "test_suites_failed",
    metricGroup: "tests",
    unit: "count",
    aggregationType: "count",
    valueNumeric: 1,
    direction: "lower_is_better",
  });
  assertCanonicalMetric(metric(parsed, "duration_total", "total"), {
    metricName: "duration_total",
    metricGroup: "duration",
    unit: "ms",
    aggregationType: "total",
    valueNumeric: 6421,
    direction: "lower_is_better",
  });
});

test("JestParser tolerates missing optional suite and run metadata", () => {
  const parser = new JestParser();
  const parsed = parser.parse({
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 1,
    numPassedTests: 3,
    numTotalTestSuites: 1,
    numTotalTests: 3,
    durationMs: 1234,
  });

  assert.deepEqual(parsed.suite, { name: "jest-suite" });
  assert.deepEqual(parsed.run, {
    durationMs: 1234,
    metadata: {
      durationSource: "durationMs",
    },
  });
  assert.equal(parsed.metrics.length, 7);
  assertCanonicalMetric(metric(parsed, "duration_total", "total"), {
    metricName: "duration_total",
    metricGroup: "duration",
    unit: "ms",
    aggregationType: "total",
    valueNumeric: 1234,
    direction: "lower_is_better",
  });
});

test("JestParser derives duration from perfStats when start and end times are absent", () => {
  const parser = new JestParser();
  const parsed = parser.parse({
    numFailedTestSuites: 0,
    numFailedTests: 0,
    numPassedTestSuites: 2,
    numPassedTests: 5,
    numTotalTestSuites: 2,
    numTotalTests: 5,
    testResults: [
      {
        perfStats: {
          runtime: 200,
        },
      },
      {
        perfStats: {
          runtime: 350,
        },
      },
    ],
  });

  assertCanonicalMetric(metric(parsed, "duration_total", "total"), {
    metricName: "duration_total",
    metricGroup: "duration",
    unit: "ms",
    aggregationType: "total",
    valueNumeric: 550,
    direction: "lower_is_better",
  });
});

test("JestParser throws a clear validation error for malformed payload shape", () => {
  const parser = new JestParser();

  assert.throws(
    () => parser.parse({}),
    (error) =>
      error instanceof ParserValidationError &&
      error.message === "Invalid Jest payload: numTotalTests must be a non-negative integer",
  );
});

test("JestParser throws a clear validation error for invalid metric values", () => {
  const parser = new JestParser();

  assert.throws(
    () =>
      parser.parse({
        numFailedTestSuites: 0,
        numFailedTests: 0,
        numPassedTestSuites: 1,
        numPassedTests: 3,
        numTotalTestSuites: 1,
        numTotalTests: "3",
        durationMs: 1000,
      }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message === "Invalid Jest payload: numTotalTests must be a non-negative integer",
  );

  assert.throws(
    () =>
      parser.parse({
        numFailedTestSuites: 0,
        numFailedTests: 0,
        numPassedTestSuites: 1,
        numPassedTests: 3,
        numTotalTestSuites: 1,
        numTotalTests: 3,
        startTime: 5000,
        testResults: [
          {
            endTime: 4000,
          },
        ],
      }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message ===
        "Invalid Jest payload: testResults endTime - startTime must be a non-negative duration in milliseconds",
  );
});

test("default parser registry resolves Jest payloads", () => {
  const registry = createDefaultParserRegistry();

  assert.equal(registry.parse(fixture).sourceType, "jest");
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
