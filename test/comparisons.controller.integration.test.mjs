import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { Test } from "@nestjs/testing";

import {
  ComparisonsController,
  ComparisonsModule,
  RunIngestionService,
  createDefaultParserRegistry,
} from "../dist/index.js";
import { countRows, createRepositories } from "./sqlite-test-utils.mjs";

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

test("POST /comparisons compares two runs, persists findings, and GET /comparisons/:id returns grouped details", async () => {
  const { controller, runRepository, comparisonRepository } = await createApp();
  const baseline = await ingestRun(runRepository, "baseline", fixture);
  const candidate = await ingestRun(
    runRepository,
    "candidate",
    candidateWithRegressionAndMissingMetric(fixture),
  );
  const thresholdRules = [
    {
      metricName: "http_req_duration",
      aggregationType: "p95",
      warnAbovePercent: 10,
      highAbovePercent: 20,
    },
  ];

  const created = await controller.createComparison({
    baselineRunId: baseline.persistedRun.runId,
    candidateRunId: candidate.persistedRun.runId,
    label: "candidate vs baseline",
    thresholdRules,
  });

  assert.ok(created.data.comparisonId);
  assert.equal(created.data.suiteId, baseline.persistedRun.suiteId);
  assert.equal(created.data.baselineRunId, baseline.persistedRun.runId);
  assert.equal(created.data.candidateRunId, candidate.persistedRun.runId);
  assert.equal(created.data.label, "candidate vs baseline");
  assert.deepEqual(created.data.thresholdRules, thresholdRules);
  assert.deepEqual(created.data.summary, {
    totalMetrics: 20,
    comparedMetrics: 18,
    regressions: 1,
    improvements: 1,
    unchanged: 16,
    missing: 2,
    highSeverityRegressions: 1,
  });
  assert.equal(created.data.findings.length, 20);
  assert.equal(created.data.findingIds.length, 20);
  assert.match(created.data.reportSummary, /Regressions: http_req_duration p95 regressed/);
  assert.equal(created.data.groupedFindings.byStatus.regressed.length, 1);
  assert.equal(created.data.groupedFindings.byStatus.improved.length, 1);
  assert.equal(created.data.groupedFindings.byStatus.missing.length, 2);
  assert.equal(created.data.groupedFindings.bySeverity.high.length, 1);

  const createdP95 = finding(created.data.findings, "http_req_duration", "p95", "ms");
  assert.equal(createdP95.status, "regressed");
  assert.equal(createdP95.severity, "high");
  assert.ok(created.data.groupedFindings.byMetricGroup[createdP95.metricGroup]?.includes(createdP95));

  const stored = await comparisonRepository.getComparisonWithFindings(created.data.comparisonId);
  assert.ok(stored);
  assert.equal(stored.findings.length, 20);

  const fetched = await controller.getComparison(created.data.comparisonId);
  assert.equal(fetched.data.comparisonId, created.data.comparisonId);
  assert.equal(fetched.data.label, "candidate vs baseline");
  assert.deepEqual(fetched.data.thresholdRules, thresholdRules);
  assert.deepEqual(fetched.data.summary, created.data.summary);
  assert.equal(fetched.data.reportSummary, created.data.reportSummary);
  assert.equal(fetched.data.findings.length, 20);
  assert.equal(fetched.data.groupedFindings.byStatus.regressed.length, 1);
  assert.equal(fetched.data.groupedFindings.byStatus.missing.length, 2);
  assert.equal(fetched.data.groupedFindings.bySeverity.high.length, 1);

  const fetchedP95 = finding(fetched.data.findings, "http_req_duration", "p95", "ms");
  assert.ok(fetchedP95.id);
  assert.equal(fetchedP95.comparisonId, created.data.comparisonId);
  assert.equal(fetched.data.groupedFindings.bySeverity.high[0]?.id, fetchedP95.id);
});

test("POST /comparisons returns 400 for invalid request bodies", async () => {
  const { controller } = await createApp();

  await expectHttpError(
    () => controller.createComparison({ baselineRunId: "1" }),
    400,
    "COMPARISON_REQUEST_VALIDATION_ERROR",
    "candidateRunId is required",
  );

  await expectHttpError(
    () =>
      controller.createComparison({
        baselineRunId: "1",
        candidateRunId: "2",
        thresholdRules: "not-json",
      }),
    400,
    "COMPARISON_REQUEST_VALIDATION_ERROR",
    "thresholdRules must be valid JSON",
  );
});

test("POST /comparisons maps missing runs and suite mismatches to API errors", async () => {
  const { controller, database, runRepository } = await createApp();

  await expectHttpError(
    () =>
      controller.createComparison({
        baselineRunId: "999",
        candidateRunId: "1000",
      }),
    404,
    "COMPARISON_RUN_NOT_FOUND",
    'Baseline run "999" was not found',
  );

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

  await expectHttpError(
    () =>
      controller.createComparison({
        baselineRunId: baseline.persistedRun.runId,
        candidateRunId: candidate.persistedRun.runId,
      }),
    400,
    "COMPARISON_SUITE_MISMATCH",
    "Cannot compare runs from different suites",
  );
  assert.equal(countRows(database, "benchmark_comparisons"), 0);
  assert.equal(countRows(database, "benchmark_comparison_findings"), 0);
});

test("GET /comparisons/:id returns 404 when the comparison does not exist", async () => {
  const { controller } = await createApp();

  await expectHttpError(
    () => controller.getComparison("999"),
    404,
    "COMPARISON_NOT_FOUND",
    'Comparison "999" was not found',
  );
});

async function createApp() {
  const { database, runRepository, comparisonRepository } =
    await createRepositories("bra-comparisons-api-");

  const moduleRef = await Test.createTestingModule({
    imports: [
      ComparisonsModule.register({
        runRepository,
        comparisonRepository,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();

  await app.init();
  apps.push(app);

  return {
    app,
    database,
    runRepository,
    comparisonRepository,
    controller: app.get(ComparisonsController),
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

async function expectHttpError(operation, status, code, message) {
  await assert.rejects(
    operation,
    (error) => {
      const response = error.getResponse?.();
      return error.getStatus?.() === status && response.code === code && response.message === message;
    },
  );
}
