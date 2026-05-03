import { readFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";

import type { PgPoolLike } from "../persistence/postgres/index.js";
import {
  SOURCE_TYPES,
  compareRuns,
  createDefaultParserRegistry,
  generateComparisonReportSummary,
  type SourceType,
  type ThresholdRule,
} from "../core/index.js";
import { PostgresComparisonRepository } from "../persistence/postgres/postgres-comparison.repository.js";
import { PostgresRunRepository } from "../persistence/postgres/postgres-run.repository.js";
import { applyPostgresSchema } from "../persistence/postgres/schema.js";
import {
  openSqliteDatabase,
  SqliteComparisonRepository,
  SqliteRunRepository,
} from "../persistence/sqlite/index.js";
import { RunIngestionService } from "../runs/run-ingestion.service.js";
import {
  PersistedComparisonService,
  toComparisonRunInput,
} from "../comparisons/persisted-comparison.service.js";
import type { ComparisonRepository } from "../persistence/comparison-repository.js";
import type {
  RunRepository,
  SuiteDetailReadModel,
  SuiteHistoryMetricSelector,
  SuiteHistoryReadModel,
  SuiteRunListItem,
} from "../persistence/run-repository.js";
import {
  getRequiredStringOption,
  getStringOption,
  getStringOptions,
  hasOption,
  parseCliArgs,
  type ParsedCliArgs,
} from "./args.js";
import {
  DEFAULT_SQLITE_STORAGE_PATH,
  loadConfig,
  writeInitialConfig,
  type BenchmarkAnalyzerConfig,
  type WriteInitialConfigInput,
} from "./config.js";
import { CliError } from "./errors.js";
import {
  formatComparisonSummary,
  formatMarkdownReport,
  formatNumber,
  groupFindings,
  metricSelectorKey,
  pointMetricKey,
} from "./format.js";
import { collectGitMetadata, type ExecFile } from "./git.js";

export interface CliDatabase extends PgPoolLike {
  end?: () => Promise<void>;
}

interface CliStorage {
  runRepository: RunRepository;
  comparisonRepository: ComparisonRepository;
  close: () => Promise<void>;
}

export interface CliRuntime {
  cwd: string;
  env: Record<string, string | undefined>;
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  database?: CliDatabase;
  createDatabase?: (connectionString: string) => CliDatabase;
  execFile?: ExecFile;
}

export async function runCli(argv: string[], runtime: CliRuntime): Promise<number> {
  try {
    const args = parseCliArgs(argv);

    if (args.command === undefined || hasOption(args, "help")) {
      runtime.stdout(helpText(args.command));
      return 0;
    }

    switch (args.command) {
      case "init":
        await runInit(args, runtime);
        return 0;
      case "import":
        await runImport(args, runtime);
        return 0;
      case "compare":
        await runCompare(args, runtime);
        return 0;
      case "report":
        await runReport(args, runtime);
        return 0;
      case "history":
        await runHistory(args, runtime);
        return 0;
      default:
        throw new CliError(`Unknown command "${args.command}". Run with --help for usage.`);
    }
  } catch (error) {
    if (error instanceof CliError) {
      runtime.stderr(error.message);
      return error.exitCode;
    }

    runtime.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function runInit(args: ParsedCliArgs, runtime: CliRuntime): Promise<void> {
  const input: WriteInitialConfigInput = {
    force: hasOption(args, "force"),
  };
  const explicitPath = getStringOption(args, "config");
  const projectName = getStringOption(args, "project");
  const projectDescription = getStringOption(args, "project-description");
  const storageType = parseStorageType(getStringOption(args, "storage"));
  const sqlitePath = getStringOption(args, "sqlite-path");
  const databaseUrlEnv = getStringOption(args, "database-url-env");
  const metadataDefaults = parseMetadataOptions(getStringOptions(args, "metadata"));
  const thresholdRules = await loadThresholdRulesFileOption(args, runtime);

  if (explicitPath !== undefined) {
    input.explicitPath = explicitPath;
  }

  if (projectName !== undefined) {
    input.projectName = projectName;
  }

  if (projectDescription !== undefined) {
    input.projectDescription = projectDescription;
  }

  if (storageType !== undefined) {
    input.storageType = storageType;
  }

  if (sqlitePath !== undefined) {
    input.sqlitePath = sqlitePath;
  }

  if (databaseUrlEnv !== undefined) {
    input.databaseUrlEnv = databaseUrlEnv;
  }

  if (Object.keys(metadataDefaults).length > 0) {
    input.metadataDefaults = metadataDefaults;
  }

  if (thresholdRules !== undefined) {
    input.thresholdRules = thresholdRules;
  }

  const configPath = await writeInitialConfig(runtime.cwd, input);

  runtime.stdout(`Initialized Benchmark Results Analyzer config: ${configPath}`);
}

async function runImport(args: ParsedCliArgs, runtime: CliRuntime): Promise<void> {
  const config = await loadCommandConfig(args, runtime);
  const fileInput = getRequiredStringOption(args, "file", args.positionals[0]);
  const filePath = resolve(runtime.cwd, fileInput);
  const sourceType = parseSourceType(getStringOption(args, "source"));
  const content = await readFile(filePath, "utf8");
  const gitMetadata = shouldCollectGitMetadata(args)
    ? await collectGitMetadata(runtime.cwd, runtime.execFile)
    : {};
  const storage = await openStorage(runtime, config);

  try {
    const service = new RunIngestionService(
      createDefaultParserRegistry(),
      storage.runRepository,
    );
    const artifact = {
      filename: basename(filePath),
      content,
      rawFilePath: relative(runtime.cwd, filePath),
    };
    const project = buildProjectInput(args, config);
    const suite = buildSuiteInput(args);

    Object.assign(artifact, { run: buildRunInput(args, config, gitMetadata) });

    if (project !== undefined) {
      Object.assign(artifact, { project });
    }

    if (suite !== undefined) {
      Object.assign(artifact, { suite });
    }

    if (sourceType !== undefined) {
      Object.assign(artifact, { expectedSourceType: sourceType });
    }

    const result = await service.ingestBenchmarkArtifact(artifact);

    if (hasOption(args, "json")) {
      runtime.stdout(
        stableJson({
          projectId: result.persistedRun.projectId,
          suiteId: result.persistedRun.suiteId,
          runId: result.persistedRun.runId,
          sourceType: result.parsedRun.sourceType,
          metricsInserted: result.persistedRun.metricsInserted,
        }),
      );
      return;
    }

    runtime.stdout(
      `Imported ${result.parsedRun.sourceType} run ${result.persistedRun.runId} into suite ${result.persistedRun.suiteId} (${result.persistedRun.metricsInserted} metrics).`,
    );
  } finally {
    await storage.close();
  }
}

async function runCompare(args: ParsedCliArgs, runtime: CliRuntime): Promise<void> {
  const config = await loadCommandConfig(args, runtime);
  const thresholdRules = await loadThresholdRules(args, runtime, config);
  const storage = await openStorage(runtime, config);

  try {
    const runRepository = storage.runRepository;
    const { baselineRunId, candidateRunId } = await resolveCompareRunIds(args, runRepository);

    if (hasOption(args, "no-save")) {
      const result = await compareWithoutPersisting(
        runRepository,
        baselineRunId,
        candidateRunId,
        thresholdRules,
      );

      if (hasOption(args, "json")) {
        runtime.stdout(
          stableJson({
            saved: false,
            baselineRunId,
            candidateRunId,
            ...result,
          }),
        );
        return;
      }

      runtime.stdout(
        `Compared ${baselineRunId} vs ${candidateRunId}: ${formatComparisonSummary(
          result.summary,
        )}.`,
      );
      runtime.stdout("Comparison not saved.");
      runtime.stdout(result.reportSummary);
      return;
    }

    const service = new PersistedComparisonService(
      runRepository,
      storage.comparisonRepository,
    );
    const input = {
      baselineRunId,
      candidateRunId,
    };
    const label = getStringOption(args, "label");

    if (label !== undefined) {
      Object.assign(input, { label });
    }

    if (thresholdRules !== undefined) {
      Object.assign(input, { thresholdRules });
    }

    const result = await service.compareAndPersist(input);

    if (hasOption(args, "json")) {
      runtime.stdout(stableJson({ saved: true, ...result }));
      return;
    }

    runtime.stdout(
      `Compared ${baselineRunId} vs ${candidateRunId}: ${formatComparisonSummary(
        result.summary,
      )}.`,
    );
    runtime.stdout(`Saved comparison ${result.comparisonId}.`);
    runtime.stdout(result.reportSummary);
  } finally {
    await storage.close();
  }
}

async function runReport(args: ParsedCliArgs, runtime: CliRuntime): Promise<void> {
  const config = await loadCommandConfig(args, runtime);
  const comparisonId = getRequiredStringOption(
    args,
    "comparison-id",
    getStringOption(args, "comparison") ?? args.positionals[0],
  );
  const format = getStringOption(args, "format") ?? (hasOption(args, "json") ? "json" : "text");
  const storage = await openStorage(runtime, config);

  try {
    const comparison = await storage.comparisonRepository.getComparisonWithFindings(comparisonId);

    if (comparison === undefined) {
      throw new CliError(`Comparison "${comparisonId}" was not found`);
    }

    const summaryText = generateComparisonReportSummary({
      summary: comparison.summary,
      findings: comparison.findings,
    });
    const groupedFindings = groupFindings(comparison.findings);

    if (format === "json") {
      runtime.stdout(
        stableJson({
          format: "json",
          comparison,
          summaryText,
          groupedFindings,
        }),
      );
      return;
    }

    if (format === "markdown") {
      runtime.stdout(formatMarkdownReport(comparison, summaryText));
      return;
    }

    if (format !== "text") {
      throw new CliError(`Unsupported report format "${format}". Use text, markdown, or json.`);
    }

    runtime.stdout(`Comparison ${comparison.id}`);
    runtime.stdout(summaryText);
    runtime.stdout(`Summary: ${formatComparisonSummary(comparison.summary)}.`);
  } finally {
    await storage.close();
  }
}

async function runHistory(args: ParsedCliArgs, runtime: CliRuntime): Promise<void> {
  const config = await loadCommandConfig(args, runtime);
  const storage = await openStorage(runtime, config);

  try {
    const runRepository = storage.runRepository;
    const suiteId = await resolveHistorySuiteId(args, runRepository);
    const detail = await runRepository.getSuiteDetail(suiteId);

    if (detail === undefined) {
      throw new CliError(`Suite "${suiteId}" was not found`);
    }

    const explicitMetrics = getStringOptions(args, "metric").map(parseMetricSelector);
    const metrics =
      explicitMetrics.length > 0 ? explicitMetrics : selectDefaultHistoryMetrics(detail);
    const filters = buildHistoryFilters(args);
    const recentLimit = parsePositiveIntegerOption(args, "limit", 5);
    const recentRuns = filterRecentRuns(detail.runs, filters).slice(0, recentLimit);
    const history =
      metrics.length === 0
        ? undefined
        : await runRepository.getSuiteHistory({
            suiteId,
            metrics,
            ...filters,
          });

    if (metrics.length > 0 && history === undefined) {
      throw new CliError(`Suite "${suiteId}" was not found`);
    }

    const series = buildHistorySeries(metrics, history);

    if (hasOption(args, "json")) {
      runtime.stdout(
        stableJson({
          suite: detail.suite,
          project: detail.project,
          filters,
          recentRuns,
          series,
        }),
      );
      return;
    }

    printHistoryText(runtime, detail, recentRuns, series);
  } finally {
    await storage.close();
  }
}

async function loadCommandConfig(
  args: ParsedCliArgs,
  runtime: CliRuntime,
): Promise<BenchmarkAnalyzerConfig> {
  return loadConfig(runtime.cwd, getStringOption(args, "config"));
}

async function openStorage(
  runtime: CliRuntime,
  config: BenchmarkAnalyzerConfig,
): Promise<CliStorage> {
  if (runtime.database !== undefined) {
    await applyPostgresSchema(runtime.database);
    return {
      runRepository: new PostgresRunRepository(runtime.database),
      comparisonRepository: new PostgresComparisonRepository(runtime.database),
      close: async () => {},
    };
  }

  const storage = config.storage ?? {
    type: "sqlite" as const,
    path: DEFAULT_SQLITE_STORAGE_PATH,
  };

  if (storage.type === "sqlite") {
    const database = await openSqliteDatabase(resolve(runtime.cwd, storage.path));

    return {
      runRepository: new SqliteRunRepository(database),
      comparisonRepository: new SqliteComparisonRepository(database),
      close: async () => {
        database.close();
      },
    };
  }

  const envName = storage.databaseUrlEnv;
  const connectionString = runtime.env[envName];

  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new CliError(
      `${envName} is required for Postgres storage. Run "benchmark-analyzer init" to create local config, or use SQLite storage.`,
    );
  }

  if (runtime.createDatabase === undefined) {
    throw new CliError("CLI database factory is not configured");
  }

  const database = runtime.createDatabase(connectionString);
  await applyPostgresSchema(database);

  return {
    runRepository: new PostgresRunRepository(database),
    comparisonRepository: new PostgresComparisonRepository(database),
    close: async () => {
      await database.end?.();
    },
  };
}

function buildProjectInput(
  args: ParsedCliArgs,
  config: BenchmarkAnalyzerConfig,
): { name: string; description?: string } | undefined {
  const name = getStringOption(args, "project") ?? config.projectName;

  if (name === undefined) {
    return undefined;
  }

  const project: { name: string; description?: string } = { name };
  const description = getStringOption(args, "project-description") ?? config.projectDescription;

  if (description !== undefined) {
    project.description = description;
  }

  return project;
}

function buildSuiteInput(
  args: ParsedCliArgs,
): { name?: string; scenarioName?: string } | undefined {
  const name = getStringOption(args, "suite");
  const scenarioName = getStringOption(args, "scenario");

  if (name === undefined && scenarioName === undefined) {
    return undefined;
  }

  const suite: { name?: string; scenarioName?: string } = {};

  if (name !== undefined) {
    suite.name = name;
  }

  if (scenarioName !== undefined) {
    suite.scenarioName = scenarioName;
  }

  return suite;
}

function buildRunInput(
  args: ParsedCliArgs,
  config: BenchmarkAnalyzerConfig,
  gitMetadata: { branchName?: string; commitSha?: string },
): {
  label?: string;
  commitSha?: string;
  branchName?: string;
  environment?: string;
  runAt?: string;
  metadata?: Record<string, unknown>;
} {
  const run: {
    label?: string;
    commitSha?: string;
    branchName?: string;
    environment?: string;
    runAt?: string;
    metadata?: Record<string, unknown>;
  } = {};
  const label = getStringOption(args, "label");
  const commitSha = getStringOption(args, "commit") ?? gitMetadata.commitSha;
  const branchName = getStringOption(args, "branch") ?? gitMetadata.branchName;
  const environment = getStringOption(args, "environment");
  const runAt = getStringOption(args, "run-at");
  const metadata = {
    ...(config.metadataDefaults ?? {}),
    ...parseMetadataOptions(getStringOptions(args, "metadata")),
  };

  if (label !== undefined) {
    run.label = label;
  }

  if (commitSha !== undefined) {
    run.commitSha = commitSha;
  }

  if (branchName !== undefined) {
    run.branchName = branchName;
  }

  if (environment !== undefined) {
    run.environment = environment;
  }

  if (runAt !== undefined) {
    run.runAt = runAt;
  }

  if (Object.keys(metadata).length > 0) {
    run.metadata = metadata;
  }

  return run;
}

async function resolveCompareRunIds(
  args: ParsedCliArgs,
  runRepository: RunRepository,
): Promise<{ baselineRunId: string; candidateRunId: string }> {
  const explicitBaselineRunId =
    getStringOption(args, "baseline") ?? getStringOption(args, "baseline-run-id");
  const explicitCandidateRunId =
    getStringOption(args, "candidate") ?? getStringOption(args, "candidate-run-id");
  const wantsLatestPrevious =
    hasOption(args, "latest") || hasOption(args, "previous") || getStringOption(args, "suite") !== undefined;
  const hasExplicitRunIds =
    explicitBaselineRunId !== undefined || explicitCandidateRunId !== undefined;

  if (hasExplicitRunIds && wantsLatestPrevious) {
    throw new CliError(
      "Use either --baseline/--candidate or --latest --previous --suite, not both.",
    );
  }

  if (hasExplicitRunIds) {
    if (explicitBaselineRunId === undefined || explicitCandidateRunId === undefined) {
      throw new CliError("Both --baseline and --candidate are required for explicit comparison.");
    }

    return {
      baselineRunId: explicitBaselineRunId,
      candidateRunId: explicitCandidateRunId,
    };
  }

  if (wantsLatestPrevious) {
    if (!hasOption(args, "latest") || !hasOption(args, "previous")) {
      throw new CliError("Use --latest and --previous together with --suite <name>.");
    }

    const suiteName = getRequiredStringOption(args, "suite");
    const suite = await resolveSuiteByName(runRepository, suiteName);
    const detail = await runRepository.getSuiteDetail(suite.id);

    if (detail === undefined) {
      throw new CliError(`Suite "${suiteName}" was not found`);
    }

    if (detail.runs.length < 2) {
      throw new CliError(
        `Suite "${suiteName}" needs at least two runs for --latest --previous comparison.`,
      );
    }

    const latest = detail.runs[0];
    const previous = detail.runs[1];

    if (latest === undefined || previous === undefined) {
      throw new CliError(
        `Suite "${suiteName}" needs at least two runs for --latest --previous comparison.`,
      );
    }

    return {
      baselineRunId: previous.id,
      candidateRunId: latest.id,
    };
  }

  throw new CliError(
    "Missing comparison target. Use --baseline <id> --candidate <id> or --latest --previous --suite <name>.",
  );
}

async function resolveSuiteByName(
  runRepository: RunRepository,
  suiteName: string,
): Promise<{ id: string; name: string }> {
  const matches = (await runRepository.listSuites()).filter((suite) => suite.name === suiteName);

  if (matches.length === 0) {
    throw new CliError(`Suite "${suiteName}" was not found`);
  }

  if (matches.length > 1) {
    throw new CliError(
      `Suite name "${suiteName}" is ambiguous. Use --baseline and --candidate run ids instead.`,
    );
  }

  const match = matches[0];

  if (match === undefined) {
    throw new CliError(`Suite "${suiteName}" was not found`);
  }

  return {
    id: match.id,
    name: match.name,
  };
}

async function resolveHistorySuiteId(
  args: ParsedCliArgs,
  runRepository: RunRepository,
): Promise<string> {
  const suiteId = getStringOption(args, "suite-id") ?? args.positionals[0];
  const suiteName = getStringOption(args, "suite");

  if (suiteId !== undefined && suiteName !== undefined) {
    throw new CliError("Use either --suite-id or --suite, not both.");
  }

  if (suiteName !== undefined) {
    return (await resolveSuiteByName(runRepository, suiteName)).id;
  }

  if (suiteId !== undefined && suiteId.trim().length > 0) {
    return suiteId;
  }

  throw new CliError("Missing required option --suite-id or --suite");
}

function buildHistoryFilters(args: ParsedCliArgs): {
  environment?: string;
  branchName?: string;
  sourceType?: SourceType;
} {
  const filters: {
    environment?: string;
    branchName?: string;
    sourceType?: SourceType;
  } = {};
  const environment = getStringOption(args, "environment");
  const branchName = getStringOption(args, "branch");
  const sourceType = parseSourceType(getStringOption(args, "source"));

  if (environment !== undefined) {
    filters.environment = environment;
  }

  if (branchName !== undefined) {
    filters.branchName = branchName;
  }

  if (sourceType !== undefined) {
    filters.sourceType = sourceType;
  }

  return filters;
}

function filterRecentRuns(
  runs: SuiteRunListItem[],
  filters: {
    environment?: string;
    branchName?: string;
    sourceType?: SourceType;
  },
): SuiteRunListItem[] {
  return runs.filter((run) => {
    if (filters.environment !== undefined && run.environment !== filters.environment) {
      return false;
    }

    if (filters.branchName !== undefined && run.branchName !== filters.branchName) {
      return false;
    }

    if (filters.sourceType !== undefined && run.sourceType !== filters.sourceType) {
      return false;
    }

    return true;
  });
}

function selectDefaultHistoryMetrics(
  detail: SuiteDetailReadModel,
): SuiteHistoryMetricSelector[] {
  const available = new Map(
    detail.metricKeys.map((metric) => [
      metricSelectorKey(metric),
      {
        metricName: metric.metricName,
        aggregationType: metric.aggregationType,
        unit: metric.unit,
      },
    ]),
  );
  const priority: SuiteHistoryMetricSelector[] = [
    { metricName: "http_req_duration", aggregationType: "p95", unit: "ms" },
    { metricName: "http_req_duration", aggregationType: "p99", unit: "ms" },
    { metricName: "http_req_failed", aggregationType: "rate", unit: "percent" },
    { metricName: "http_reqs", aggregationType: "rate", unit: "rps" },
    { metricName: "iterations", aggregationType: "rate", unit: "iterations_per_second" },
    { metricName: "tests_failed", aggregationType: "count", unit: "count" },
    { metricName: "tests_passed", aggregationType: "count", unit: "count" },
    { metricName: "duration_total", aggregationType: "total", unit: "ms" },
    { metricName: "test_suites_failed", aggregationType: "count", unit: "count" },
  ];
  const selected: SuiteHistoryMetricSelector[] = [];

  for (const metric of priority) {
    const availableMetric = available.get(metricSelectorKey(metric));

    if (availableMetric !== undefined) {
      selected.push(availableMetric);
    }

    if (selected.length >= 4) {
      return selected;
    }
  }

  for (const metric of available.values()) {
    const alreadySelected = selected.some(
      (selectedMetric) => metricSelectorKey(selectedMetric) === metricSelectorKey(metric),
    );

    if (!alreadySelected) {
      selected.push(metric);
    }

    if (selected.length >= 3) {
      break;
    }
  }

  return selected;
}

function buildHistorySeries(
  metrics: SuiteHistoryMetricSelector[],
  history: SuiteHistoryReadModel | undefined,
) {
  return metrics.map((metric) => {
    const key = metricSelectorKey(metric);
    return {
      metric,
      points: (history?.points ?? [])
        .filter((point) => pointMetricKey(point) === key)
        .map((point) => ({
          runId: point.runId,
          runLabel: point.runLabel,
          runAt: point.runAt,
          branchName: point.branchName,
          environment: point.environment,
          valueNumeric: point.valueNumeric,
        })),
    };
  });
}

function printHistoryText(
  runtime: CliRuntime,
  detail: SuiteDetailReadModel,
  recentRuns: SuiteRunListItem[],
  series: ReturnType<typeof buildHistorySeries>,
): void {
  runtime.stdout(`Suite ${detail.suite.id} ${detail.suite.name}`);
  runtime.stdout(`Recent runs (${recentRuns.length} shown):`);

  if (recentRuns.length === 0) {
    runtime.stdout("- no matching runs");
  } else {
    for (const run of recentRuns) {
      runtime.stdout(formatRecentRun(run));
    }
  }

  runtime.stdout("Key metric trends:");

  if (series.length === 0) {
    runtime.stdout("- no metric keys available");
    return;
  }

  for (const item of series) {
    runtime.stdout(formatTrendLine(item));
  }
}

function formatRecentRun(run: SuiteRunListItem): string {
  const label = run.label ?? "(unlabeled)";
  const details = [
    run.branchName === undefined ? undefined : `branch ${run.branchName}`,
    run.environment === undefined ? undefined : `env ${run.environment}`,
  ].filter((value): value is string => value !== undefined);
  const detailText = details.length === 0 ? "" : `, ${details.join(", ")}`;

  return `- run ${run.id} ${label} ${run.runAt}${detailText} (${run.metricCount} metrics)`;
}

function formatTrendLine(
  item: ReturnType<typeof buildHistorySeries>[number],
): string {
  const label = `${item.metric.metricName} ${item.metric.aggregationType} ${item.metric.unit}`;

  if (item.points.length === 0) {
    return `- ${label}: no points`;
  }

  const first = item.points[0];
  const last = item.points.at(-1);

  if (first === undefined || last === undefined || first.runId === last.runId) {
    const only = first ?? last;
    const pointText = item.points.length === 1 ? "point" : "points";

    return `- ${label}: ${
      only === undefined ? "no points" : formatNumber(only.valueNumeric)
    } (${item.points.length} ${pointText})`;
  }

  const delta = last.valueNumeric - first.valueNumeric;
  return `- ${label}: ${formatNumber(first.valueNumeric)} -> ${formatNumber(
    last.valueNumeric,
  )} (${formatSignedNumber(delta)}, ${item.points.length} points)`;
}

function formatSignedNumber(value: number): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value)}`;
}

async function compareWithoutPersisting(
  runRepository: RunRepository,
  baselineRunId: string,
  candidateRunId: string,
  thresholdRules: ThresholdRule[] | undefined,
) {
  const baseline = await runRepository.getRunWithMetrics(baselineRunId);

  if (baseline === undefined) {
    throw new CliError(`Baseline run "${baselineRunId}" was not found`);
  }

  const candidate = await runRepository.getRunWithMetrics(candidateRunId);

  if (candidate === undefined) {
    throw new CliError(`Candidate run "${candidateRunId}" was not found`);
  }

  if (baseline.suite.id !== candidate.suite.id) {
    throw new CliError("Cannot compare runs from different suites");
  }

  return compareRuns(
    toComparisonRunInput(baseline),
    toComparisonRunInput(candidate),
    thresholdRules === undefined ? {} : { thresholdRules },
  );
}

function shouldCollectGitMetadata(args: ParsedCliArgs): boolean {
  return !hasOption(args, "no-git");
}

function parseMetadataOptions(values: string[]): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  for (const value of values) {
    const separatorIndex = value.indexOf("=");

    if (separatorIndex <= 0) {
      throw new CliError(`Invalid --metadata value "${value}". Use key=value.`);
    }

    metadata[value.slice(0, separatorIndex)] = value.slice(separatorIndex + 1);
  }

  return metadata;
}

function parseSourceType(value: string | undefined): SourceType | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!SOURCE_TYPES.includes(value as SourceType)) {
    throw new CliError(`Unsupported source type "${value}". Use one of: ${SOURCE_TYPES.join(", ")}.`);
  }

  return value as SourceType;
}

function parseStorageType(value: string | undefined): "sqlite" | "postgres" | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value !== "sqlite" && value !== "postgres") {
    throw new CliError('Unsupported storage type. Use "sqlite" or "postgres".');
  }

  return value;
}

async function loadThresholdRules(
  args: ParsedCliArgs,
  runtime: CliRuntime,
  config: BenchmarkAnalyzerConfig,
): Promise<ThresholdRule[] | undefined> {
  const thresholdPath = getStringOption(args, "thresholds");

  if (thresholdPath === undefined) {
    return config.thresholdRules;
  }

  return readThresholdRulesFile(runtime.cwd, thresholdPath);
}

async function loadThresholdRulesFileOption(
  args: ParsedCliArgs,
  runtime: CliRuntime,
): Promise<ThresholdRule[] | undefined> {
  const thresholdPath = getStringOption(args, "thresholds");
  return thresholdPath === undefined
    ? undefined
    : readThresholdRulesFile(runtime.cwd, thresholdPath);
}

async function readThresholdRulesFile(
  cwd: string,
  thresholdPath: string,
): Promise<ThresholdRule[]> {
  const raw = await readFile(resolve(cwd, thresholdPath), "utf8");
  const parsed = parseJson(raw, thresholdPath);

  if (!Array.isArray(parsed)) {
    throw new CliError(`Threshold file must contain a JSON array: ${thresholdPath}`);
  }

  return parsed as ThresholdRule[];
}

function parseMetricSelector(value: string): SuiteHistoryMetricSelector {
  const [metricName, aggregationType, unit, extra] = value.split(":");

  if (
    metricName === undefined ||
    aggregationType === undefined ||
    unit === undefined ||
    extra !== undefined ||
    metricName.length === 0 ||
    aggregationType.length === 0 ||
    unit.length === 0
  ) {
    throw new CliError(
      `Invalid metric selector "${value}". Use metricName:aggregationType:unit.`,
    );
  }

  return {
    metricName,
    aggregationType,
    unit,
  };
}

function parsePositiveIntegerOption(
  args: ParsedCliArgs,
  name: string,
  fallback: number,
): number {
  const raw = getStringOption(args, name);

  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CliError(`Option --${name} must be a positive integer`);
  }

  return parsed;
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in ${path}: ${detail}`);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function helpText(command?: string): string {
  if (command === "init") {
    return [
      "Usage: benchmark-analyzer init [--project name] [--config path] [--force]",
      "",
      "Options: --project-description, --storage sqlite|postgres, --sqlite-path path, --database-url-env, --thresholds thresholds.json, --metadata key=value",
      "",
      "Creates .benchmark-analyzer.json for local CLI defaults. SQLite is the default storage.",
    ].join("\n");
  }

  if (command === "import") {
    return [
      "Usage: benchmark-analyzer import --file results.json [options]",
      "",
      "Options: --project, --suite, --scenario, --label, --source, --environment, --branch, --commit, --run-at, --metadata key=value, --no-git, --json",
    ].join("\n");
  }

  if (command === "compare") {
    return [
      "Usage: benchmark-analyzer compare --baseline id --candidate id [options]",
      "",
      "       benchmark-analyzer compare --latest --previous --suite name [options]",
      "",
      "Options: --label, --thresholds thresholds.json, --no-save, --json",
    ].join("\n");
  }

  if (command === "report") {
    return [
      "Usage: benchmark-analyzer report --comparison-id id [--format text|markdown|json]",
      "",
      "       benchmark-analyzer report --comparison id [--format text|markdown|json]",
    ].join("\n");
  }

  if (command === "history") {
    return [
      "Usage: benchmark-analyzer history --suite-id id [--metric metricName:aggregationType:unit] [options]",
      "",
      "       benchmark-analyzer history --suite name [--metric metricName:aggregationType:unit] [options]",
      "",
      "Options: --environment, --branch, --source, --limit, --json",
    ].join("\n");
  }

  return [
    "Usage: benchmark-analyzer <command> [options]",
    "",
    "Commands:",
    "  init      Create local CLI config",
    "  import    Parse and persist one benchmark artifact",
    "  compare   Compare two persisted runs and store findings",
    "  report    Print a deterministic comparison report",
    "  history   Show suite runs or metric trends",
    "",
    "Run benchmark-analyzer <command> --help for command-specific options.",
  ].join("\n");
}
