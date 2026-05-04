import "reflect-metadata";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";

import { Test } from "@nestjs/testing";

import {
  RunsUploadController,
  RunsUploadModule,
} from "../dist/index.js";
import { countRows, createRunRepository } from "./sqlite-test-utils.mjs";

const fixtureContent = await readFile(
  new URL("./fixtures/k6-summary.json", import.meta.url),
  "utf8",
);

const apps = [];

afterEach(async () => {
  while (apps.length > 0) {
    const app = apps.pop();
    await app.close();
  }
});

test("POST /runs/upload accepts multipart metadata, parses the file, persists the run, and returns ids", async () => {
  const { controller, repository } = await createApp();

  const response = await controller.uploadRun(file("k6-summary.json", fixtureContent), {
    projectName: "billing-api",
    projectDescription: "Billing API benchmarks",
    projectMetadata: JSON.stringify({ owner: "payments" }),
    suiteName: "checkout-api-load-test",
    scenarioName: "steady_upload",
    suiteTags: JSON.stringify({ component: "checkout" }),
    label: "feature-upload",
    commitSha: "abc123",
    branchName: "feature/upload",
    environment: "staging",
    runAt: "2026-04-29T10:00:00.000Z",
    durationMs: "65000",
    runMetadata: JSON.stringify({ uploadedBy: "api-test" }),
  });

  assert.equal(response.data.sourceType, "k6");
  assert.equal(response.data.sourceFilename, "k6-summary.json");
  assert.equal(response.data.metrics.inserted, 20);
  assert.equal(response.data.metrics.ids.length, 20);
  assert.equal(response.data.parsed.suite.name, "checkout-api-load-test");
  assert.equal(response.data.parsed.suite.scenarioName, "steady_upload");
  assert.equal(response.data.parsed.run.label, "feature-upload");
  assert.equal(response.data.parsed.run.durationMs, 65000);
  assert.ok(response.data.projectId);
  assert.ok(response.data.suiteId);
  assert.ok(response.data.runId);

  const stored = await repository.getRunWithMetrics(response.data.runId);
  assert.ok(stored);
  assert.equal(stored.project.name, "billing-api");
  assert.equal(stored.project.description, "Billing API benchmarks");
  assert.deepEqual(stored.project.metadata, { owner: "payments" });
  assert.equal(stored.suite.name, "checkout-api-load-test");
  assert.deepEqual(stored.suite.tags, { component: "checkout" });
  assert.equal(stored.run.label, "feature-upload");
  assert.equal(stored.run.commitSha, "abc123");
  assert.equal(stored.run.branchName, "feature/upload");
  assert.equal(stored.run.environment, "staging");
  assert.equal(stored.run.runAt, "2026-04-29T10:00:00.000Z");
  assert.equal(stored.run.durationMs, 65000);
  assert.equal(stored.run.metadata.uploadedBy, "api-test");
  assert.equal(stored.metrics.length, 20);
});

test("POST /runs/upload accepts nested project/suite/run JSON form fields", async () => {
  const { controller, repository } = await createApp();

  const response = await controller.uploadRun(file("nested-k6.json", fixtureContent), {
    project: JSON.stringify({
      name: "billing-api",
      description: "Nested project payload",
    }),
    suite: JSON.stringify({
      name: "nested-suite",
      tags: { mode: "json" },
    }),
    run: JSON.stringify({
      label: "nested-run",
      branchName: "main",
      metadata: { source: "nested-json" },
    }),
  });

  const stored = await repository.getRunWithMetrics(response.data.runId);
  assert.ok(stored);
  assert.equal(stored.project.description, "Nested project payload");
  assert.equal(stored.suite.name, "nested-suite");
  assert.deepEqual(stored.suite.tags, { mode: "json" });
  assert.equal(stored.run.label, "nested-run");
  assert.equal(stored.run.branchName, "main");
  assert.equal(stored.run.metadata.source, "nested-json");
});

test("POST /runs/upload returns 400 when the file is missing", async () => {
  const { controller } = await createApp();

  await expectBadRequest(
    () => controller.uploadRun(undefined, { projectName: "billing-api" }),
    "UPLOAD_VALIDATION_ERROR",
    "file is required",
  );
});

test("POST /runs/upload returns 400 for invalid upload metadata", async () => {
  const { controller } = await createApp();

  await expectBadRequest(
    () =>
      controller.uploadRun(file("k6-summary.json", fixtureContent), {
        projectName: "billing-api",
        runAt: "not-a-date",
      }),
    "UPLOAD_VALIDATION_ERROR",
    "runAt must be a valid ISO date-time string",
  );
});

test("POST /runs/upload returns 400 for invalid JSON metadata fields", async () => {
  const { controller } = await createApp();

  await expectBadRequest(
    () =>
      controller.uploadRun(file("k6-summary.json", fixtureContent), {
        projectName: "billing-api",
        runMetadata: "{invalid-json",
      }),
    "UPLOAD_VALIDATION_ERROR",
    "runMetadata must be valid JSON",
  );
});

test("POST /runs/upload returns 400 when no parser can handle the file", async () => {
  const { controller, database } = await createApp();

  await expectBadRequest(
    () =>
      controller.uploadRun(file("unknown.json", JSON.stringify({ notMetrics: true })), {
        projectName: "billing-api",
      }),
    "PARSER_NOT_FOUND",
    "Unable to find a parser for the provided benchmark payload",
  );
  assert.deepEqual(tableCounts(database), {
    projects: 0,
    suites: 0,
    runs: 0,
    metrics: 0,
  });
});

async function createApp() {
  const { database, repository } = await createRunRepository("bra-runs-upload-");

  const moduleRef = await Test.createTestingModule({
    imports: [RunsUploadModule.register({ runRepository: repository })],
  }).compile();
  const app = moduleRef.createNestApplication();

  await app.init();
  apps.push(app);

  return {
    app,
    database,
    repository,
    controller: app.get(RunsUploadController),
  };
}

function tableCounts(database) {
  const projects = countRows(database, "benchmark_projects");
  const suites = countRows(database, "benchmark_suites");
  const runs = countRows(database, "benchmark_runs");
  const metrics = countRows(database, "benchmark_metrics");

  return { projects, suites, runs, metrics };
}

function file(filename, content) {
  return {
    originalname: filename,
    buffer: Buffer.from(content),
  };
}

async function expectBadRequest(operation, code, message) {
  await assert.rejects(
    operation,
    (error) => {
      const response = error.getResponse?.();
      return error.getStatus?.() === 400 && response.code === code && response.message === message;
    },
  );
}
