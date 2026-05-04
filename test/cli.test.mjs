import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

import { openSqliteDatabase, SqliteRunRepository } from "../dist/index.js";
import { runCli } from "../dist/cli/run.js";
import { countRows as countSqliteRows } from "./sqlite-test-utils.mjs";

const k6Fixture = JSON.parse(
  await readFile(new URL("./fixtures/k6-summary.json", import.meta.url), "utf8"),
);

test("CLI init creates default local config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-init-"));
  const { runtime, stdout } = createRuntime(cwd);

  assert.equal(await runCli(["init"], runtime), 0);
  assert.match(stdout.join("\n"), /Initialized Benchmark Results Analyzer config/);

  const config = JSON.parse(await readFile(join(cwd, ".benchmark-analyzer.json"), "utf8"));
  assert.equal(config.projectName, cwd.split("/").at(-1));
  assert.deepEqual(config.storage, {
    type: "sqlite",
    path: ".benchmark-analyzer/runs.db",
  });
  assert.deepEqual(config.thresholdRules, []);
  assert.deepEqual(config.metadataDefaults, {});
});

test("CLI init supports explicit config defaults and protects existing config", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-init-options-"));
  const thresholdsPath = join(cwd, "thresholds.json");
  const first = createRuntime(cwd);

  await writeFile(
    thresholdsPath,
    JSON.stringify([
      {
        metricName: "http_req_duration",
        aggregationType: "p95",
        warnAbovePercent: 10,
      },
    ]),
    "utf8",
  );

  assert.equal(
    await runCli(
      [
        "init",
        "--config",
        "benchmark.config.json",
        "--project",
        "CLI Demo",
        "--project-description",
        "CLI demo benchmarks",
        "--sqlite-path",
        "custom-runs.db",
        "--thresholds",
        thresholdsPath,
        "--metadata",
        "owner=payments",
        "--metadata",
        "environment=local",
      ],
      first.runtime,
    ),
    0,
  );

  const configPath = join(cwd, "benchmark.config.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config, {
    projectName: "CLI Demo",
    projectDescription: "CLI demo benchmarks",
    storage: {
      type: "sqlite",
      path: "custom-runs.db",
    },
    thresholdRules: [
      {
        metricName: "http_req_duration",
        aggregationType: "p95",
        warnAbovePercent: 10,
      },
    ],
    metadataDefaults: {
      owner: "payments",
      environment: "local",
    },
  });

  const second = createRuntime(cwd);
  assert.equal(
    await runCli(["init", "--config", "benchmark.config.json"], second.runtime),
    1,
  );
  assert.match(second.stderr.join("\n"), /Config already exists/);

  const third = createRuntime(cwd);
  assert.equal(
    await runCli(
      ["init", "--config", "benchmark.config.json", "--project", "Overwritten", "--force"],
      third.runtime,
    ),
    0,
  );
  const overwritten = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(overwritten.projectName, "Overwritten");
  assert.deepEqual(overwritten.thresholdRules, []);
  assert.deepEqual(overwritten.metadataDefaults, {});
});

