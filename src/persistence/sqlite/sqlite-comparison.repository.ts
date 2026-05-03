import type { Database as SqliteDatabase } from "better-sqlite3";

import type {
  ComparisonFinding,
  ComparisonStatus,
  ComparisonSummary,
  Severity,
  ThresholdRule,
} from "../../comparisons/types.js";
import type {
  ComparisonRepository,
  PersistComparisonInput,
  PersistedComparisonFindingReadModel,
  PersistedComparisonReadModel,
  PersistedComparisonRecord,
} from "../comparison-repository.js";
import {
  idToString,
  isRecord,
  jsonParam,
  lastInsertRowIdToString,
  nullableNumber,
  parseMaybeJson,
  timestampToIsoString,
} from "./helpers.js";

interface ComparisonRow {
  id: string | number;
  suite_id: string | number;
  baseline_run_id: string | number;
  candidate_run_id: string | number;
  label: string | null;
  threshold_rules_json: unknown;
  summary_json: unknown;
  created_at: string;
}

interface FindingRow {
  id: string | number;
  comparison_id: string | number;
  metric_name: string;
  metric_group: string;
  aggregation_type: string;
  unit: string;
  baseline_value: number | string | null;
  candidate_value: number | string | null;
  delta_absolute: number | string | null;
  delta_percent: number | string | null;
  status: ComparisonStatus;
  severity: Severity;
  reason: string;
}

export class SqliteComparisonRepository implements ComparisonRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async persistComparison(input: PersistComparisonInput): Promise<PersistedComparisonRecord> {
    const persist = this.database.transaction(() => {
      const comparisonId = this.insertComparison(input);
      const findingIds = this.insertFindings(comparisonId, input.findings);

      return {
        comparisonId,
        findingIds,
        findingsInserted: findingIds.length,
      };
    });

    return persist();
  }

  async getComparisonWithFindings(
    comparisonId: string,
  ): Promise<PersistedComparisonReadModel | undefined> {
    const comparisonRow = this.get<ComparisonRow>(
      `
      SELECT
        id,
        suite_id,
        baseline_run_id,
        candidate_run_id,
        label,
        threshold_rules_json,
        summary_json,
        created_at
      FROM benchmark_comparisons
      WHERE id = ?
      `,
      comparisonId,
    );

    if (comparisonRow === undefined) {
      return undefined;
    }

    const findingRows = this.all<FindingRow>(
      `
      SELECT
        id,
        comparison_id,
        metric_name,
        metric_group,
        aggregation_type,
        unit,
        baseline_value,
        candidate_value,
        delta_absolute,
        delta_percent,
        status,
        severity,
        reason
      FROM benchmark_comparison_findings
      WHERE comparison_id = ?
      ORDER BY metric_name, aggregation_type, unit, id
      `,
      comparisonId,
    );

    return mapComparisonRow(comparisonRow, findingRows);
  }

  private insertComparison(input: PersistComparisonInput): string {
    const inserted = this.run(
      `
      INSERT INTO benchmark_comparisons (
        suite_id,
        baseline_run_id,
        candidate_run_id,
        label,
        threshold_rules_json,
        summary_json
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.suiteId,
      input.baselineRunId,
      input.candidateRunId,
      input.label ?? null,
      jsonParam(input.thresholdRules),
      JSON.stringify(input.summary),
    );

    return lastInsertRowIdToString(inserted.lastInsertRowid);
  }

  private insertFindings(comparisonId: string, findings: ComparisonFinding[]): string[] {
    const findingIds: string[] = [];

    for (const finding of findings) {
      const inserted = this.run(
        `
        INSERT INTO benchmark_comparison_findings (
          comparison_id,
          metric_name,
          metric_group,
          aggregation_type,
          unit,
          baseline_value,
          candidate_value,
          delta_absolute,
          delta_percent,
          status,
          severity,
          reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        comparisonId,
        finding.metricName,
        finding.metricGroup,
        finding.aggregationType,
        finding.unit,
        finding.baselineValue,
        finding.candidateValue,
        finding.deltaAbsolute,
        finding.deltaPercent,
        finding.status,
        finding.severity,
        finding.reason,
      );

      findingIds.push(lastInsertRowIdToString(inserted.lastInsertRowid));
    }

    return findingIds;
  }

  private get<Row>(sql: string, ...params: unknown[]): Row | undefined {
    return this.database.prepare(sql).get(...params) as Row | undefined;
  }

  private all<Row>(sql: string, ...params: unknown[]): Row[] {
    return this.database.prepare(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: unknown[]) {
    return this.database.prepare(sql).run(...params);
  }
}

function mapComparisonRow(
  comparisonRow: ComparisonRow,
  findingRows: FindingRow[],
): PersistedComparisonReadModel {
  const comparison: PersistedComparisonReadModel = {
    id: idToString(comparisonRow.id),
    suiteId: idToString(comparisonRow.suite_id),
    baselineRunId: idToString(comparisonRow.baseline_run_id),
    candidateRunId: idToString(comparisonRow.candidate_run_id),
    summary: jsonSummary(comparisonRow.summary_json),
    createdAt: timestampToIsoString(comparisonRow.created_at),
    findings: findingRows.map(mapFindingRow),
  };
  const thresholdRules = jsonThresholdRules(comparisonRow.threshold_rules_json);

  if (comparisonRow.label !== null) {
    comparison.label = comparisonRow.label;
  }

  if (thresholdRules !== undefined) {
    comparison.thresholdRules = thresholdRules;
  }

  return comparison;
}

function mapFindingRow(row: FindingRow): PersistedComparisonFindingReadModel {
  return {
    id: idToString(row.id),
    comparisonId: idToString(row.comparison_id),
    metricName: row.metric_name,
    metricGroup: row.metric_group,
    aggregationType: row.aggregation_type,
    unit: row.unit,
    baselineValue: nullableNumber(row.baseline_value),
    candidateValue: nullableNumber(row.candidate_value),
    deltaAbsolute: nullableNumber(row.delta_absolute),
    deltaPercent: nullableNumber(row.delta_percent),
    status: row.status,
    severity: row.severity,
    reason: row.reason,
  };
}

function jsonSummary(value: unknown): ComparisonSummary {
  const parsed = parseMaybeJson(value);

  if (!isRecord(parsed)) {
    throw new Error("Stored comparison summary_json is not an object");
  }

  return parsed as unknown as ComparisonSummary;
}

function jsonThresholdRules(value: unknown): ThresholdRule[] | undefined {
  const parsed = parseMaybeJson(value);

  if (parsed === undefined) {
    return undefined;
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Stored comparison threshold_rules_json is not an array");
  }

  return parsed as ThresholdRule[];
}
