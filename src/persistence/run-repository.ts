import type { CanonicalMetric, ParsedRunPayload, SourceType } from "../parsers/types.js";

export interface PersistProjectInput {
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PersistParsedRunInput {
  parsedRun: ParsedRunPayload;
  project?: PersistProjectInput;
  sourceFilename: string;
  rawFilePath?: string;
}

export interface PersistedRunRecord {
  projectId: string;
  suiteId: string;
  runId: string;
  metricIds: string[];
  metricsInserted: number;
}

export interface PersistedProjectReadModel {
  id: string;
  name: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface PersistedSuiteReadModel {
  id: string;
  projectId: string;
  name: string;
  sourceType: SourceType;
  scenarioName?: string;
  tags?: Record<string, unknown>;
}

export interface PersistedRunReadModel {
  id: string;
  suiteId: string;
  sourceType: SourceType;
  sourceFilename: string;
  label?: string;
  commitSha?: string;
  branchName?: string;
  environment?: string;
  runAt: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
  rawFilePath?: string;
}

export interface PersistedMetricReadModel extends CanonicalMetric {
  id: string;
  runId: string;
}

export interface PersistedRunWithMetrics {
  project: PersistedProjectReadModel;
  suite: PersistedSuiteReadModel;
  run: PersistedRunReadModel;
  metrics: PersistedMetricReadModel[];
}

export interface ProjectListItem extends PersistedProjectReadModel {
  suiteCount: number;
  runCount: number;
  latestRunAt?: string;
}

export interface SuiteListFilters {
  projectId?: string;
}

export interface SuiteListItem extends PersistedSuiteReadModel {
  project: PersistedProjectReadModel;
  runCount: number;
  latestRunAt?: string;
}

export interface SuiteMetricKey {
  metricName: string;
  metricGroup: string;
  aggregationType: string;
  unit: string;
}

export interface SuiteRunListItem extends PersistedRunReadModel {
  metricCount: number;
}

export interface SuiteDetailReadModel {
  project: PersistedProjectReadModel;
  suite: PersistedSuiteReadModel;
  runs: SuiteRunListItem[];
  metricKeys: SuiteMetricKey[];
}

export interface SuiteHistoryMetricSelector {
  metricName: string;
  aggregationType: string;
  unit: string;
}

export interface SuiteHistoryFilters {
  environment?: string;
  branchName?: string;
  sourceType?: SourceType;
}

export interface SuiteHistoryQuery extends SuiteHistoryFilters {
  suiteId: string;
  metrics: SuiteHistoryMetricSelector[];
}

export interface SuiteHistoryMetricPoint {
  runId: string;
  runLabel?: string;
  runAt: string;
  branchName?: string;
  environment?: string;
  sourceType: SourceType;
  metricId: string;
  metricName: string;
  metricGroup: string;
  aggregationType: string;
  unit: string;
  valueNumeric: number;
}

export interface SuiteHistoryReadModel {
  suite: PersistedSuiteReadModel;
  filters: SuiteHistoryFilters;
  metrics: SuiteHistoryMetricSelector[];
  points: SuiteHistoryMetricPoint[];
}

export interface RunRepository {
  persistParsedRun(input: PersistParsedRunInput): Promise<PersistedRunRecord>;
  getRunWithMetrics(runId: string): Promise<PersistedRunWithMetrics | undefined>;
  listProjects(): Promise<ProjectListItem[]>;
  listSuites(filters?: SuiteListFilters): Promise<SuiteListItem[]>;
  getSuiteDetail(suiteId: string): Promise<SuiteDetailReadModel | undefined>;
  getSuiteHistory(query: SuiteHistoryQuery): Promise<SuiteHistoryReadModel | undefined>;
}
