import type { CanonicalMetric, MetricDirection, SourceType } from "../../parsers/types.js";
import type {
  PersistParsedRunInput,
  PersistedMetricReadModel,
  PersistedProjectReadModel,
  PersistedRunReadModel,
  PersistedRunRecord,
  PersistedRunWithMetrics,
  PersistedSuiteReadModel,
  ProjectListItem,
  RunRepository,
  SuiteDetailReadModel,
  SuiteHistoryMetricPoint,
  SuiteHistoryQuery,
  SuiteHistoryReadModel,
  SuiteListFilters,
  SuiteListItem,
  SuiteMetricKey,
  SuiteRunListItem,
} from "../run-repository.js";
import {
  idToString,
  jsonParam,
  requiredInsertedId,
  timestampToIsoString,
  withOptionalTransaction,
  type IdRow,
} from "./helpers.js";
import type { PgPoolLike, PgQueryable } from "./types.js";

interface ProjectRow {
  id: string | number;
  name: string;
  description: string | null;
  metadata_json: unknown;
}

interface SuiteRow {
  id: string | number;
  project_id: string | number;
  name: string;
  source_type: SourceType;
  scenario_name: string | null;
  tags_json: unknown;
}

interface RunRow {
  id: string | number;
  suite_id: string | number;
  source_type: SourceType;
  source_filename: string;
  label: string | null;
  commit_sha: string | null;
  branch_name: string | null;
  environment: string | null;
  run_at: string | Date;
  duration_ms: number | null;
  metadata_json: unknown;
  raw_file_path: string | null;
}

interface MetricRow {
  id: string | number;
  run_id: string | number;
  metric_name: string;
  metric_group: string;
  unit: string;
  aggregation_type: string;
  value_numeric: number | string;
  direction: MetricDirection;
  metadata_json: unknown;
}

interface ProjectListRow extends ProjectRow {
  suite_count: number | string;
  run_count: number | string;
  latest_run_at: string | Date | null;
}

interface SuiteListRow extends SuiteRow {
  project_name: string;
  project_description: string | null;
  project_metadata_json: unknown;
  run_count: number | string;
  latest_run_at: string | Date | null;
}

interface SuiteRunRow extends RunRow {
  metric_count: number | string;
}

interface SuiteMetricKeyRow {
  metric_name: string;
  metric_group: string;
  aggregation_type: string;
  unit: string;
}

