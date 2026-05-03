import { ComparisonValidationError } from "./comparison-validation-error.js";
import { compareRuns } from "./comparison.service.js";
import type {
  ComparisonFinding,
  ComparisonRunInput,
  ComparisonSummary,
  ThresholdRule,
} from "./types.js";
import type {
  ComparisonRepository,
  PersistComparisonInput,
  PersistedComparisonReadModel,
} from "../persistence/comparison-repository.js";
import type {
  PersistedRunWithMetrics,
  RunRepository,
} from "../persistence/run-repository.js";
import type { ParsedRunPayload } from "../parsers/types.js";

export interface CreatePersistedComparisonInput {
  baselineRunId: string;
  candidateRunId: string;
  label?: string;
  thresholdRules?: ThresholdRule[];
}

export interface CreatePersistedComparisonResult {
  comparisonId: string;
  suiteId: string;
  baselineRunId: string;
  candidateRunId: string;
  label?: string;
  summary: ComparisonSummary;
  reportSummary: string;
  findings: ComparisonFinding[];
  findingIds: string[];
}

export class PersistedComparisonService {
  constructor(
    private readonly runRepository: RunRepository,
    private readonly comparisonRepository: ComparisonRepository,
  ) {}

  async compareAndPersist(
    input: CreatePersistedComparisonInput,
  ): Promise<CreatePersistedComparisonResult> {
    const baseline = await this.loadRun(input.baselineRunId, "baseline");
    const candidate = await this.loadRun(input.candidateRunId, "candidate");

    if (baseline.suite.id !== candidate.suite.id) {
      throw new ComparisonValidationError(
        "Cannot compare runs from different suites",
        "COMPARISON_SUITE_MISMATCH",
      );
    }

    const compareOptions = input.thresholdRules === undefined
      ? {}
      : { thresholdRules: input.thresholdRules };
    const comparison = compareRuns(
      toComparisonRunInput(baseline),
      toComparisonRunInput(candidate),
      compareOptions,
    );
    const persistInput: PersistComparisonInput = {
      suiteId: baseline.suite.id,
      baselineRunId: baseline.run.id,
      candidateRunId: candidate.run.id,
      summary: comparison.summary,
      findings: comparison.findings,
    };

    if (input.label !== undefined) {
      Object.assign(persistInput, { label: input.label });
    }

    if (input.thresholdRules !== undefined) {
      Object.assign(persistInput, { thresholdRules: input.thresholdRules });
    }

    const persisted = await this.comparisonRepository.persistComparison(persistInput);
    const result: CreatePersistedComparisonResult = {
      comparisonId: persisted.comparisonId,
      suiteId: baseline.suite.id,
      baselineRunId: baseline.run.id,
      candidateRunId: candidate.run.id,
      summary: comparison.summary,
      reportSummary: comparison.reportSummary,
      findings: comparison.findings,
      findingIds: persisted.findingIds,
    };

    if (input.label !== undefined) {
      result.label = input.label;
    }

    return result;
  }

  async getComparison(
    comparisonId: string,
  ): Promise<PersistedComparisonReadModel | undefined> {
    return this.comparisonRepository.getComparisonWithFindings(comparisonId);
  }

  private async loadRun(
    runId: string,
    role: "baseline" | "candidate",
  ): Promise<PersistedRunWithMetrics> {
    const run = await this.runRepository.getRunWithMetrics(runId);

    if (run === undefined) {
      throw new ComparisonValidationError(
        `${capitalize(role)} run "${runId}" was not found`,
        "COMPARISON_RUN_NOT_FOUND",
      );
    }

    return run;
  }
}

export function toComparisonRunInput(persisted: PersistedRunWithMetrics): ComparisonRunInput {
  return {
    sourceType: persisted.run.sourceType,
    suite: toParsedSuite(persisted),
    run: toParsedRun(persisted),
    metrics: persisted.metrics,
  };
}

function toParsedSuite(
  persisted: PersistedRunWithMetrics,
): ParsedRunPayload["suite"] {
  const suite: ParsedRunPayload["suite"] = {
    name: persisted.suite.name,
  };

  if (persisted.suite.scenarioName !== undefined) {
    suite.scenarioName = persisted.suite.scenarioName;
  }

  if (persisted.suite.tags !== undefined) {
    suite.tags = persisted.suite.tags;
  }

  return suite;
}

function toParsedRun(persisted: PersistedRunWithMetrics): ParsedRunPayload["run"] {
  const run: ParsedRunPayload["run"] = {
    runAt: persisted.run.runAt,
  };

  if (persisted.run.label !== undefined) {
    run.label = persisted.run.label;
  }

  if (persisted.run.commitSha !== undefined) {
    run.commitSha = persisted.run.commitSha;
  }

  if (persisted.run.branchName !== undefined) {
    run.branchName = persisted.run.branchName;
  }

  if (persisted.run.environment !== undefined) {
    run.environment = persisted.run.environment;
  }

  if (persisted.run.durationMs !== undefined) {
    run.durationMs = persisted.run.durationMs;
  }

  if (persisted.run.metadata !== undefined) {
    run.metadata = persisted.run.metadata;
  }

  return run;
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ""}${value.slice(1)}`;
}
