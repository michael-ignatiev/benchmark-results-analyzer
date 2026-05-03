import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { Test } from "@nestjs/testing";
import { newDb } from "pg-mem";

import {
  PersistedComparisonService,
  PostgresComparisonRepository,
  PostgresRunRepository,
  ReportsController,
  ReportsModule,
  RunIngestionService,
  applyPostgresSchema,
  createDefaultParserRegistry,
} from "../dist/index.js";

const fixture = JSON.parse(
  await readFile(new URL("./fixtures/k6-summary.json", import.meta.url), "utf8"),
);
const apps = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app.close();
  }
});

test("GET /reports/:comparisonId returns metadata, summary text, grouped findings, and chart sections", async () => {
  const { controller, runRepository, comparisonService } = await createApp();
  const baseline = await ingestRun(runRepository, "baseline", fixture);
  const candidate = await ingestRun(
    runRepository,
    "candidate",
    candidateWithRegressionAndMissingMetric(fixture),
  );
  const comparison = await comparisonService.compareAndPersist({
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

  const response = await controller.getReport(comparison.comparisonId);

  assert.deepEqual(
    {
      id: response.data.comparison.id,
      suiteId: response.data.comparison.suiteId,
      baselineRunId: response.data.comparison.baselineRunId,
      candidateRunId: response.data.comparison.candidateRunId,
      label: response.data.comparison.label,
      thresholdRules: response.data.comparison.thresholdRules,
    },
    {
      id: comparison.comparisonId,
      suiteId: comparison.suiteId,
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
    },
  );
  assert.match(response.data.comparison.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(response.data.summary, comparison.summary);
  assert.equal(response.data.summaryText, comparison.reportSummary);
  assert.match(response.data.summaryText, /Regressions: http_req_duration p95 regressed/);

  assert.deepEqual(
    response.data.groupedFindings.byStatus.map((group) => [group.key, group.count]),
    [
      ["regressed", 1],
      ["improved", 1],
      ["unchanged", 16],
      ["missing", 2],
    ],
  );
  assert.deepEqual(
    response.data.groupedFindings.bySeverity.map((group) => [group.key, group.count]),
    [
      ["high", 1],
      ["medium", 0],
      ["low", 0],
      ["none", 19],
    ],
  );
  assert.deepEqual(
    response.data.groupedFindings.byMetricGroup.map((group) => group.key),
    ["concurrency", "latency", "reliability", "throughput", "volume"],
  );

  const statusSection = section(response, "finding-status-counts");
  assert.equal(statusSection.visualization, "bar");
  assert.deepEqual(statusSection.data, [
    { key: "regressed", label: "Regressed", count: 1 },
    { key: "improved", label: "Improved", count: 1 },
    { key: "unchanged", label: "Unchanged", count: 16 },
    { key: "missing", label: "Missing", count: 2 },
  ]);

  const severitySection = section(response, "finding-severity-counts");
  assert.deepEqual(severitySection.data, [
    { key: "high", label: "High", count: 1 },
    { key: "medium", label: "Medium", count: 0 },
    { key: "low", label: "Low", count: 0 },
    { key: "none", label: "None", count: 19 },
  ]);

  const percentDeltaSection = section(response, "metric-percent-deltas");
  assert.equal(percentDeltaSection.visualization, "bar");
  assert.equal(percentDeltaSection.unit, "percent");
  const p95Delta = percentDeltaSection.data.find(
    (datum) => datum.metricKey === "http_req_duration::p95::ms",
  );
  assert.deepEqual(p95Delta, {
    metricKey: "http_req_duration::p95::ms",
    metricName: "http_req_duration",
    metricGroup: "latency",
    aggregationType: "p95",
    unit: "ms",
    baselineValue: 512.5,
    candidateValue: 640.625,
    deltaPercent: 25,
    deltaAbsolute: 128.125,
    status: "regressed",
    severity: "high",
  });

  const missingSection = section(response, "missing-metrics");
  assert.equal(missingSection.visualization, "table");
  assert.deepEqual(
    missingSection.data.map((datum) => ({
      metricKey: datum.metricKey,
      missingFrom: datum.missingFrom,
      baselineValue: datum.baselineValue,
      candidateValue: datum.candidateValue,
      severity: datum.severity,
    })),
    [
      {
        metricKey: "data_sent::rate::bytes_per_second",
        missingFrom: "candidate",
        baselineValue: 13107.2,
        candidateValue: null,
        severity: "none",
      },
      {
        metricKey: "data_sent::count::bytes",
        missingFrom: "candidate",
        baselineValue: 262144,
        candidateValue: null,
        severity: "none",
      },
    ],
  );
});

test("GET /reports/:comparisonId returns 404 when the comparison does not exist", async () => {
  const { controller } = await createApp();

  await assert.rejects(
    () => controller.getReport("999"),
    (error) => {
      const response = error.getResponse?.();
      return (
        error.getStatus?.() === 404 &&
        response.code === "COMPARISON_NOT_FOUND" &&
        response.message === 'Comparison "999" was not found'
      );
    },
  );
});

async function createApp() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  const runRepository = new PostgresRunRepository(pool);
  const comparisonRepository = new PostgresComparisonRepository(pool);
  const comparisonService = new PersistedComparisonService(runRepository, comparisonRepository);

  await applyPostgresSchema(pool);

  const moduleRef = await Test.createTestingModule({
    imports: [
      ReportsModule.register({
        comparisonRepository,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();

  await app.init();
  apps.push(app);

  return {
    app,
    pool,
    runRepository,
    comparisonRepository,
    comparisonService,
    controller: app.get(ReportsController),
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

function section(response, id) {
  const found = response.data.chartSections.find((candidate) => candidate.id === id);
  assert.ok(found, `Expected report chart section "${id}"`);
  return found;
}
