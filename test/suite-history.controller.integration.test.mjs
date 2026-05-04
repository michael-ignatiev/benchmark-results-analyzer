import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { Test } from "@nestjs/testing";

import {
  RunIngestionService,
  SuiteHistoryController,
  SuiteHistoryModule,
  createDefaultParserRegistry,
} from "../dist/index.js";
import { createRunRepository } from "./sqlite-test-utils.mjs";

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

test("GET /suites/:suiteId/history returns chart-ready selected metric trends with filters", async () => {
  const { controller, runRepository } = await createApp();
  const first = await ingestRun(runRepository, {
    label: "main-1",
    branchName: "main",
    environment: "staging",
    runAt: "2026-04-29T10:00:00.000Z",
    p95: 500,
    httpReqRate: 25,
  });
  await ingestRun(runRepository, {
    label: "feature-1",
    branchName: "feature/reporting",
    environment: "staging",
    runAt: "2026-04-29T11:00:00.000Z",
    p95: 700,
    httpReqRate: 30,
  });
  const second = await ingestRun(runRepository, {
    label: "main-2",
    branchName: "main",
    environment: "staging",
    runAt: "2026-04-29T12:00:00.000Z",
    p95: 550,
    httpReqRate: 27.5,
  });
  await ingestRun(runRepository, {
    label: "main-prod",
    branchName: "main",
    environment: "production",
    runAt: "2026-04-29T13:00:00.000Z",
    p95: 650,
    httpReqRate: 24,
  });

  const response = await controller.getSuiteHistory(first.persistedRun.suiteId, {
    metrics: "http_req_duration::p95::ms,http_reqs::rate::rps",
    environment: "staging",
    branch: "main",
    sourceType: "k6",
  });

  assert.equal(response.data.suite.id, first.persistedRun.suiteId);
  assert.deepEqual(response.data.filters, {
    metricKeys: ["http_req_duration::p95::ms", "http_reqs::rate::rps"],
    environment: "staging",
    branchName: "main",
    sourceType: "k6",
  });
  assert.deepEqual(
    response.data.runs.map((run) => ({
      id: run.id,
      label: run.label,
      runAt: run.runAt,
      branchName: run.branchName,
      environment: run.environment,
      sourceType: run.sourceType,
    })),
    [
      {
        id: first.persistedRun.runId,
        label: "main-1",
        runAt: "2026-04-29T10:00:00.000Z",
        branchName: "main",
        environment: "staging",
        sourceType: "k6",
      },
      {
        id: second.persistedRun.runId,
        label: "main-2",
        runAt: "2026-04-29T12:00:00.000Z",
        branchName: "main",
        environment: "staging",
        sourceType: "k6",
      },
    ],
  );

  assert.deepEqual(
    response.data.metrics.map((series) => ({
      metricKey: series.metricKey,
      metricGroup: series.metricGroup,
      values: series.points.map((point) => point.value),
    })),
    [
      {
        metricKey: "http_req_duration::p95::ms",
        metricGroup: "latency",
        values: [500, 550],
      },
      {
        metricKey: "http_reqs::rate::rps",
        metricGroup: "throughput",
        values: [25, 27.5],
      },
    ],
  );

  assert.deepEqual(response.data.chartSections, [
    {
      id: "suite-metric-trends",
      title: "Suite Metric Trends",
      visualization: "line",
      xKey: "runAt",
      yKey: "value",
      seriesKey: "metricKey",
      data: [
        {
          id: first.persistedRun.runId,
          label: "main-1",
          runAt: "2026-04-29T10:00:00.000Z",
          branchName: "main",
          environment: "staging",
          sourceType: "k6",
          value: 500,
          metricKey: "http_req_duration::p95::ms",
          metricName: "http_req_duration",
          metricGroup: "latency",
          aggregationType: "p95",
          unit: "ms",
        },
        {
          id: first.persistedRun.runId,
          label: "main-1",
          runAt: "2026-04-29T10:00:00.000Z",
          branchName: "main",
          environment: "staging",
          sourceType: "k6",
          value: 25,
          metricKey: "http_reqs::rate::rps",
          metricName: "http_reqs",
          metricGroup: "throughput",
          aggregationType: "rate",
          unit: "rps",
        },
        {
          id: second.persistedRun.runId,
          label: "main-2",
          runAt: "2026-04-29T12:00:00.000Z",
          branchName: "main",
          environment: "staging",
          sourceType: "k6",
          value: 550,
          metricKey: "http_req_duration::p95::ms",
          metricName: "http_req_duration",
          metricGroup: "latency",
          aggregationType: "p95",
          unit: "ms",
        },
        {
          id: second.persistedRun.runId,
          label: "main-2",
          runAt: "2026-04-29T12:00:00.000Z",
          branchName: "main",
          environment: "staging",
          sourceType: "k6",
          value: 27.5,
          metricKey: "http_reqs::rate::rps",
          metricName: "http_reqs",
          metricGroup: "throughput",
          aggregationType: "rate",
          unit: "rps",
        },
      ],
    },
  ]);
});

