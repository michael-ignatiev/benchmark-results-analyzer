import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { test } from "node:test";

import { createDefaultParserRegistry } from "../dist/index.js";

const fixturesRoot = new URL("../demo/fixtures/", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("manifest.json", fixturesRoot), "utf8"),
);

test("demo dataset manifest references parseable benchmark fixtures", async () => {
  const registry = createDefaultParserRegistry();
  const runKeys = new Set();
  const parsedByKey = new Map();

  assert.equal(manifest.project.name, "Acme Commerce Demo");
  assert.ok(Array.isArray(manifest.runs));
  assert.ok(manifest.runs.length >= 6);

  for (const run of manifest.runs) {
    assert.match(run.key, /^[a-z0-9-]+$/);
    assert.equal(runKeys.has(run.key), false, `Duplicate run key ${run.key}`);
    runKeys.add(run.key);

    const fixtureUrl = new URL(run.file, fixturesRoot);
    const content = await readFile(fixtureUrl, "utf8");
    const parsed = registry.parse(content, basename(run.file));

    assert.equal(parsed.sourceType, run.sourceType);
    assert.ok(parsed.suite.name.length > 0);
    assert.ok(parsed.run.label.length > 0);
    assert.match(parsed.run.runAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(parsed.metrics.length >= 10);

    assertRequiredDemoMetrics(parsed);
    parsedByKey.set(run.key, parsed);
  }

  assert.ok(Array.isArray(manifest.comparisons));
  assert.equal(manifest.comparisons.length, 2);

  for (const comparison of manifest.comparisons) {
    assert.ok(runKeys.has(comparison.baselineRunKey));
    assert.ok(runKeys.has(comparison.candidateRunKey));
    assert.ok(Array.isArray(comparison.thresholdRules));
    assert.ok(comparison.thresholdRules.length > 0);
    assert.equal(
      suiteSignature(parsedByKey.get(comparison.baselineRunKey)),
      suiteSignature(parsedByKey.get(comparison.candidateRunKey)),
    );
  }
});

function assertRequiredDemoMetrics(parsed) {
  if (parsed.sourceType === "k6") {
    assertMetric(parsed, "http_req_duration", "p95", "ms");
    assertMetric(parsed, "http_req_duration", "p99", "ms");
    assertMetric(parsed, "http_req_failed", "rate", "percent");
    assertMetric(parsed, "http_reqs", "rate", "rps");
    return;
  }

  if (parsed.sourceType === "jest") {
    assertMetric(parsed, "tests_total", "count", "count");
    assertMetric(parsed, "tests_failed", "count", "count");
    assertMetric(parsed, "test_suites_failed", "count", "count");
    assertMetric(parsed, "duration_total", "total", "ms");
  }
}

function assertMetric(parsed, metricName, aggregationType, unit) {
  const found = parsed.metrics.find(
    (metric) =>
      metric.metricName === metricName &&
      metric.aggregationType === aggregationType &&
      metric.unit === unit,
  );

  assert.ok(found, `Expected ${parsed.run.label} to include ${metricName}:${aggregationType}:${unit}`);
}

function suiteSignature(parsed) {
  return [
    parsed.sourceType,
    parsed.suite.name,
    parsed.suite.scenarioName ?? "",
  ].join("::");
}
