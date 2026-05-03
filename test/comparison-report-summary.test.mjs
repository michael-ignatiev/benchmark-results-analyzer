import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareRuns,
  generateComparisonReportSummary,
  summarizeFindings,
} from "../dist/index.js";

test("generateComparisonReportSummary highlights regressions, improvements, critical unchanged metrics, and important missing metrics", () => {
  const findings = [
    finding("http_req_duration", "latency", "ms", "p95", 300, 390, 90, 30, "regressed", "high"),
    finding("http_req_failed", "reliability", "percent", "rate", 1.2, 1.2, 0, 0, "unchanged", "none"),
    finding("http_reqs", "throughput", "rps", "rate", 100, 112, 12, 12, "improved", "none"),
    finding("tests_failed", "tests", "count", "count", 0, null, null, null, "missing", "high"),
    finding("data_sent", "volume", "bytes", "count", 2048, null, null, null, "missing", "none"),
  ];

  assert.equal(
    generateComparisonReportSummary({
      summary: summarizeFindings(findings),
      findings,
    }),
    "Compared 5 metrics: 1 regression, 1 improvement, 1 unchanged, 2 missing metrics, including 1 high-severity regression. Regressions: http_req_duration p95 regressed (300 ms -> 390 ms, +30%, high). Improvements: http_reqs rate improved (100 rps -> 112 rps, +12%). Unchanged critical metrics: http_req_failed rate stayed at 1.2%. Important missing metrics: tests_failed count missing from candidate; baseline was 0, high.",
  );
});

test("generateComparisonReportSummary orders findings deterministically by impact and caps sections", () => {
  const findings = [
    finding("latency_p95", "latency", "ms", "p95", 300, 360, 60, 20, "regressed", "medium"),
    finding("latency_p99", "latency", "ms", "p99", 500, 700, 200, 40, "regressed", "high"),
    finding("http_req_failed", "reliability", "percent", "rate", 0.1, 0.1, 0, 0, "unchanged", "none"),
  ];

  assert.equal(
    generateComparisonReportSummary(
      {
        summary: summarizeFindings(findings),
        findings,
      },
      {
        maxFindingsPerSection: 1,
      },
    ),
    "Compared 3 metrics: 2 regressions, 0 improvements, 1 unchanged, 0 missing metrics, including 1 high-severity regression. Regressions: latency_p99 p99 regressed (500 ms -> 700 ms, +40%, high); and 1 more. Unchanged critical metrics: http_req_failed rate stayed at 0.1%.",
  );
});

test("generateComparisonReportSummary reports unchanged critical metrics within tolerance", () => {
  const findings = [
    finding("http_req_duration", "latency", "ms", "p95", 300, 315, 15, 5, "unchanged", "none"),
  ];

  assert.equal(
    generateComparisonReportSummary({
      summary: summarizeFindings(findings),
      findings,
    }),
    "Compared 1 metric: 0 regressions, 0 improvements, 1 unchanged, 0 missing metrics. Unchanged critical metrics: http_req_duration p95 remained within tolerance (300 ms -> 315 ms, +5%).",
  );
});

test("generateComparisonReportSummary stays concise when there are no regressions or important missing metrics", () => {
  const findings = [
    finding("payload_size", "volume", "bytes", "avg", 1000, 1000, 0, 0, "unchanged", "none"),
    finding("data_sent", "volume", "bytes", "count", 2048, null, null, null, "missing", "none"),
  ];

  assert.equal(
    generateComparisonReportSummary({
      summary: summarizeFindings(findings),
      findings,
    }),
    "Compared 2 metrics: 0 regressions, 0 improvements, 1 unchanged, 1 missing metric.",
  );
});

test("compareRuns includes the deterministic report summary", () => {
  const result = compareRuns(
    {
      metrics: [
        metric("http_req_duration", "latency", "ms", "p95", 300, "lower_is_better"),
        metric("http_reqs", "throughput", "rps", "rate", 100, "higher_is_better"),
      ],
    },
    {
      metrics: [
        metric("http_req_duration", "latency", "ms", "p95", 360, "lower_is_better"),
        metric("http_reqs", "throughput", "rps", "rate", 110, "higher_is_better"),
      ],
    },
  );

  assert.equal(
    result.reportSummary,
    "Compared 2 metrics: 1 regression, 1 improvement, 0 unchanged, 0 missing metrics. Regressions: http_req_duration p95 regressed (300 ms -> 360 ms, +20%). Improvements: http_reqs rate improved (100 rps -> 110 rps, +10%).",
  );
});

function finding(
  metricName,
  metricGroup,
  unit,
  aggregationType,
  baselineValue,
  candidateValue,
  deltaAbsolute,
  deltaPercent,
  status,
  severity,
) {
  return {
    metricName,
    metricGroup,
    unit,
    aggregationType,
    baselineValue,
    candidateValue,
    deltaAbsolute,
    deltaPercent,
    status,
    severity,
    reason: `${metricName} ${status}`,
  };
}

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
