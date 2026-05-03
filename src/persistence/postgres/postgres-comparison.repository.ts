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
  jsonParam,
  requiredInsertedId,
  timestampToIsoString,
  withOptionalTransaction,
  type IdRow,
} from "./helpers.js";
import type { PgPoolLike, PgQueryable } from "./types.js";

interface ComparisonRow {
  id: string | number;
  suite_id: string | number;
  baseline_run_id: string | number;
  candidate_run_id: string | number;
  label: string | null;
  threshold_rules_json: unknown;
  summary_json: unknown;
  created_at: Date | string;
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

export class PostgresComparisonRepository implements ComparisonRepository {
  constructor(private readonly database: PgPoolLike) {}

  async persistComparison(input: PersistComparisonInput): Promise<PersistedComparisonRecord> {
    return withOptionalTransaction(this.database, async (client) => {
      const comparisonId = await this.insertComparison(client, input);
      const findingIds = await this.insertFindings(client, comparisonId, input.findings);

      return {
        comparisonId,
        findingIds,
        findingsInserted: findingIds.length,
      };
    });
  }

  async getComparisonWithFindings(
    comparisonId: string,
  ): Promise<PersistedComparisonReadModel | undefined> {
    const comparisonResult = await this.database.query<ComparisonRow>(
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
      WHERE id = $1
      `,
      [comparisonId],
    );
    const comparisonRow = comparisonResult.rows[0];

    if (comparisonRow === undefined) {
      return undefined;
    }

    const findingsResult = await this.database.query<FindingRow>(
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
      WHERE comparison_id = $1
      ORDER BY metric_name, aggregation_type, unit, id
      `,
      [comparisonId],
    );

    return mapComparisonRow(comparisonRow, findingsResult.rows);
  }

  private async insertComparison(
    client: PgQueryable,
    input: PersistComparisonInput,
  ): Promise<string> {
    const inserted = await client.query<IdRow>(
      `
      INSERT INTO benchmark_comparisons (
        suite_id,
        baseline_run_id,
        candidate_run_id,
        label,
        threshold_rules_json,
        summary_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      RETURNING id
      `,
      [
        input.suiteId,
        input.baselineRunId,
        input.candidateRunId,
        input.label ?? null,
        jsonParam(input.thresholdRules),
        JSON.stringify(input.summary),
      ],
    );

    return requiredInsertedId(inserted.rows[0], "comparison");
  }

  private async insertFindings(
    client: PgQueryable,
    comparisonId: string,
    findings: ComparisonFinding[],
  ): Promise<string[]> {
    const findingIds: string[] = [];

    for (const finding of findings) {
      const inserted = await client.query<IdRow>(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id
        `,
        [
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
        ],
      );

      findingIds.push(requiredInsertedId(inserted.rows[0], "comparison finding"));
    }

    return findingIds;
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

function parseMaybeJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? JSON.parse(value) : value;
}

function nullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === "number" ? value : Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
