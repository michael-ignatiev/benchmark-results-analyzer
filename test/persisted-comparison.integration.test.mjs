import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { newDb } from "pg-mem";

import {
  ComparisonValidationError,
  PersistedComparisonService,
  PostgresComparisonRepository,
  PostgresRunRepository,
  RunIngestionService,
  applyPostgresSchema,
  createDefaultParserRegistry,
} from "../dist/index.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/k6-summary.json", import.meta.url), "utf8"),
);

test("loads two persisted runs, compares them, stores comparison findings, and returns a summary", async () => {
  const { pool, runRepository, comparisonRepository, comparisonService } = await createHarness();
  const baseline = await ingestRun(runRepository, "baseline", fixture);
  const candidateFixture = candidateWithRegressionAndMissingMetric(fixture);
  const candidate = await ingestRun(runRepository, "candidate", candidateFixture);

  const result = await comparisonService.compareAndPersist({
    baselineRunId: baseline.persistedRun.runId,
    candidateRunId: candidate.persistedRun.runId,
    label: "candidate vs baseline",
    thresholdRules: [
      {
        metricName: "http_req_duration",
        aggregationType: "p95",
        warnAbovePercent: 10,
        highAbovePercent: 20,
      },
    ],
  });

  assert.ok(result.comparisonId);
  assert.equal(result.suiteId, baseline.persistedRun.suiteId);
  assert.equal(result.baselineRunId, baseline.persistedRun.runId);
  assert.equal(result.candidateRunId, candidate.persistedRun.runId);
  assert.equal(result.label, "candidate vs baseline");
  assert.deepEqual(result.summary, {
    totalMetrics: 20,
    comparedMetrics: 18,
    regressions: 1,
    improvements: 1,
    unchanged: 16,
    missing: 2,
    highSeverityRegressions: 1,
  });
  assert.equal(result.findings.length, 20);
  assert.equal(result.findingIds.length, 20);

  const p95Finding = finding(result.findings, "http_req_duration", "p95", "ms");
  assert.equal(p95Finding.status, "regressed");
  assert.equal(p95Finding.severity, "high");
  assert.equal(p95Finding.baselineValue, 512.5);
  assert.equal(p95Finding.candidateValue, 640.625);
  assert.equal(p95Finding.deltaAbsolute, 128.125);
  assert.equal(p95Finding.deltaPercent, 25);
  assert.match(p95Finding.reason, /exceeding the 20% regression threshold/);

  const throughputFinding = finding(result.findings, "http_reqs", "rate", "rps");
  assert.equal(throughputFinding.status, "improved");
  assert.equal(throughputFinding.deltaPercent, 10);

  const missingFinding = finding(result.findings, "data_sent", "count", "bytes");
  assert.equal(missingFinding.status, "missing");
  assert.equal(missingFinding.baselineValue, 262144);
  assert.equal(missingFinding.candidateValue, null);
  assert.equal(missingFinding.reason, "Metric present in baseline but missing in candidate");

  const stored = await comparisonRepository.getComparisonWithFindings(result.comparisonId);
  assert.ok(stored);
  assert.equal(stored.id, result.comparisonId);
  assert.equal(stored.label, "candidate vs baseline");
  assert.deepEqual(stored.thresholdRules, [
    {
      metricName: "http_req_duration",
      aggregationType: "p95",
      warnAbovePercent: 10,
      highAbovePercent: 20,
    },
  ]);
  assert.deepEqual(stored.summary, result.summary);
  assert.equal(stored.findings.length, 20);
  assert.equal(finding(stored.findings, "http_req_duration", "p95", "ms").severity, "high");

  assert.deepEqual(await tableCounts(pool), {
    comparisons: 1,
    findings: 20,
  });
});

test("compareAndPersist rejects missing run ids before storing a comparison", async () => {
  const { pool, comparisonService } = await createHarness();

  await assert.rejects(
    () =>
      comparisonService.compareAndPersist({
        baselineRunId: "999",
        candidateRunId: "1000",
      }),
    (error) =>
      error instanceof ComparisonValidationError &&
      error.code === "COMPARISON_RUN_NOT_FOUND" &&
      error.message === 'Baseline run "999" was not found',
  );
  assert.deepEqual(await tableCounts(pool), {
    comparisons: 0,
    findings: 0,
  });
});

test("compareAndPersist rejects runs from different suites before storing a comparison", async () => {
  const { pool, runRepository, comparisonService } = await createHarness();
  const baseline = await ingestRun(runRepository, "baseline", fixture, {
    suite: {
      name: "checkout-load-test",
    },
  });
  const candidate = await ingestRun(runRepository, "candidate", fixture, {
    suite: {
      name: "different-suite",
    },
  });

  await assert.rejects(
    () =>
      comparisonService.compareAndPersist({
        baselineRunId: baseline.persistedRun.runId,
        candidateRunId: candidate.persistedRun.runId,
      }),
    (error) =>
      error instanceof ComparisonValidationError &&
      error.code === "COMPARISON_SUITE_MISMATCH" &&
      error.message === "Cannot compare runs from different suites",
  );
  assert.deepEqual(await tableCounts(pool), {
    comparisons: 0,
    findings: 0,
  });
});

async function createHarness() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  const runRepository = new PostgresRunRepository(pool);
  const comparisonRepository = new PostgresComparisonRepository(pool);
  const comparisonService = new PersistedComparisonService(runRepository, comparisonRepository);

  await applyPostgresSchema(pool);

  return {
    pool,
    runRepository,
    comparisonRepository,
    comparisonService,
  };
}

async function ingestRun(runRepository, label, payload, overrides = {}) {
  const ingestion = new RunIngestionService(createDefaultParserRegistry(), runRepository);

  return ingestion.ingestBenchmarkArtifact({
    filename: `${label}.json`,
    content: JSON.stringify(payload),
    project: {
      name: "billing-api",
    },
    run: {
      label,
      runAt: label === "baseline" ? "2026-04-29T10:00:00.000Z" : "2026-04-29T11:00:00.000Z",
    },
    ...overrides,
  });
}

function candidateWithRegressionAndMissingMetric(input) {
  const candidate = JSON.parse(JSON.stringify(input));
  candidate.metrics.http_req_duration.values["p(95)"] = 640.625;
  candidate.metrics.http_reqs.values.rate = 27.5;
  delete candidate.metrics.data_sent;
  return candidate;
}

function finding(findings, metricName, aggregationType, unit) {
  const found = findings.find(
    (candidate) =>
      candidate.metricName === metricName &&
      candidate.aggregationType === aggregationType &&
      candidate.unit === unit,
  );

  assert.ok(found, `Expected finding ${metricName}:${aggregationType}:${unit}`);
  return found;
}

async function tableCounts(pool) {
  const comparisons = await countRows(pool, "benchmark_comparisons");
  const findings = await countRows(pool, "benchmark_comparison_findings");
  return { comparisons, findings };
}

async function countRows(pool, tableName) {
  const result = await pool.query(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(result.rows[0].count);
}
