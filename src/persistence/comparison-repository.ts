import type {
  ComparisonFinding,
  ComparisonSummary,
  ThresholdRule,
} from "../comparisons/types.js";

export interface PersistComparisonInput {
  suiteId: string;
  baselineRunId: string;
  candidateRunId: string;
  label?: string;
  thresholdRules?: ThresholdRule[];
  summary: ComparisonSummary;
  findings: ComparisonFinding[];
}

export interface PersistedComparisonRecord {
  comparisonId: string;
  findingIds: string[];
  findingsInserted: number;
}

export interface PersistedComparisonFindingReadModel extends ComparisonFinding {
  id: string;
  comparisonId: string;
}

export interface PersistedComparisonReadModel {
  id: string;
  suiteId: string;
  baselineRunId: string;
  candidateRunId: string;
  label?: string;
  thresholdRules?: ThresholdRule[];
  summary: ComparisonSummary;
  createdAt: string;
  findings: PersistedComparisonFindingReadModel[];
}

export interface ComparisonRepository {
  persistComparison(input: PersistComparisonInput): Promise<PersistedComparisonRecord>;
  getComparisonWithFindings(
    comparisonId: string,
  ): Promise<PersistedComparisonReadModel | undefined>;
}
