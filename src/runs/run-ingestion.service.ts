import type { ParserRegistry } from "../parsers/parser-registry.js";
import { ParserValidationError } from "../parsers/parser-validation-error.js";
import type { ParsedRunPayload, SourceType } from "../parsers/types.js";
import type {
  PersistParsedRunInput,
  PersistProjectInput,
  PersistedRunRecord,
  RunRepository,
} from "../persistence/run-repository.js";

export interface BenchmarkArtifactInput {
  filename: string;
  content: unknown;
  rawFilePath?: string;
  project?: PersistProjectInput;
  suite?: Partial<ParsedRunPayload["suite"]>;
  run?: Partial<ParsedRunPayload["run"]>;
  expectedSourceType?: SourceType;
}

export type UploadedBenchmarkFile = BenchmarkArtifactInput;

export interface RunIngestionResult {
  parsedRun: ParsedRunPayload;
  persistedRun: PersistedRunRecord;
}

export class RunIngestionService {
  constructor(
    private readonly parserRegistry: ParserRegistry,
    private readonly runRepository: RunRepository,
  ) {}

  async ingestBenchmarkArtifact(artifact: BenchmarkArtifactInput): Promise<RunIngestionResult> {
    const parsed = this.parserRegistry.parse(artifact.content, artifact.filename);

    if (
      artifact.expectedSourceType !== undefined &&
      parsed.sourceType !== artifact.expectedSourceType
    ) {
      throw new ParserValidationError(
        `Expected ${artifact.expectedSourceType} benchmark payload but parsed ${parsed.sourceType}`,
        { code: "PARSER_SOURCE_TYPE_MISMATCH" },
      );
    }

    const parsedRun = this.applyArtifactMetadata(parsed, artifact);
    const persistInput: PersistParsedRunInput = {
      parsedRun,
      sourceFilename: artifact.filename,
    };

    if (artifact.project !== undefined) {
      persistInput.project = artifact.project;
    }

    if (artifact.rawFilePath !== undefined) {
      persistInput.rawFilePath = artifact.rawFilePath;
    }

    const persistedRun = await this.runRepository.persistParsedRun(persistInput);

    return {
      parsedRun,
      persistedRun,
    };
  }

  async ingestUploadedBenchmarkFile(file: UploadedBenchmarkFile): Promise<RunIngestionResult> {
    return this.ingestBenchmarkArtifact(file);
  }

  private applyArtifactMetadata(
    parsedRun: ParsedRunPayload,
    artifact: BenchmarkArtifactInput,
  ): ParsedRunPayload {
    return {
      sourceType: parsedRun.sourceType,
      suite: mergeSuite(parsedRun.suite, artifact.suite),
      run: mergeRun(parsedRun.run, artifact.run),
      metrics: parsedRun.metrics,
    };
  }
}

function mergeSuite(
  parsedSuite: ParsedRunPayload["suite"],
  artifactSuite: Partial<ParsedRunPayload["suite"]> | undefined,
): ParsedRunPayload["suite"] {
  const suite: ParsedRunPayload["suite"] = { name: parsedSuite.name };

  if (parsedSuite.scenarioName !== undefined) {
    suite.scenarioName = parsedSuite.scenarioName;
  }

  if (parsedSuite.tags !== undefined) {
    suite.tags = parsedSuite.tags;
  }

  if (artifactSuite?.name !== undefined) {
    suite.name = artifactSuite.name;
  }

  if (artifactSuite?.scenarioName !== undefined) {
    suite.scenarioName = artifactSuite.scenarioName;
  }

  if (artifactSuite?.tags !== undefined) {
    suite.tags = artifactSuite.tags;
  }

  return suite;
}

function mergeRun(
  parsedRun: ParsedRunPayload["run"],
  artifactRun: Partial<ParsedRunPayload["run"]> | undefined,
): ParsedRunPayload["run"] {
  const run: ParsedRunPayload["run"] = {};
  const metadata = mergeMetadata(parsedRun.metadata, artifactRun?.metadata);

  assignString(run, "label", parsedRun.label);
  assignString(run, "commitSha", parsedRun.commitSha);
  assignString(run, "branchName", parsedRun.branchName);
  assignString(run, "environment", parsedRun.environment);
  assignString(run, "runAt", parsedRun.runAt);
  assignNumber(run, "durationMs", parsedRun.durationMs);

  assignString(run, "label", artifactRun?.label);
  assignString(run, "commitSha", artifactRun?.commitSha);
  assignString(run, "branchName", artifactRun?.branchName);
  assignString(run, "environment", artifactRun?.environment);
  assignString(run, "runAt", artifactRun?.runAt);
  assignNumber(run, "durationMs", artifactRun?.durationMs);

  if (metadata !== undefined) {
    run.metadata = metadata;
  }

  return run;
}

function assignString<T extends keyof ParsedRunPayload["run"]>(
  run: ParsedRunPayload["run"],
  key: T,
  value: ParsedRunPayload["run"][T],
): void {
  if (typeof value === "string") {
    run[key] = value;
  }
}

function assignNumber<T extends keyof ParsedRunPayload["run"]>(
  run: ParsedRunPayload["run"],
  key: T,
  value: ParsedRunPayload["run"][T],
): void {
  if (typeof value === "number") {
    run[key] = value;
  }
}

function mergeMetadata(
  parsedMetadata: Record<string, unknown> | undefined,
  artifactMetadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (parsedMetadata === undefined && artifactMetadata === undefined) {
    return undefined;
  }

  return {
    ...(parsedMetadata ?? {}),
    ...(artifactMetadata ?? {}),
  };
}
