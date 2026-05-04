#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PersistedComparisonService,
  RunIngestionService,
  SqliteComparisonRepository,
  SqliteRunRepository,
  createDefaultParserRegistry,
  openSqliteDatabase,
} from "../dist/index.js";

const parsedArgs = parseArgs(process.argv.slice(2));
const dryRun = parsedArgs.flags.has("--dry-run");
const resetDemo = parsedArgs.flags.has("--reset-demo") || parsedArgs.flags.has("--reset");
const sqlitePath = parsedArgs.options.get("--sqlite-path") ?? ".benchmark-analyzer/runs.db";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const backendDir = resolve(scriptDir, "..");
const rootDir = backendDir;
const fixturesDir = resolve(rootDir, "demo", "fixtures");
const manifestPath = resolve(fixturesDir, "manifest.json");

if (parsedArgs.flags.has("--help") || parsedArgs.flags.has("-h")) {
  printUsage();
  process.exit(0);
}

if (parsedArgs.unknown.length > 0) {
  console.error(`Unknown option: ${parsedArgs.unknown.join(", ")}`);
  printUsage();
  process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const manifest = validateManifest(await readJsonFile(manifestPath));
  const registry = createDefaultParserRegistry();
  const plannedRuns = await loadPlannedRuns(manifest, registry);

  validatePlannedComparisons(manifest, plannedRuns);

  if (dryRun) {
    printDryRun(manifest, plannedRuns);
    return;
  }

  const storage = await openStorage(sqlitePath);

  try {
    if (resetDemo) {
      const deleted = await storage.resetDemoProjects([manifest.project.name]);
      console.log(`Reset demo project "${manifest.project.name}" (${deleted} project row deleted).`);
    }

    const ingestionService = new RunIngestionService(registry, storage.runRepository);
    const comparisonService = new PersistedComparisonService(
      storage.runRepository,
      storage.comparisonRepository,
    );
    const importedRuns = new Map();
    const importedComparisons = [];

    for (const plannedRun of plannedRuns) {
      const result = await ingestionService.ingestBenchmarkArtifact({
        filename: basename(plannedRun.filePath),
        content: plannedRun.rawContent,
        project: manifest.project,
        rawFilePath: relative(rootDir, plannedRun.filePath),
        run: {
          metadata: {
            demoDataset: manifest.name,
            demoRunKey: plannedRun.key,
            demoDescription: plannedRun.description,
          },
        },
      });

      importedRuns.set(plannedRun.key, {
        ...plannedRun,
        projectId: result.persistedRun.projectId,
        suiteId: result.persistedRun.suiteId,
        runId: result.persistedRun.runId,
        metricsInserted: result.persistedRun.metricsInserted,
      });
    }

    for (const comparison of manifest.comparisons) {
      const baseline = importedRuns.get(comparison.baselineRunKey);
      const candidate = importedRuns.get(comparison.candidateRunKey);
      const result = await comparisonService.compareAndPersist({
        baselineRunId: baseline.runId,
        candidateRunId: candidate.runId,
        label: comparison.label,
        thresholdRules: comparison.thresholdRules,
      });

      importedComparisons.push({
        key: comparison.key,
        label: comparison.label,
        comparisonId: result.comparisonId,
        suiteId: result.suiteId,
        summary: result.summary,
        reportSummary: result.reportSummary,
      });
    }

    printImportResult(manifest, importedRuns, importedComparisons);
  } finally {
    await storage.close();
  }
}

async function openStorage(sqlitePath) {
  const database = await openSqliteDatabase(resolve(rootDir, sqlitePath));
  return {
    runRepository: new SqliteRunRepository(database),
    comparisonRepository: new SqliteComparisonRepository(database),
    resetDemoProjects: async (projectNames) => resetSqliteDemoProjects(database, projectNames),
    close: async () => {
      database.close();
    },
  };
}

