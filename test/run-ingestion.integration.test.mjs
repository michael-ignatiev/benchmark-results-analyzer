import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { newDb } from "pg-mem";

import {
  ParserValidationError,
  PostgresRunRepository,
  RunIngestionService,
  applyPostgresSchema,
  createDefaultParserRegistry,
} from "../dist/index.js";

const fixtureContent = await readFile(
  new URL("./fixtures/k6-summary.json", import.meta.url),
  "utf8",
);

test("ingests a benchmark artifact, parses it, and persists run metrics", async () => {
  const { pool, repository } = await createRepository();
  const service = new RunIngestionService(createDefaultParserRegistry(), repository);

  const result = await service.ingestBenchmarkArtifact({
    filename: "checkout-baseline.json",
    content: fixtureContent,
    project: {
      name: "billing-api",
      description: "Billing API benchmark project",
      metadata: {
        owner: "payments",
      },
    },
    rawFilePath: "artifacts/checkout-baseline.json",
    run: {
      label: "imported-baseline",
      branchName: "feature/import-flow",
      metadata: {
        importedBy: "integration-test",
      },
    },
  });

  assert.equal(result.parsedRun.sourceType, "k6");
  assert.equal(result.parsedRun.run.label, "imported-baseline");
  assert.equal(result.parsedRun.run.branchName, "feature/import-flow");
  assert.ok(result.persistedRun.projectId);
  assert.equal(result.persistedRun.metricsInserted, 20);
  assert.equal(result.persistedRun.metricIds.length, 20);

  const stored = await repository.getRunWithMetrics(result.persistedRun.runId);
  assert.ok(stored);
  assert.equal(stored.project.name, "billing-api");
  assert.equal(stored.project.description, "Billing API benchmark project");
  assert.deepEqual(stored.project.metadata, {
    owner: "payments",
  });
  assert.equal(stored.suite.name, "checkout-load-test");
  assert.equal(stored.suite.projectId, result.persistedRun.projectId);
  assert.equal(stored.suite.sourceType, "k6");
  assert.equal(stored.suite.scenarioName, "steady_load");
  assert.deepEqual(stored.suite.tags, {
    component: "billing",
    team: "payments",
  });
  assert.equal(stored.run.label, "imported-baseline");
  assert.equal(stored.run.branchName, "feature/import-flow");
  assert.equal(stored.run.sourceFilename, "checkout-baseline.json");
  assert.equal(stored.run.rawFilePath, "artifacts/checkout-baseline.json");
  assert.equal(stored.run.durationMs, 60000);
  assert.equal(stored.run.metadata.k6MetricCount, 8);
  assert.equal(stored.run.metadata.importedBy, "integration-test");
  assert.equal(stored.metrics.length, 20);

  const p95 = metric(stored.metrics, "http_req_duration", "p95", "ms");
  assert.equal(p95.metricGroup, "latency");
  assert.equal(p95.valueNumeric, 512.5);
  assert.equal(p95.direction, "lower_is_better");
  assert.deepEqual(p95.metadata.thresholds, {
    "p(95)<600": {
      ok: true,
    },
  });

  const persistedCounts = await tableCounts(pool);
  assert.deepEqual(persistedCounts, {
    projects: 1,
    suites: 1,
    runs: 1,
    metrics: 20,
  });
});

test("subsequent imports for the same parsed suite reuse the stored suite", async () => {
  const { pool, repository } = await createRepository();
  const service = new RunIngestionService(createDefaultParserRegistry(), repository);

  const baseline = await service.ingestBenchmarkArtifact({
    filename: "checkout-baseline.json",
    content: fixtureContent,
    project: {
      name: "billing-api",
    },
    run: {
      label: "baseline",
    },
  });
  const candidate = await service.ingestBenchmarkArtifact({
    filename: "checkout-candidate.json",
    content: fixtureContent,
    project: {
      name: "billing-api",
    },
    run: {
      label: "candidate",
    },
  });

  assert.equal(candidate.persistedRun.projectId, baseline.persistedRun.projectId);
  assert.equal(candidate.persistedRun.suiteId, baseline.persistedRun.suiteId);
  assert.notEqual(candidate.persistedRun.runId, baseline.persistedRun.runId);
  assert.deepEqual(await tableCounts(pool), {
    projects: 1,
    suites: 1,
    runs: 2,
    metrics: 40,
  });
});

test("invalid benchmark artifacts fail before persistence", async () => {
  const { pool, repository } = await createRepository();
  const service = new RunIngestionService(createDefaultParserRegistry(), repository);

  await assert.rejects(
    () =>
      service.ingestBenchmarkArtifact({
        filename: "invalid-k6.json",
        content: JSON.stringify({ options: {} }),
      }),
    (error) =>
      error instanceof ParserValidationError &&
      error.message === "Unable to find a parser for the provided benchmark payload",
  );
  assert.deepEqual(await tableCounts(pool), {
    projects: 0,
    suites: 0,
    runs: 0,
    metrics: 0,
  });
});

async function createRepository() {
  const database = newDb({ autoCreateForeignKeyIndices: true });
  const adapter = database.adapters.createPg();
  const pool = new adapter.Pool();

  await applyPostgresSchema(pool);

  return {
    pool,
    repository: new PostgresRunRepository(pool),
  };
}

async function tableCounts(pool) {
  const projects = await countRows(pool, "benchmark_projects");
  const suites = await countRows(pool, "benchmark_suites");
  const runs = await countRows(pool, "benchmark_runs");
  const metrics = await countRows(pool, "benchmark_metrics");

  return { projects, suites, runs, metrics };
}

async function countRows(pool, tableName) {
  const result = await pool.query(`SELECT COUNT(*) AS count FROM ${tableName}`);
  return Number(result.rows[0].count);
}

function metric(metrics, metricName, aggregationType, unit) {
  const found = metrics.find(
    (candidate) =>
      candidate.metricName === metricName &&
      candidate.aggregationType === aggregationType &&
      candidate.unit === unit,
  );

  assert.ok(found, `Expected persisted metric ${metricName}:${aggregationType}:${unit}`);
  return found;
}
