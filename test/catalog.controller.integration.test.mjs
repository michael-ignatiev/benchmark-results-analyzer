import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { Test } from "@nestjs/testing";
import { newDb } from "pg-mem";

import {
  CatalogController,
  CatalogModule,
  PostgresRunRepository,
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

test("catalog endpoints list projects, suites, and suite detail for stored runs", async () => {
  const { controller, runRepository } = await createApp();
  const first = await ingestRun(runRepository, {
    projectName: "billing-api",
    suiteName: "checkout-load-test",
    label: "baseline",
    runAt: "2026-04-29T10:00:00.000Z",
  });
  const second = await ingestRun(runRepository, {
    projectName: "billing-api",
    suiteName: "checkout-load-test",
    label: "candidate",
    runAt: "2026-04-29T11:00:00.000Z",
  });

  const projects = await controller.listProjects();
  assert.deepEqual(projects.data.projects.map((project) => ({
    id: project.id,
    name: project.name,
    suiteCount: project.suiteCount,
    runCount: project.runCount,
    latestRunAt: project.latestRunAt,
  })), [
    {
      id: first.persistedRun.projectId,
      name: "billing-api",
      suiteCount: 1,
      runCount: 2,
      latestRunAt: "2026-04-29T11:00:00.000Z",
    },
  ]);

  const suites = await controller.listSuites();
  assert.deepEqual(suites.data.suites.map((suite) => ({
    id: suite.id,
    name: suite.name,
    projectId: suite.projectId,
    projectName: suite.project.name,
    runCount: suite.runCount,
    latestRunAt: suite.latestRunAt,
  })), [
    {
      id: first.persistedRun.suiteId,
      name: "checkout-load-test",
      projectId: first.persistedRun.projectId,
      projectName: "billing-api",
      runCount: 2,
      latestRunAt: "2026-04-29T11:00:00.000Z",
    },
  ]);

  const projectSuites = await controller.listProjectSuites(first.persistedRun.projectId);
  assert.equal(projectSuites.data.suites.length, 1);
  assert.equal(projectSuites.data.suites[0].id, first.persistedRun.suiteId);

  const detail = await controller.getSuite(first.persistedRun.suiteId);
  assert.equal(detail.data.project.name, "billing-api");
  assert.equal(detail.data.suite.name, "checkout-load-test");
  assert.deepEqual(
    detail.data.runs.map((run) => [run.id, run.label, run.metricCount]),
    [
      [second.persistedRun.runId, "candidate", 20],
      [first.persistedRun.runId, "baseline", 20],
    ],
  );
  assert.ok(
    detail.data.metricKeys.some(
      (metric) =>
        metric.metricName === "http_req_duration" &&
        metric.aggregationType === "p95" &&
        metric.unit === "ms",
    ),
  );
});

test("catalog suite detail returns 404 when suite is missing", async () => {
  const { controller } = await createApp();

  await assert.rejects(
    () => controller.getSuite("999"),
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
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();
  const runRepository = new PostgresRunRepository(pool);

  await applyPostgresSchema(pool);

  const moduleRef = await Test.createTestingModule({
    imports: [
      CatalogModule.register({
        runRepository,
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication();

  await app.init();
  apps.push(app);

  return {
    app,
    runRepository,
    controller: app.get(CatalogController),
  };
}

async function ingestRun(
  runRepository,
  { projectName, suiteName, label, runAt },
) {
  const ingestion = new RunIngestionService(createDefaultParserRegistry(), runRepository);

  return ingestion.ingestBenchmarkArtifact({
    filename: `${label}.json`,
    content: JSON.stringify(fixture),
    project: {
      name: projectName,
    },
    suite: {
      name: suiteName,
    },
    run: {
      label,
      runAt,
    },
  });
}