async function readJsonFile(filePath) {
  const raw = await readFile(filePath, "utf8");

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${relative(rootDir, filePath)}: ${error.message}`);
  }
}

async function loadPlannedRuns(manifest, registry) {
  const plannedRuns = [];

  for (const run of manifest.runs) {
    const filePath = resolve(fixturesDir, run.file);
    const rawContent = await readFile(filePath, "utf8");
    const parsed = registry.parse(rawContent, basename(filePath));

    if (parsed.sourceType !== run.sourceType) {
      throw new Error(
        `Run "${run.key}" expected sourceType ${run.sourceType}, parsed ${parsed.sourceType}`,
      );
    }

    plannedRuns.push({
      key: run.key,
      description: run.description,
      sourceType: run.sourceType,
      file: run.file,
      filePath,
      rawContent,
      parsed,
    });
  }

  return plannedRuns;
}

function validateManifest(value) {
  if (!isRecord(value)) {
    throw new Error("Demo manifest must be a JSON object.");
  }

  const name = requiredString(value.name, "manifest.name");
  const project = validateProject(value.project);
  const runs = validateRuns(value.runs);
  const comparisons = validateComparisons(value.comparisons, runs);

  return {
    name,
    description: optionalString(value.description),
    project,
    runs,
    comparisons,
  };
}

function validateProject(value) {
  if (!isRecord(value)) {
    throw new Error("manifest.project must be an object.");
  }

  const project = {
    name: requiredString(value.name, "manifest.project.name"),
  };
  const description = optionalString(value.description);

  if (description !== undefined) {
    project.description = description;
  }

  if (isRecord(value.metadata)) {
    project.metadata = value.metadata;
  }

  return project;
}

function validateRuns(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("manifest.runs must be a non-empty array.");
  }

  const keys = new Set();

  return value.map((run, index) => {
    if (!isRecord(run)) {
      throw new Error(`manifest.runs[${index}] must be an object.`);
    }

    const key = requiredString(run.key, `manifest.runs[${index}].key`);

    if (keys.has(key)) {
      throw new Error(`Duplicate demo run key "${key}".`);
    }

    keys.add(key);

    return {
      key,
      sourceType: validateSourceType(run.sourceType, `manifest.runs[${index}].sourceType`),
      file: requiredString(run.file, `manifest.runs[${index}].file`),
      description: optionalString(run.description),
    };
  });
}

function validateComparisons(value, runs) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("manifest.comparisons must be a non-empty array.");
  }

  const runKeys = new Set(runs.map((run) => run.key));
  const comparisonKeys = new Set();

  return value.map((comparison, index) => {
    if (!isRecord(comparison)) {
      throw new Error(`manifest.comparisons[${index}] must be an object.`);
    }

    const key = requiredString(comparison.key, `manifest.comparisons[${index}].key`);

    if (comparisonKeys.has(key)) {
      throw new Error(`Duplicate demo comparison key "${key}".`);
    }

    comparisonKeys.add(key);

    const baselineRunKey = requiredString(
      comparison.baselineRunKey,
      `manifest.comparisons[${index}].baselineRunKey`,
    );
    const candidateRunKey = requiredString(
      comparison.candidateRunKey,
      `manifest.comparisons[${index}].candidateRunKey`,
    );

    if (!runKeys.has(baselineRunKey)) {
      throw new Error(`Comparison "${key}" references unknown baseline run "${baselineRunKey}".`);
    }

    if (!runKeys.has(candidateRunKey)) {
      throw new Error(`Comparison "${key}" references unknown candidate run "${candidateRunKey}".`);
    }

    return {
      key,
      label: optionalString(comparison.label),
      baselineRunKey,
      candidateRunKey,
      thresholdRules: validateThresholdRules(comparison.thresholdRules, key),
    };
  });
}

function validateThresholdRules(value, comparisonKey) {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(`Comparison "${comparisonKey}" thresholdRules must be an array.`);
  }

  return value;
}

function validatePlannedComparisons(manifest, plannedRuns) {
  const runsByKey = new Map(plannedRuns.map((run) => [run.key, run]));

  for (const comparison of manifest.comparisons) {
    const baseline = runsByKey.get(comparison.baselineRunKey);
    const candidate = runsByKey.get(comparison.candidateRunKey);

    if (suiteSignature(baseline.parsed) !== suiteSignature(candidate.parsed)) {
      throw new Error(
        `Comparison "${comparison.key}" must reference runs from the same parsed suite.`,
      );
    }
  }
}

async function resetSqliteDemoProjects(database, projectNames) {
  const statement = database.prepare("DELETE FROM benchmark_projects WHERE name = ?");
  let deleted = 0;

  for (const projectName of projectNames) {
    deleted += statement.run(projectName).changes;
  }

  return deleted;
}

function printDryRun(manifest, plannedRuns) {
  console.log(`Demo dataset "${manifest.name}" is valid.`);
  console.log(`Project: ${manifest.project.name}`);
  console.log(`Runs: ${plannedRuns.length}`);

  for (const run of plannedRuns) {
    console.log(
      `- ${run.key}: ${run.parsed.sourceType} ${run.parsed.suite.name} / ${run.parsed.run.label ?? "unlabeled"} (${run.parsed.metrics.length} metrics)`,
    );
  }

  console.log(`Comparisons: ${manifest.comparisons.length}`);

  for (const comparison of manifest.comparisons) {
    console.log(
      `- ${comparison.key}: ${comparison.baselineRunKey} -> ${comparison.candidateRunKey}`,
    );
  }
}

function printImportResult(manifest, importedRuns, importedComparisons) {
  console.log(`Imported demo dataset "${manifest.name}" into project "${manifest.project.name}".`);
  console.log("");
  console.log("Runs:");

  for (const run of importedRuns.values()) {
    console.log(
      `- ${run.key}: run ${run.runId}, suite ${run.suiteId}, ${run.metricsInserted} metrics`,
    );
  }

  console.log("");
  console.log("Comparisons:");

  for (const comparison of importedComparisons) {
    console.log(
      `- ${comparison.key}: comparison ${comparison.comparisonId} (${comparison.summary.regressions} regressions, ${comparison.summary.improvements} improvements, ${comparison.summary.missing} missing)`,
    );
    console.log(`  ${comparison.reportSummary}`);
  }

  const firstSuiteId = importedRuns.values().next().value?.suiteId;
  const firstComparisonId = importedComparisons[0]?.comparisonId;

  if (firstSuiteId !== undefined || firstComparisonId !== undefined) {
    console.log("");
    console.log("Useful CLI commands:");

    if (firstSuiteId !== undefined) {
      console.log(`- npm run cli -- history --suite-id ${firstSuiteId}`);
    }

    if (firstComparisonId !== undefined) {
      console.log(`- npm run cli -- report --comparison ${firstComparisonId} --format text`);
      console.log(`- npm run cli -- report --comparison ${firstComparisonId} --format markdown`);
    }
  }
}

function printUsage() {
  console.log(`Usage: node scripts/import-demo-dataset.mjs [--dry-run] [--reset-demo] [--sqlite-path path]

Options:
  --dry-run            Validate and summarize demo fixtures without writing storage.
  --reset-demo         Delete the demo project named in the manifest before importing.
  --sqlite-path path   SQLite database path relative to the package root.`);
}

function parseArgs(argv) {
  const knownFlags = new Set(["--dry-run", "--help", "-h", "--reset-demo", "--reset"]);
  const knownOptions = new Set(["--sqlite-path"]);
  const flags = new Set();
  const options = new Map();
  const unknown = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (knownFlags.has(arg)) {
      flags.add(arg);
      continue;
    }

    if (!knownOptions.has(arg)) {
      unknown.push(arg);
      continue;
    }

    const value = argv[index + 1];

    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${arg} requires a value.`);
    }

    options.set(arg, value);
    index += 1;
  }

  return { flags, options, unknown };
}

function suiteSignature(parsed) {
  return [
    parsed.sourceType,
    parsed.suite.name,
    parsed.suite.scenarioName ?? "",
  ].join("::");
}

function validateSourceType(value, label) {
  const sourceType = requiredString(value, label);

  if (!["k6", "jest"].includes(sourceType)) {
    throw new Error(`${label} must be one of k6 or jest.`);
  }

  return sourceType;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