test("CLI uses local SQLite storage by default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-sqlite-flow-"));
  const baselinePath = join(cwd, "baseline.json");
  const candidatePath = join(cwd, "candidate.json");
  const init = createRuntime(cwd);

  await writeFile(baselinePath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(candidatePath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  assert.equal(
    await runCli(["init", "--project", "sqlite-demo"], init.runtime),
    0,
    init.stderr.join("\n"),
  );

  const baseline = await runJson(
    [
      "import",
      "--file",
      baselinePath,
      "--label",
      "baseline",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const candidate = await runJson(
    [
      "import",
      "--file",
      candidatePath,
      "--label",
      "candidate",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );

  assert.equal(candidate.suiteId, baseline.suiteId);

  const comparison = await runJson(
    [
      "compare",
      "--baseline",
      baseline.runId,
      "--candidate",
      candidate.runId,
      "--json",
    ],
    cwd,
  );

  assert.equal(comparison.saved, true);
  assert.equal(comparison.summary.regressions, 1);
  assert.ok(comparison.comparisonId);

  const report = await runJson(
    ["report", "--comparison-id", comparison.comparisonId, "--format", "json"],
    cwd,
  );

  assert.match(report.summaryText, /Compared 20 metrics/);

  const history = await runJson(
    [
      "history",
      "--suite-id",
      baseline.suiteId,
      "--metric",
      "http_req_duration:p95:ms",
      "--json",
    ],
    cwd,
  );

  assert.deepEqual(
    history.series[0].points.map((point) => point.valueNumeric),
    [512.5, 640.625],
  );
});

test("CLI imports runs, compares, reports, and returns history using shared services", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-flow-"));
  const baselinePath = join(cwd, "baseline.json");
  const candidatePath = join(cwd, "candidate.json");
  const thresholdsPath = join(cwd, "thresholds.json");

  await writeFile(baselinePath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(candidatePath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");
  await writeFile(
    thresholdsPath,
    JSON.stringify([
      {
        metricName: "http_req_duration",
        aggregationType: "p95",
        warnAbovePercent: 10,
        highAbovePercent: 20,
      },
    ]),
    "utf8",
  );

  const baseline = await runJson(
    [
      "import",
      "--file",
      baselinePath,
      "--project",
      "cli-demo",
      "--label",
      "baseline",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--json",
    ],
    cwd,
  );
  const candidate = await runJson(
    [
      "import",
      "--file",
      candidatePath,
      "--project",
      "cli-demo",
      "--label",
      "candidate",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--json",
    ],
    cwd,
  );

  assert.equal(baseline.sourceType, "k6");
  assert.equal(candidate.suiteId, baseline.suiteId);
  assert.notEqual(candidate.runId, baseline.runId);

  const comparison = await runJson(
    [
      "compare",
      "--baseline-run-id",
      baseline.runId,
      "--candidate-run-id",
      candidate.runId,
      "--thresholds",
      thresholdsPath,
      "--json",
    ],
    cwd,
  );

  assert.ok(comparison.comparisonId);
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(comparison.summary.highSeverityRegressions, 1);

  const report = await runJson(
    ["report", "--comparison-id", comparison.comparisonId, "--format", "json"],
    cwd,
  );

  assert.match(report.summaryText, /Compared 20 metrics/);
  assert.equal(report.groupedFindings.regressed.length, 1);
  assert.equal(report.groupedFindings.missing.length, 2);

  const history = await runJson(
    [
      "history",
      "--suite-id",
      baseline.suiteId,
      "--metric",
      "http_req_duration:p95:ms",
      "--json",
    ],
    cwd,
  );

  assert.equal(history.series.length, 1);
  assert.deepEqual(history.filters, {});
  assert.equal(history.recentRuns.length, 2);
  assert.deepEqual(
    history.series[0].points.map((point) => point.valueNumeric),
    [512.5, 640.625],
  );
});

test("CLI history shows recent runs and default key metric trends by suite name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-history-text-"));
  const oldPath = join(cwd, "old.json");
  const previousPath = join(cwd, "previous.json");
  const latestPath = join(cwd, "latest.json");

  await writeFile(oldPath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(previousPath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(latestPath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  await runJson(
    [
      "import",
      "--file",
      oldPath,
      "--project",
      "cli-history-demo",
      "--label",
      "old",
      "--run-at",
      "2026-04-29T09:00:00.000Z",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const previous = await runJson(
    [
      "import",
      "--file",
      previousPath,
      "--project",
      "cli-history-demo",
      "--label",
      "previous",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const latest = await runJson(
    [
      "import",
      "--file",
      latestPath,
      "--project",
      "cli-history-demo",
      "--label",
      "latest",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const { runtime, stdout, stderr } = createRuntime(cwd);

  assert.equal(
    await runCli(["history", "--suite", "checkout-load-test", "--limit", "2"], runtime),
    0,
    stderr.join("\n"),
  );

  assert.equal(stdout[0], `Suite ${latest.suiteId} checkout-load-test`);
  assert.equal(stdout[1], "Recent runs (2 shown):");
  assert.match(
    stdout[2],
    new RegExp(
      `^- run ${latest.runId} latest 2026-04-29T11:00:00.000Z, branch main, env staging \\(18 metrics\\)$`,
    ),
  );
  assert.match(
    stdout[3],
    new RegExp(
      `^- run ${previous.runId} previous 2026-04-29T10:00:00.000Z, branch main, env staging \\(20 metrics\\)$`,
    ),
  );
  assert.equal(stdout[4], "Key metric trends:");

  const output = stdout.join("\n");
  assert.match(
    output,
    /http_req_duration p95 ms: 512\.5 -> 640\.625 \(\+128\.125, 3 points\)/,
  );
  assert.match(output, /http_reqs rate rps: 25 -> 27\.5 \(\+2\.5, 3 points\)/);
});

test("CLI history returns filtered JSON trends and validates history options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-history-json-"));
  const baselinePath = join(cwd, "baseline.json");
  const candidatePath = join(cwd, "candidate.json");
  const branchPath = join(cwd, "branch.json");

  await writeFile(baselinePath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(candidatePath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");
  await writeFile(branchPath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  const baseline = await runJson(
    [
      "import",
      "--file",
      baselinePath,
      "--project",
      "cli-history-filter-demo",
      "--label",
      "baseline",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const candidate = await runJson(
    [
      "import",
      "--file",
      candidatePath,
      "--project",
      "cli-history-filter-demo",
      "--label",
      "candidate",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );

  await runJson(
    [
      "import",
      "--file",
      branchPath,
      "--project",
      "cli-history-filter-demo",
      "--label",
      "feature",
      "--run-at",
      "2026-04-29T12:00:00.000Z",
      "--branch",
      "feature/history",
      "--environment",
      "staging",
      "--no-git",
      "--json",
    ],
    cwd,
  );

  const history = await runJson(
    [
      "history",
      "--suite-id",
      baseline.suiteId,
      "--metric",
      "http_req_duration:p95:ms",
      "--branch",
      "main",
      "--environment",
      "staging",
      "--json",
    ],
    cwd,
  );

  assert.equal(history.suite.id, baseline.suiteId);
  assert.deepEqual(history.filters, {
    branchName: "main",
    environment: "staging",
  });
  assert.deepEqual(
    history.recentRuns.map((run) => run.id),
    [candidate.runId, baseline.runId],
  );
  assert.deepEqual(
    history.series[0].points.map((point) => point.valueNumeric),
    [512.5, 640.625],
  );

  const badLimit = createRuntime(cwd);
  assert.equal(
    await runCli(
      ["history", "--suite-id", baseline.suiteId, "--limit", "0"],
      badLimit.runtime,
    ),
    1,
  );
  assert.match(badLimit.stderr.join("\n"), /Option --limit must be a positive integer/);

  const conflictingSelector = createRuntime(cwd);
  assert.equal(
    await runCli(
      [
        "history",
        "--suite-id",
        baseline.suiteId,
        "--suite",
        "checkout-load-test",
      ],
      conflictingSelector.runtime,
    ),
    1,
  );
  assert.match(conflictingSelector.stderr.join("\n"), /Use either --suite-id or --suite/);
});

test("CLI import autodetects source, captures git metadata, persists metrics, and prints concise output", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-import-"));
  const filePath = join(cwd, "k6-result.json");
  const gitCalls = [];

  await writeFile(filePath, JSON.stringify(k6Fixture), "utf8");

  const { runtime, stdout, stderr } = createRuntime(cwd, {
    execFile: async (_file, args) => {
      gitCalls.push(args.join(" "));

      if (args.includes("--abbrev-ref")) {
        return { stdout: "feature/import-cli\n" };
      }

      return { stdout: "abc123def456\n" };
    },
  });
  const exitCode = await runCli(
    [
      "import",
      "--file",
      filePath,
      "--project",
      "cli-import-demo",
      "--label",
      "imported-from-cli",
      "--source",
      "k6",
      "--metadata",
      "owner=payments",
    ],
    runtime,
  );

  assert.equal(exitCode, 0, stderr.join("\n"));
  assert.equal(stdout.length, 1);
  assert.match(stdout[0], /^Imported k6 run \d+ into suite \d+ \(20 metrics\)\.$/);
  assert.deepEqual(gitCalls.sort(), ["rev-parse --abbrev-ref HEAD", "rev-parse HEAD"]);

  const runId = stdout[0].match(/run (?<runId>\d+)/)?.groups?.runId;
  assert.ok(runId);

  const database = await openCliDatabase(cwd);
  const repository = new SqliteRunRepository(database);
  const stored = await repository.getRunWithMetrics(runId);
  database.close();

  assert.ok(stored);
  assert.equal(stored.project.name, "cli-import-demo");
  assert.equal(stored.run.label, "imported-from-cli");
  assert.equal(stored.run.branchName, "feature/import-cli");
  assert.equal(stored.run.commitSha, "abc123def456");
  assert.equal(stored.run.rawFilePath, "k6-result.json");
  assert.equal(stored.run.metadata.owner, "payments");
  assert.equal(stored.run.metadata.k6MetricCount, 8);
  assert.equal(stored.metrics.length, 20);
});

test("CLI import rejects an explicit source type mismatch before persistence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-import-mismatch-"));
  const filePath = join(cwd, "k6-result.json");
  const { runtime, stderr } = createRuntime(cwd);

  await writeFile(filePath, JSON.stringify(k6Fixture), "utf8");

  const exitCode = await runCli(
    [
      "import",
      "--file",
      filePath,
      "--source",
      "jest",
      "--project",
      "cli-import-demo",
    ],
    runtime,
  );

  assert.equal(exitCode, 1);
  assert.match(stderr.join("\n"), /Expected jest benchmark payload but parsed k6/);

  assert.equal(await countRows(cwd, "benchmark_projects"), 0);
});

test("CLI compare supports --baseline and --candidate without saving", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-compare-explicit-"));
  const baselinePath = join(cwd, "baseline.json");
  const candidatePath = join(cwd, "candidate.json");

  await writeFile(baselinePath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(candidatePath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  const baseline = await runJson(
    [
      "import",
      "--file",
      baselinePath,
      "--project",
      "cli-compare-demo",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const candidate = await runJson(
    [
      "import",
      "--file",
      candidatePath,
      "--project",
      "cli-compare-demo",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const { runtime, stdout, stderr } = createRuntime(cwd);

  assert.equal(
    await runCli(
      [
        "compare",
        "--baseline",
        baseline.runId,
        "--candidate",
        candidate.runId,
        "--no-save",
      ],
      runtime,
    ),
    0,
    stderr.join("\n"),
  );

  assert.equal(stdout[0], `Compared ${baseline.runId} vs ${candidate.runId}: 1 regressions, 1 improvements, 16 unchanged, 2 missing.`);
  assert.equal(stdout[1], "Comparison not saved.");
  assert.match(stdout[2], /Compared 20 metrics/);
  assert.equal(await countRows(cwd, "benchmark_comparisons"), 0);
});

test("CLI compare resolves --latest --previous by suite name and saves by default", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-compare-latest-"));
  const oldPath = join(cwd, "old.json");
  const previousPath = join(cwd, "previous.json");
  const latestPath = join(cwd, "latest.json");

  await writeFile(oldPath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(previousPath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(latestPath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  await runJson(
    [
      "import",
      "--file",
      oldPath,
      "--project",
      "cli-latest-demo",
      "--run-at",
      "2026-04-29T09:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const previous = await runJson(
    [
      "import",
      "--file",
      previousPath,
      "--project",
      "cli-latest-demo",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const latest = await runJson(
    [
      "import",
      "--file",
      latestPath,
      "--project",
      "cli-latest-demo",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const comparison = await runJson(
    [
      "compare",
      "--latest",
      "--previous",
      "--suite",
      "checkout-load-test",
      "--json",
    ],
    cwd,
  );

  assert.equal(comparison.saved, true);
  assert.equal(comparison.baselineRunId, previous.runId);
  assert.equal(comparison.candidateRunId, latest.runId);
  assert.ok(comparison.comparisonId);
  assert.equal(comparison.summary.regressions, 1);
  assert.equal(comparison.summary.improvements, 1);
  assert.equal(await countRows(cwd, "benchmark_comparisons"), 1);
});

test("CLI compare validates comparison target mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-compare-invalid-"));
  const { runtime, stderr } = createRuntime(cwd);

  assert.equal(await runCli(["compare", "--latest", "--suite", "checkout-load-test"], runtime), 1);
  assert.match(stderr.join("\n"), /Use --latest and --previous together/);
});

test("CLI report renders terminal text, markdown, and JSON for a comparison id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-report-"));
  const comparison = await createSavedComparison(cwd);

  const text = createRuntime(cwd);
  assert.equal(
    await runCli(["report", "--comparison", comparison.comparisonId], text.runtime),
    0,
    text.stderr.join("\n"),
  );
  assert.equal(text.stdout[0], `Comparison ${comparison.comparisonId}`);
  assert.match(text.stdout[1], /Compared 20 metrics/);
  assert.match(text.stdout[1], /Regressions: http_req_duration p95 regressed/);
  assert.equal(
    text.stdout[2],
    "Summary: 1 regressions, 1 improvements, 16 unchanged, 2 missing.",
  );

  const markdown = createRuntime(cwd);
  assert.equal(
    await runCli(
      ["report", "--comparison-id", comparison.comparisonId, "--format", "markdown"],
      markdown.runtime,
    ),
    0,
    markdown.stderr.join("\n"),
  );
  assert.equal(markdown.stdout.length, 1);
  assert.match(markdown.stdout[0], new RegExp(`^# Comparison ${comparison.comparisonId}`));
  assert.match(markdown.stdout[0], /## Regressions/);
  assert.match(markdown.stdout[0], /- http_req_duration p95 ms:/);
  assert.match(markdown.stdout[0], /## Missing Metrics/);

  const json = await runJson(
    ["report", comparison.comparisonId, "--format", "json"],
    cwd,
  );
  assert.equal(json.format, "json");
  assert.equal(json.comparison.id, comparison.comparisonId);
  assert.match(json.summaryText, /Compared 20 metrics/);
  assert.equal(json.groupedFindings.regressed.length, 1);
  assert.equal(json.groupedFindings.improved.length, 1);
  assert.equal(json.groupedFindings.missing.length, 2);
});

test("CLI report validates format and missing comparison id", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "bra-cli-report-invalid-"));
  const comparison = await createSavedComparison(cwd);
  const badFormat = createRuntime(cwd);

  assert.equal(
    await runCli(
      ["report", "--comparison-id", comparison.comparisonId, "--format", "html"],
      badFormat.runtime,
    ),
    1,
  );
  assert.match(
    badFormat.stderr.join("\n"),
    /Unsupported report format "html". Use text, markdown, or json./,
  );

  const missing = createRuntime(cwd);
  assert.equal(await runCli(["report", "--comparison-id", "9999"], missing.runtime), 1);
  assert.match(missing.stderr.join("\n"), /Comparison "9999" was not found/);
});

async function runJson(argv, cwd) {
  const { runtime, stdout, stderr } = createRuntime(cwd);
  const exitCode = await runCli(argv, runtime);

  assert.equal(exitCode, 0, stderr.join("\n"));
  assert.equal(stdout.length, 1);
  return JSON.parse(stdout[0]);
}

async function createSavedComparison(cwd) {
  const baselinePath = join(cwd, "baseline.json");
  const candidatePath = join(cwd, "candidate.json");

  await writeFile(baselinePath, JSON.stringify(k6Fixture), "utf8");
  await writeFile(candidatePath, JSON.stringify(candidateFixture(k6Fixture)), "utf8");

  const baseline = await runJson(
    [
      "import",
      "--file",
      baselinePath,
      "--project",
      "cli-report-demo",
      "--run-at",
      "2026-04-29T10:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );
  const candidate = await runJson(
    [
      "import",
      "--file",
      candidatePath,
      "--project",
      "cli-report-demo",
      "--run-at",
      "2026-04-29T11:00:00.000Z",
      "--no-git",
      "--json",
    ],
    cwd,
  );

  return runJson(
    [
      "compare",
      "--baseline",
      baseline.runId,
      "--candidate",
      candidate.runId,
      "--json",
    ],
    cwd,
  );
}

function createRuntime(cwd, overrides = {}) {
  const stdout = [];
  const stderr = [];

  return {
    stdout,
    stderr,
    runtime: {
      cwd,
      env: {},
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      ...overrides,
    },
  };
}

async function openCliDatabase(cwd) {
  return openSqliteDatabase(join(cwd, ".benchmark-analyzer/runs.db"));
}

async function countRows(cwd, tableName) {
  const database = await openCliDatabase(cwd);

  try {
    return countSqliteRows(database, tableName);
  } finally {
    database.close();
  }
}

function candidateFixture(input) {
  const candidate = JSON.parse(JSON.stringify(input));
  candidate.metrics.http_req_duration.values["p(95)"] = 640.625;
  candidate.metrics.http_reqs.values.rate = 27.5;
  delete candidate.metrics.data_sent;
  return candidate;
}