test("GET /suites/:suiteId/history supports repeated metric parameters and branchName filtering", async () => {
  const { controller, runRepository } = await createApp();
  const main = await ingestRun(runRepository, {
    label: "main",
    branchName: "main",
    environment: "staging",
    runAt: "2026-04-29T10:00:00.000Z",
    p95: 500,
    httpReqRate: 25,
  });
  const feature = await ingestRun(runRepository, {
    label: "feature",
    branchName: "feature/reporting",
    environment: "staging",
    runAt: "2026-04-29T11:00:00.000Z",
    p95: 700,
    httpReqRate: 30,
  });

  const response = await controller.getSuiteHistory(main.persistedRun.suiteId, {
    metric: ["http_req_duration::p95::ms", "http_reqs::rate::rps"],
    branchName: "feature/reporting",
  });

  assert.deepEqual(
    response.data.runs.map((run) => run.id),
    [feature.persistedRun.runId],
  );
  assert.deepEqual(
    response.data.chartSections[0].data.map((datum) => [datum.metricKey, datum.value]),
    [
      ["http_req_duration::p95::ms", 700],
      ["http_reqs::rate::rps", 30],
    ],
  );
});

test("GET /suites/:suiteId/history returns empty series for selected metrics without matching points", async () => {
  const { controller, runRepository } = await createApp();
  const run = await ingestRun(runRepository, {
    label: "main",
    branchName: "main",
    environment: "staging",
    runAt: "2026-04-29T10:00:00.000Z",
    p95: 500,
    httpReqRate: 25,
  });

  const response = await controller.getSuiteHistory(run.persistedRun.suiteId, {
    metrics: "missing_metric::count::count",
  });

  assert.deepEqual(response.data.runs, []);
  assert.deepEqual(response.data.metrics, [
    {
      metricKey: "missing_metric::count::count",
      metricName: "missing_metric",
      metricGroup: null,
      aggregationType: "count",
      unit: "count",
      points: [],
    },
  ]);
  assert.deepEqual(response.data.chartSections[0].data, []);
});

test("GET /suites/:suiteId/history validates metric keys and source type", async () => {
  const { controller } = await createApp();

  await expectBadRequest(
    () => controller.getSuiteHistory("1", {}),
    "metrics query parameter is required",
  );
  await expectBadRequest(
    () => controller.getSuiteHistory("1", { metrics: "http_req_duration:p95:ms" }),
    'metric key "http_req_duration:p95:ms" must use metricName::aggregationType::unit',
  );
  await expectBadRequest(
    () =>
      controller.getSuiteHistory("1", {
        metrics: "http_req_duration::p95::ms",
        sourceType: "unknown",
      }),
    "sourceType must be one of k6, jest",
  );
});

test("GET /suites/:suiteId/history returns 404 when the suite does not exist", async () => {
  const { controller } = await createApp();

  await assert.rejects(
    () =>
      controller.getSuiteHistory("999", {
        metrics: "http_req_duration::p95::ms",
      }),
    (error) => {
      const response = error.getResponse?.();
      return (
        error.getStatus?.() === 404 &&
        response.code === "SUITE_NOT_FOUND" &&
        response.message === 'Suite "999" was not found'
      );
    },
  );
});

async function createApp() {
  const { database, repository: runRepository } =
    await createRunRepository("bra-suite-history-");

  const moduleRef = await Test.createTestingModule({
    imports: [
      SuiteHistoryModule.register({
        runRepository,
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
    controller: app.get(SuiteHistoryController),
  };
}

async function ingestRun(
  runRepository,
  { label, branchName, environment, runAt, p95, httpReqRate },
) {
  const ingestion = new RunIngestionService(createDefaultParserRegistry(), runRepository);

  return ingestion.ingestBenchmarkArtifact({
    filename: `${label}.json`,
    content: JSON.stringify(k6Payload({ p95, httpReqRate })),
    project: {
      name: "billing-api",
    },
    run: {
      label,
      branchName,
      environment,
      runAt,
    },
  });
}

function k6Payload({ p95, httpReqRate }) {
  const payload = JSON.parse(JSON.stringify(fixture));
  payload.metrics.http_req_duration.values["p(95)"] = p95;
  payload.metrics.http_reqs.values.rate = httpReqRate;
  return payload;
}

async function expectBadRequest(operation, message) {
  await assert.rejects(
    operation,
    (error) => {
      const response = error.getResponse?.();
      return (
        error.getStatus?.() === 400 &&
        response.code === "SUITE_HISTORY_VALIDATION_ERROR" &&
        response.message === message
      );
    },
  );
}