interface SuiteHistoryRow {
  run_id: string | number;
  run_label: string | null;
  run_at: string | Date;
  branch_name: string | null;
  environment: string | null;
  source_type: SourceType;
  metric_id: string | number;
  metric_name: string;
  metric_group: string;
  aggregation_type: string;
  unit: string;
  value_numeric: number | string;
}

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly database: PgPoolLike) {}

  async persistParsedRun(input: PersistParsedRunInput): Promise<PersistedRunRecord> {
    return withOptionalTransaction(this.database, async (client) => {
      const projectId = await this.findOrCreateProject(client, input);
      const suiteId = await this.findOrCreateSuite(client, projectId, input);
      const runId = await this.insertRun(client, suiteId, input);
      const metricIds = await this.insertMetrics(client, runId, input.parsedRun.metrics);

      return {
        projectId,
        suiteId,
        runId,
        metricIds,
        metricsInserted: metricIds.length,
      };
    });
  }

  async getRunWithMetrics(runId: string): Promise<PersistedRunWithMetrics | undefined> {
    const runResult = await this.database.query<RunRow>(
      `
      SELECT
        id,
        suite_id,
        source_type,
        source_filename,
        label,
        commit_sha,
        branch_name,
        environment,
        run_at,
        duration_ms,
        metadata_json,
        raw_file_path
      FROM benchmark_runs
      WHERE id = $1
      `,
      [runId],
    );
    const runRow = runResult.rows[0];

    if (runRow === undefined) {
      return undefined;
    }

    const suiteResult = await this.database.query<SuiteRow>(
      `
      SELECT id, project_id, name, source_type, scenario_name, tags_json
      FROM benchmark_suites
      WHERE id = $1
      `,
      [runRow.suite_id],
    );
    const suiteRow = suiteResult.rows[0];

    if (suiteRow === undefined) {
      return undefined;
    }

    const projectResult = await this.database.query<ProjectRow>(
      `
      SELECT id, name, description, metadata_json
      FROM benchmark_projects
      WHERE id = $1
      `,
      [suiteRow.project_id],
    );
    const projectRow = projectResult.rows[0];

    if (projectRow === undefined) {
      return undefined;
    }

    const metricsResult = await this.database.query<MetricRow>(
      `
      SELECT
        id,
        run_id,
        metric_name,
        metric_group,
        unit,
        aggregation_type,
        value_numeric,
        direction,
        metadata_json
      FROM benchmark_metrics
      WHERE run_id = $1
      ORDER BY metric_name, aggregation_type, unit, id
      `,
      [runId],
    );

    return {
      project: mapProjectRow(projectRow),
      suite: mapSuiteRow(suiteRow),
      run: mapRunRow(runRow),
      metrics: metricsResult.rows.map(mapMetricRow),
    };
  }

  async listProjects(): Promise<ProjectListItem[]> {
    const result = await this.database.query<ProjectListRow>(
      `
      SELECT
        p.id,
        p.name,
        p.description,
        p.metadata_json,
        COALESCE(suite_counts.suite_count, 0) AS suite_count,
        COALESCE(run_counts.run_count, 0) AS run_count,
        run_counts.latest_run_at
      FROM benchmark_projects p
      LEFT JOIN (
        SELECT project_id, COUNT(*) AS suite_count
        FROM benchmark_suites
        GROUP BY project_id
      ) suite_counts ON suite_counts.project_id = p.id
      LEFT JOIN (
        SELECT s.project_id, COUNT(r.id) AS run_count, MAX(r.run_at) AS latest_run_at
        FROM benchmark_suites s
        JOIN benchmark_runs r ON r.suite_id = s.id
        GROUP BY s.project_id
      ) run_counts ON run_counts.project_id = p.id
      ORDER BY p.name ASC, p.id ASC
      `,
    );

    return result.rows.map(mapProjectListRow);
  }

  async listSuites(filters: SuiteListFilters = {}): Promise<SuiteListItem[]> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (filters.projectId !== undefined) {
      params.push(filters.projectId);
      whereClauses.push(`s.project_id = $${params.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";
    const result = await this.database.query<SuiteListRow>(
      `
      SELECT
        s.id,
        s.project_id,
        s.name,
        s.source_type,
        s.scenario_name,
        s.tags_json,
        p.name AS project_name,
        p.description AS project_description,
        p.metadata_json AS project_metadata_json,
        COALESCE(run_counts.run_count, 0) AS run_count,
        run_counts.latest_run_at
      FROM benchmark_suites s
      JOIN benchmark_projects p ON p.id = s.project_id
      LEFT JOIN (
        SELECT suite_id, COUNT(*) AS run_count, MAX(run_at) AS latest_run_at
        FROM benchmark_runs
        GROUP BY suite_id
      ) run_counts ON run_counts.suite_id = s.id
      ${whereSql}
      ORDER BY run_counts.latest_run_at DESC NULLS LAST, s.name ASC, s.id ASC
      `,
      params,
    );

    return result.rows.map(mapSuiteListRow);
  }

  async getSuiteDetail(suiteId: string): Promise<SuiteDetailReadModel | undefined> {
    const suiteResult = await this.database.query<SuiteListRow>(
      `
      SELECT
        s.id,
        s.project_id,
        s.name,
        s.source_type,
        s.scenario_name,
        s.tags_json,
        p.name AS project_name,
        p.description AS project_description,
        p.metadata_json AS project_metadata_json,
        COALESCE(run_counts.run_count, 0) AS run_count,
        run_counts.latest_run_at
      FROM benchmark_suites s
      JOIN benchmark_projects p ON p.id = s.project_id
      LEFT JOIN (
        SELECT suite_id, COUNT(*) AS run_count, MAX(run_at) AS latest_run_at
        FROM benchmark_runs
        GROUP BY suite_id
      ) run_counts ON run_counts.suite_id = s.id
      WHERE s.id = $1
      `,
      [suiteId],
    );
    const suiteRow = suiteResult.rows[0];

    if (suiteRow === undefined) {
      return undefined;
    }

    const runsResult = await this.database.query<SuiteRunRow>(
      `
      SELECT
        r.id,
        r.suite_id,
        r.source_type,
        r.source_filename,
        r.label,
        r.commit_sha,
        r.branch_name,
        r.environment,
        r.run_at,
        r.duration_ms,
        r.metadata_json,
        r.raw_file_path,
        COUNT(m.id) AS metric_count
      FROM benchmark_runs r
      LEFT JOIN benchmark_metrics m ON m.run_id = r.id
      WHERE r.suite_id = $1
      GROUP BY
        r.id,
        r.suite_id,
        r.source_type,
        r.source_filename,
        r.label,
        r.commit_sha,
        r.branch_name,
        r.environment,
        r.run_at,
        r.duration_ms,
        r.metadata_json,
        r.raw_file_path
      ORDER BY r.run_at DESC, r.id DESC
      `,
      [suiteId],
    );
    const metricKeysResult = await this.database.query<SuiteMetricKeyRow>(
      `
      SELECT DISTINCT
        m.metric_name,
        m.metric_group,
        m.aggregation_type,
        m.unit
      FROM benchmark_runs r
      JOIN benchmark_metrics m ON m.run_id = r.id
      WHERE r.suite_id = $1
      ORDER BY m.metric_group ASC, m.metric_name ASC, m.aggregation_type ASC, m.unit ASC
      `,
      [suiteId],
    );

    return {
      project: mapProjectFromSuiteListRow(suiteRow),
      suite: mapSuiteRow(suiteRow),
      runs: runsResult.rows.map(mapSuiteRunRow),
      metricKeys: metricKeysResult.rows.map(mapSuiteMetricKeyRow),
    };
  }

  async getSuiteHistory(query: SuiteHistoryQuery): Promise<SuiteHistoryReadModel | undefined> {
    const suiteResult = await this.database.query<SuiteRow>(
      `
      SELECT id, project_id, name, source_type, scenario_name, tags_json
      FROM benchmark_suites
      WHERE id = $1
      `,
      [query.suiteId],
    );
    const suiteRow = suiteResult.rows[0];

    if (suiteRow === undefined) {
      return undefined;
    }

    const historyResult = await this.database.query<SuiteHistoryRow>(
      buildSuiteHistorySql(query),
      buildSuiteHistoryParams(query),
    );

    return {
      suite: mapSuiteRow(suiteRow),
      filters: compactSuiteHistoryFilters(query),
      metrics: query.metrics,
      points: historyResult.rows.map(mapSuiteHistoryRow),
    };
  }

  private async findOrCreateProject(
    client: PgQueryable,
    input: PersistParsedRunInput,
  ): Promise<string> {
    const projectName = input.project?.name ?? "default-project";
    const existing = await client.query<IdRow>(
      `
      SELECT id
      FROM benchmark_projects
      WHERE name = $1
      LIMIT 1
      `,
      [projectName],
    );
    const existingProject = existing.rows[0];

    if (existingProject !== undefined) {
      return idToString(existingProject.id);
    }

    const inserted = await client.query<IdRow>(
      `
      INSERT INTO benchmark_projects (
        name,
        description,
        metadata_json
      )
      VALUES ($1, $2, $3::jsonb)
      RETURNING id
      `,
      [
        projectName,
        input.project?.description ?? null,
        jsonParam(input.project?.metadata),
      ],
    );

    return requiredInsertedId(inserted.rows[0], "project");
  }

  private async findOrCreateSuite(
    client: PgQueryable,
    projectId: string,
    input: PersistParsedRunInput,
  ): Promise<string> {
    const parsedRun = input.parsedRun;
    const scenarioName = parsedRun.suite.scenarioName ?? null;
    const existing = await client.query<IdRow>(
      `
      SELECT id
      FROM benchmark_suites
      WHERE project_id = $1
        AND name = $2
        AND source_type = $3
        AND (
          (scenario_name IS NULL AND $4::text IS NULL)
          OR scenario_name = $4
        )
      ORDER BY id
      LIMIT 1
      `,
      [projectId, parsedRun.suite.name, parsedRun.sourceType, scenarioName],
    );
    const existingSuite = existing.rows[0];

    if (existingSuite !== undefined) {
      return idToString(existingSuite.id);
    }

    const inserted = await client.query<IdRow>(
      `
      INSERT INTO benchmark_suites (
        project_id,
        name,
        source_type,
        scenario_name,
        tags_json
      )
      VALUES ($1, $2, $3, $4, $5::jsonb)
      RETURNING id
      `,
      [
        projectId,
        parsedRun.suite.name,
        parsedRun.sourceType,
        scenarioName,
        jsonParam(parsedRun.suite.tags),
      ],
    );

    return requiredInsertedId(inserted.rows[0], "suite");
  }

  private async insertRun(
    client: PgQueryable,
    suiteId: string,
    input: PersistParsedRunInput,
  ): Promise<string> {
    const parsedRun = input.parsedRun;
    const runAt = parsedRun.run.runAt ?? new Date().toISOString();
    const inserted = await client.query<IdRow>(
      `
      INSERT INTO benchmark_runs (
        suite_id,
        label,
        source_type,
        source_filename,
        commit_sha,
        branch_name,
        environment,
        run_at,
        duration_ms,
        metadata_json,
        raw_file_path
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, $10::jsonb, $11)
      RETURNING id
      `,
      [
        suiteId,
        parsedRun.run.label ?? null,
        parsedRun.sourceType,
        input.sourceFilename,
        parsedRun.run.commitSha ?? null,
        parsedRun.run.branchName ?? null,
        parsedRun.run.environment ?? null,
        runAt,
        parsedRun.run.durationMs ?? null,
        jsonParam(parsedRun.run.metadata),
        input.rawFilePath ?? null,
      ],
    );

    return requiredInsertedId(inserted.rows[0], "run");
  }

  private async insertMetrics(
    client: PgQueryable,
    runId: string,
    metrics: CanonicalMetric[],
  ): Promise<string[]> {
    const metricIds: string[] = [];

    for (const metric of metrics) {
      const inserted = await client.query<IdRow>(
        `
        INSERT INTO benchmark_metrics (
          run_id,
          metric_name,
          metric_group,
          unit,
          aggregation_type,
          value_numeric,
          direction,
          metadata_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        RETURNING id
        `,
        [
          runId,
          metric.metricName,
          metric.metricGroup,
          metric.unit,
          metric.aggregationType,
          metric.valueNumeric,
          metric.direction,
          jsonParam(metric.metadata),
        ],
      );

      metricIds.push(requiredInsertedId(inserted.rows[0], "metric"));
    }

    return metricIds;
  }
}

function buildSuiteHistorySql(query: SuiteHistoryQuery): string {
  const whereClauses = ["r.suite_id = $1"];
  let nextParamIndex = 2;

  if (query.environment !== undefined) {
    whereClauses.push(`r.environment = $${nextParamIndex}`);
    nextParamIndex += 1;
  }

  if (query.branchName !== undefined) {
    whereClauses.push(`r.branch_name = $${nextParamIndex}`);
    nextParamIndex += 1;
  }

  if (query.sourceType !== undefined) {
    whereClauses.push(`r.source_type = $${nextParamIndex}`);
    nextParamIndex += 1;
  }

  if (query.metrics.length > 0) {
    const metricClauses = query.metrics.map(() => {
      const clause = `(m.metric_name = $${nextParamIndex} AND m.aggregation_type = $${
        nextParamIndex + 1
      } AND m.unit = $${nextParamIndex + 2})`;
      nextParamIndex += 3;
      return clause;
    });
    whereClauses.push(`(${metricClauses.join(" OR ")})`);
  }

  return `
    SELECT
      r.id AS run_id,
      r.label AS run_label,
      r.run_at,
      r.branch_name,
      r.environment,
      r.source_type,
      m.id AS metric_id,
      m.metric_name,
      m.metric_group,
      m.aggregation_type,
      m.unit,
      m.value_numeric
    FROM benchmark_runs r
    JOIN benchmark_metrics m ON m.run_id = r.id
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY r.run_at ASC, r.id ASC, m.metric_name ASC, m.aggregation_type ASC, m.unit ASC
  `;
}

function buildSuiteHistoryParams(query: SuiteHistoryQuery): unknown[] {
  const params: unknown[] = [query.suiteId];

  if (query.environment !== undefined) {
    params.push(query.environment);
  }

  if (query.branchName !== undefined) {
    params.push(query.branchName);
  }

  if (query.sourceType !== undefined) {
    params.push(query.sourceType);
  }

  for (const metric of query.metrics) {
    params.push(metric.metricName, metric.aggregationType, metric.unit);
  }

  return params;
}

function compactSuiteHistoryFilters(query: SuiteHistoryQuery): SuiteHistoryReadModel["filters"] {
  const filters: SuiteHistoryReadModel["filters"] = {};

  if (query.environment !== undefined) {
    filters.environment = query.environment;
  }

  if (query.branchName !== undefined) {
    filters.branchName = query.branchName;
  }

  if (query.sourceType !== undefined) {
    filters.sourceType = query.sourceType;
  }

  return filters;
}

function mapSuiteHistoryRow(row: SuiteHistoryRow): SuiteHistoryMetricPoint {
  const point: SuiteHistoryMetricPoint = {
    runId: idToString(row.run_id),
    runAt: timestampToIsoString(row.run_at),
    sourceType: row.source_type,
    metricId: idToString(row.metric_id),
    metricName: row.metric_name,
    metricGroup: row.metric_group,
    aggregationType: row.aggregation_type,
    unit: row.unit,
    valueNumeric:
      typeof row.value_numeric === "number" ? row.value_numeric : Number(row.value_numeric),
  };

  if (row.run_label !== null) {
    point.runLabel = row.run_label;
  }

  if (row.branch_name !== null) {
    point.branchName = row.branch_name;
  }

  if (row.environment !== null) {
    point.environment = row.environment;
  }

  return point;
}

function mapProjectRow(row: ProjectRow): PersistedProjectReadModel {
  const project: PersistedProjectReadModel = {
    id: idToString(row.id),
    name: row.name,
  };
  const metadata = jsonRecord(row.metadata_json);

  if (row.description !== null) {
    project.description = row.description;
  }

  if (metadata !== undefined) {
    project.metadata = metadata;
  }

  return project;
}

function mapProjectListRow(row: ProjectListRow): ProjectListItem {
  const project: ProjectListItem = {
    ...mapProjectRow(row),
    suiteCount: Number(row.suite_count),
    runCount: Number(row.run_count),
  };

  if (row.latest_run_at !== null) {
    project.latestRunAt = timestampToIsoString(row.latest_run_at);
  }

  return project;
}

function mapProjectFromSuiteListRow(row: SuiteListRow): PersistedProjectReadModel {
  const project: PersistedProjectReadModel = {
    id: idToString(row.project_id),
    name: row.project_name,
  };
  const metadata = jsonRecord(row.project_metadata_json);

  if (row.project_description !== null) {
    project.description = row.project_description;
  }

  if (metadata !== undefined) {
    project.metadata = metadata;
  }

  return project;
}

function mapSuiteRow(row: SuiteRow): PersistedSuiteReadModel {
  const suite: PersistedSuiteReadModel = {
    id: idToString(row.id),
    projectId: idToString(row.project_id),
    name: row.name,
    sourceType: row.source_type,
  };
  const tags = jsonRecord(row.tags_json);

  if (row.scenario_name !== null) {
    suite.scenarioName = row.scenario_name;
  }

  if (tags !== undefined) {
    suite.tags = tags;
  }

  return suite;
}

function mapSuiteListRow(row: SuiteListRow): SuiteListItem {
  const suite: SuiteListItem = {
    ...mapSuiteRow(row),
    project: mapProjectFromSuiteListRow(row),
    runCount: Number(row.run_count),
  };

  if (row.latest_run_at !== null) {
    suite.latestRunAt = timestampToIsoString(row.latest_run_at);
  }

  return suite;
}

function mapRunRow(row: RunRow): PersistedRunReadModel {
  const run: PersistedRunReadModel = {
    id: idToString(row.id),
    suiteId: idToString(row.suite_id),
    sourceType: row.source_type,
    sourceFilename: row.source_filename,
    runAt: timestampToIsoString(row.run_at),
  };
  const metadata = jsonRecord(row.metadata_json);

  if (row.label !== null) {
    run.label = row.label;
  }

  if (row.commit_sha !== null) {
    run.commitSha = row.commit_sha;
  }

  if (row.branch_name !== null) {
    run.branchName = row.branch_name;
  }

  if (row.environment !== null) {
    run.environment = row.environment;
  }

  if (row.duration_ms !== null) {
    run.durationMs = row.duration_ms;
  }

  if (metadata !== undefined) {
    run.metadata = metadata;
  }

  if (row.raw_file_path !== null) {
    run.rawFilePath = row.raw_file_path;
  }

  return run;
}

function mapSuiteRunRow(row: SuiteRunRow): SuiteRunListItem {
  return {
    ...mapRunRow(row),
    metricCount: Number(row.metric_count),
  };
}

function mapSuiteMetricKeyRow(row: SuiteMetricKeyRow): SuiteMetricKey {
  return {
    metricName: row.metric_name,
    metricGroup: row.metric_group,
    aggregationType: row.aggregation_type,
    unit: row.unit,
  };
}

function mapMetricRow(row: MetricRow): PersistedMetricReadModel {
  const metric: PersistedMetricReadModel = {
    id: idToString(row.id),
    runId: idToString(row.run_id),
    metricName: row.metric_name,
    metricGroup: row.metric_group,
    unit: row.unit,
    aggregationType: row.aggregation_type,
    valueNumeric:
      typeof row.value_numeric === "number" ? row.value_numeric : Number(row.value_numeric),
    direction: row.direction,
  };
  const metadata = jsonRecord(row.metadata_json);

  if (metadata !== undefined) {
    metric.metadata = metadata;
  }

  return metric;
}

function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  }

  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
