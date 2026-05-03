import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ComparisonValidationError,
  compareCanonicalMetrics,
  compareRuns,
  metricIdentityKey,
} from "../dist/index.js";

test("compareCanonicalMetrics aligns exact comparable metrics by identity key, not array position", () => {
  const findings = compareCanonicalMetrics(
    [
      metric("http_reqs", "throughput", "rps", "rate", 100, "higher_is_better"),
      metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better"),
    ],
    [
      metric("http_req_duration", "latency", "ms", "p95", 360, "lower_is_better"),
      metric("http_reqs", "throughput", "rps", "rate", 110, "higher_is_better"),
    ],
  );

  assert.deepEqual(
    findings.map((finding) => `${finding.metricName}:${finding.aggregationType}:${finding.unit}`),
    ["http_req_duration:p95:ms", "http_reqs:rate:rps"],
  );
  assert.equal(findings[0].deltaAbsolute, 60);
  assert.equal(findings[0].deltaPercent, 20);
  assert.equal(findings[1].deltaAbsolute, 10);
  assert.equal(findings[1].deltaPercent, 10);
});

test("lower_is_better metrics regress when candidate value increases", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")],
    [metric("http_req_duration", "latency", "ms", "p95", 360, "lower_is_better")],
  );

  assert.equal(finding.status, "regressed");
  assert.equal(finding.severity, "none");
  assert.equal(finding.deltaAbsolute, 60);
  assert.equal(finding.deltaPercent, 20);
  assert.match(finding.reason, /increased by 20%/);
});

test("higher_is_better metrics regress when candidate value decreases", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_reqs", "throughput", "rps", "rate", 100, "higher_is_better")],
    [metric("http_reqs", "throughput", "rps", "rate", 92, "higher_is_better")],
  );

  assert.equal(finding.status, "regressed");
  assert.equal(finding.severity, "none");
  assert.equal(finding.deltaAbsolute, -8);
  assert.equal(finding.deltaPercent, -8);
  assert.match(finding.reason, /decreased by 8%/);
});

test("threshold rules suppress directional changes inside configured tolerance", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")],
    [metric("http_req_duration", "latency", "ms", "p95", 315, "lower_is_better")],
    {
      thresholdRules: [
        {
          metricName: "http_req_duration",
          aggregationType: "p95",
          warnAbovePercent: 10,
        },
      ],
    },
  );

  assert.equal(finding.status, "unchanged");
  assert.equal(finding.severity, "none");
  assert.equal(finding.deltaPercent, 5);
  assert.match(finding.reason, /within configured tolerance/);
});

test("one-sided threshold rules do not suppress changes on an unconfigured side", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")],
    [metric("http_req_duration", "latency", "ms", "p95", 270, "lower_is_better")],
    {
      thresholdRules: [
        {
          metricName: "http_req_duration",
          aggregationType: "p95",
          warnAbovePercent: 10,
        },
      ],
    },
  );

  assert.equal(finding.status, "improved");
  assert.equal(finding.severity, "none");
  assert.equal(finding.deltaPercent, -10);
  assert.match(finding.reason, /no threshold rule configured/);
});

test("threshold rules classify low, medium, and high severity deterministically", () => {
  const baseline = [metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")];
  const rule = {
    metricName: "http_req_duration",
    aggregationType: "p95",
    warnAbovePercent: 10,
    mediumAbovePercent: 20,
    highAbovePercent: 30,
  };

  const [low] = compareCanonicalMetrics(
    baseline,
    [metric("http_req_duration", "latency", "ms", "p95", 345, "lower_is_better")],
    { thresholdRules: [rule] },
  );
  const [medium] = compareCanonicalMetrics(
    baseline,
    [metric("http_req_duration", "latency", "ms", "p95", 375, "lower_is_better")],
    { thresholdRules: [rule] },
  );
  const [high] = compareCanonicalMetrics(
    baseline,
    [metric("http_req_duration", "latency", "ms", "p95", 405, "lower_is_better")],
    { thresholdRules: [rule] },
  );

  assert.equal(low.status, "regressed");
  assert.equal(low.severity, "low");
  assert.equal(medium.status, "regressed");
  assert.equal(medium.severity, "medium");
  assert.equal(high.status, "regressed");
  assert.equal(high.severity, "high");
  assert.match(high.reason, /exceeding the 30% regression threshold/);
});

test("below-threshold rules classify throughput drops", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("iterations", "throughput", "iterations_per_second", "rate", 100, "higher_is_better")],
    [metric("iterations", "throughput", "iterations_per_second", "rate", 91, "higher_is_better")],
    {
      thresholdRules: [
        {
          metricName: "iterations",
          aggregationType: "rate",
          warnBelowPercent: 5,
          highBelowPercent: 8,
        },
      ],
    },
  );

  assert.equal(finding.status, "regressed");
  assert.equal(finding.severity, "high");
  assert.equal(finding.deltaPercent, -9);
  assert.match(finding.reason, /exceeding the 8% regression threshold/);
});

test("baseline zero produces null percent delta and explicit reason", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("errors", "reliability", "count", "count", 0, "lower_is_better")],
    [metric("errors", "reliability", "count", "count", 5, "lower_is_better")],
    {
      thresholdRules: [
        {
          metricName: "errors",
          aggregationType: "count",
          warnAbovePercent: 10,
        },
      ],
    },
  );

  assert.equal(finding.status, "regressed");
  assert.equal(finding.severity, "none");
  assert.equal(finding.deltaAbsolute, 5);
  assert.equal(finding.deltaPercent, null);
  assert.match(finding.reason, /Baseline value is zero; percent delta not computed/);
});

