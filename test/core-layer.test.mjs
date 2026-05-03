import assert from "node:assert/strict";
import { test } from "node:test";

import {
  K6Parser,
  SOURCE_TYPES,
  compareCanonicalMetrics,
  evaluateThresholdRule,
  generateComparisonReportSummary,
} from "../dist/core/index.js";

test("core layer exposes reusable parser, metric, comparison, and report APIs", () => {
  assert.deepEqual(SOURCE_TYPES, ["k6", "jest"]);
  assert.equal(typeof K6Parser, "function");
  assert.equal(typeof compareCanonicalMetrics, "function");
  assert.equal(evaluateThresholdRule(15, { metricName: "latency", warnAbovePercent: 10 }).severity, "low");
  assert.equal(typeof generateComparisonReportSummary, "function");
});