test("missing metrics are emitted explicitly for baseline-only and candidate-only metrics", () => {
  const findings = compareCanonicalMetrics(
    [
      metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better"),
      metric("baseline_only", "custom", "count", "count", 1, "neutral"),
    ],
    [
      metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better"),
      metric("candidate_only", "custom", "count", "count", 1, "neutral"),
    ],
  );

  const baselineOnly = findings.find((finding) => finding.metricName === "baseline_only");
  const candidateOnly = findings.find((finding) => finding.metricName === "candidate_only");

  assert.equal(baselineOnly.status, "missing");
  assert.equal(baselineOnly.baselineValue, 1);
  assert.equal(baselineOnly.candidateValue, null);
  assert.equal(baselineOnly.reason, "Metric present in baseline but missing in candidate");
  assert.equal(candidateOnly.status, "missing");
  assert.equal(candidateOnly.baselineValue, null);
  assert.equal(candidateOnly.candidateValue, 1);
  assert.equal(candidateOnly.reason, "Metric introduced in candidate but absent in baseline");
});

test("missing metric severity can be configured with a matching threshold rule", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_req_failed", "reliability", "percent", "rate", 1, "lower_is_better")],
    [],
    {
      thresholdRules: [
        {
          metricName: "http_req_failed",
          aggregationType: "rate",
          missingSeverity: "high",
        },
      ],
    },
  );

  assert.equal(finding.status, "missing");
  assert.equal(finding.severity, "high");
});

test("exact threshold rules win over pattern rules", () => {
  const [finding] = compareCanonicalMetrics(
    [metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")],
    [metric("http_req_duration", "latency", "ms", "p95", 375, "lower_is_better")],
    {
      thresholdRules: [
        {
          metricNamePattern: "http_req_*",
          warnAbovePercent: 100,
        },
        {
          metricName: "http_req_duration",
          aggregationType: "p95",
          warnAbovePercent: 10,
          highAbovePercent: 20,
        },
      ],
    },
  );

  assert.equal(finding.status, "regressed");
  assert.equal(finding.severity, "high");
  assert.match(finding.reason, /exceeding the 20% regression threshold/);
});

test("neutral metrics remain unchanged unless the matching rule assigns directional status", () => {
  const [unchanged] = compareCanonicalMetrics(
    [metric("payload_size", "volume", "bytes", "avg", 1000, "neutral")],
    [metric("payload_size", "volume", "bytes", "avg", 1200, "neutral")],
    {
      thresholdRules: [
        {
          metricName: "payload_size",
          aggregationType: "avg",
          warnAbovePercent: 10,
        },
      ],
    },
  );
  const [regressed] = compareCanonicalMetrics(
    [metric("payload_size", "volume", "bytes", "avg", 1000, "neutral")],
    [metric("payload_size", "volume", "bytes", "avg", 1200, "neutral")],
    {
      thresholdRules: [
        {
          metricName: "payload_size",
          aggregationType: "avg",
          warnAbovePercent: 10,
          statusOnAbove: "regressed",
        },
      ],
    },
  );

  assert.equal(unchanged.status, "unchanged");
  assert.equal(unchanged.severity, "none");
  assert.equal(regressed.status, "regressed");
  assert.equal(regressed.severity, "low");
});

test("compareRuns returns run metadata and summary aggregates", () => {
  const result = compareRuns(
    {
      sourceType: "k6",
      suite: { name: "checkout-load-test", scenarioName: "steady_load" },
      run: { label: "baseline", branchName: "main" },
      metrics: [
        metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better"),
        metric("http_reqs", "throughput", "rps", "rate", 100, "higher_is_better"),
        metric("baseline_only", "custom", "count", "count", 1, "neutral"),
      ],
    },
    {
      sourceType: "k6",
      suite: { name: "checkout-load-test", scenarioName: "steady_load" },
      run: { label: "candidate", branchName: "feature/payment-refactor" },
      metrics: [
        metric("http_req_duration", "latency", "ms", "p95", 360, "lower_is_better"),
        metric("http_reqs", "throughput", "rps", "rate", 110, "higher_is_better"),
      ],
    },
    {
      thresholdRules: [
        {
          metricName: "http_req_duration",
          aggregationType: "p95",
          warnAbovePercent: 10,
          highAbovePercent: 15,
        },
      ],
    },
  );

  assert.deepEqual(result.baseline, {
    sourceType: "k6",
    suiteName: "checkout-load-test",
    scenarioName: "steady_load",
    label: "baseline",
    branchName: "main",
  });
  assert.deepEqual(result.candidate, {
    sourceType: "k6",
    suiteName: "checkout-load-test",
    scenarioName: "steady_load",
    label: "candidate",
    branchName: "feature/payment-refactor",
  });
  assert.deepEqual(result.summary, {
    totalMetrics: 3,
    comparedMetrics: 2,
    regressions: 1,
    improvements: 1,
    unchanged: 0,
    missing: 1,
    highSeverityRegressions: 1,
  });
});

test("metricIdentityKey uses metric name, aggregation type, and unit", () => {
  assert.equal(
    metricIdentityKey(metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better")),
    "http_req_duration::p95::ms",
  );
});

test("duplicate metric identities fail fast", () => {
  assert.throws(
    () =>
      compareCanonicalMetrics(
        [
          metric("http_reqs", "throughput", "rps", "rate", 100, "higher_is_better"),
          metric("http_reqs", "throughput", "rps", "rate", 101, "higher_is_better"),
        ],
        [],
      ),
    (error) =>
      error instanceof ComparisonValidationError &&
      error.message === 'Duplicate baseline metric identity "http_reqs::rate::rps"',
  );
});

function metric(metricName, metricGroup, unit, aggregationType, valueNumeric, direction) {
  return {
    metricName,
    metricGroup,
    unit,
    aggregationType,
    valueNumeric,
    direction,
  };
}
