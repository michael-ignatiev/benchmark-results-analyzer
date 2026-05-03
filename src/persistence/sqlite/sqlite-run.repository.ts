import type { Database as SqliteDatabase } from "better-sqlite3";

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
  jsonRecord,
  lastInsertRowIdToString,
  timestampToIsoString,
  type IdRow,
} from "./helpers.js";

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
  run_at: string;
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
  latest_run_at: string | null;
}

interface SuiteListRow extends SuiteRow {
  project_name: string;
  project_description: string | null;
  project_metadata_json: unknown;
  run_count: number | string;
  latest_run_at: string | null;
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
  run_at: string;
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

export class SqliteRunRepository implements RunRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async persistParsedRun(input: PersistParsedRunInput): Promise<PersistedRunRecord> {
    const persist = this.database.transaction(() => {
      const projectId = this.findOrCreateProject(input);
      const suiteId = this.findOrCreateSuite(projectId, input);
      const runId = this.insertRun(suiteId, input);
      const metricIds = this.insertMetrics(runId, input.parsedRun.metrics);

      return {
        projectId,
        suiteId,
        runId,
        metricIds,
        metricsInserted: metricIds.length,
      };
    });

    return persist();
  }

  async getRunWithMetrics(runId: string): Promise<PersistedRunWithMetrics | undefined> {
    const runRow = this.get<RunRow>(
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
      WHERE id = ?
      `,
      runId,
    );

    if (runRow === undefined) {
      return undefined;
    }

    const suiteRow = this.get<SuiteRow>(
      `
      SELECT id, project_id, name, source_type, scenario_name, tags_json
      FROM benchmark_suites
      WHERE id = ?
      `,
      runRow.suite_id,
    );

    if (suiteRow === undefined) {
      return undefined;
    }

    const projectRow = this.get<ProjectRow>(
      `
      SELECT id, name, description, metadata_json
      FROM benchmark_projects
      WHERE id = ?
      `,
      suiteRow.project_id,
    );

    if (projectRow === undefined) {
      return undefined;
    }

    const metricRows = this.all<MetricRow>(
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
      WHERE run_id = ?
      ORDER BY metric_name, aggregation_type, unit, id
      `,
      runId,
    );

    return {
      project: mapProjectRow(projectRow),
      suite: mapSuiteRow(suiteRow),
      run: mapRunRow(runRow),
      metrics: metricRows.map(mapMetricRow),
    };
  }

  async listProjects(): Promise<ProjectListItem[]> {
    return this.all<ProjectListRow>(
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
    ).map(mapProjectListRow);
  }

  async listSuites(filters: SuiteListFilters = {}): Promise<SuiteListItem[]> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (filters.projectId !== undefined) {
      params.push(filters.projectId);
      whereClauses.push("s.project_id = ?");
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    return this.all<SuiteListRow>(
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
      ORDER BY run_counts.latest_run_at IS NULL ASC, run_counts.latest_run_at DESC, s.name ASC, s.id ASC
      `,
      ...params,
    ).map(mapSuiteListRow);
  }

  async getSuiteDetail(suiteId: string): Promise<SuiteDetailReadModel | undefined> {
    const suiteRow = this.get<SuiteListRow>(
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
      WHERE s.id = ?
      `,
      suiteId,
    );

    if (suiteRow === undefined) {
      return undefined;
    }

    const runRows = this.all<SuiteRunRow>(
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
      WHERE r.suite_id = ?
      GROUP BY r.id
      ORDER BY r.run_at DESC, r.id DESC
      `,
      suiteId,
    );
    const metricKeyRows = this.all<SuiteMetricKeyRow>(
      `
      SELECT DISTINCT
        m.metric_name,
        m.metric_group,
        m.aggregation_type,
        m.unit
      FROM benchmark_runs r
      JOIN benchmark_metrics m ON m.run_id = r.id
      WHERE r.suite_id = ?
      ORDER BY m.metric_group ASC, m.metric_name ASC, m.aggregation_type ASC, m.unit ASC
      `,
      suiteId,
    );

    return {
      project: mapProjectFromSuiteListRow(suiteRow),
      suite: mapSuiteRow(suiteRow),
      runs: runRows.map(mapSuiteRunRow),
      metricKeys: metricKeyRows.map(mapSuiteMetricKeyRow),
    };
  }

  async getSuiteHistory(query: SuiteHistoryQuery): Promise<SuiteHistoryReadModel | undefined> {
    const suiteRow = this.get<SuiteRow>(
      `
      SELECT id, project_id, name, source_type, scenario_name, tags_json
      FROM benchmark_suites
      WHERE id = ?
      `,
      query.suiteId,
    );

    if (suiteRow === undefined) {
      return undefined;
    }

    const historyRows = this.all<SuiteHistoryRow>(
      buildSuiteHistorySql(query),
      ...buildSuiteHistoryParams(query),
    );

    return {
      suite: mapSuiteRow(suiteRow),
      filters: compactSuiteHistoryFilters(query),
      metrics: query.metrics,
      points: historyRows.map(mapSuiteHistoryRow),
    };
  }

  private findOrCreateProject(input: PersistParsedRunInput): string {
    const projectName = input.project?.name ?? "default-project";
    const existing = this.get<IdRow>(
      `
      SELECT id
      FROM benchmark_projects
      WHERE name = ?
      LIMIT 1
      `,
      projectName,
    );

    if (existing !== undefined) {
      return idToString(existing.id);
    }

    const inserted = this.run(
      `
      INSERT INTO benchmark_projects (
        name,
        description,
        metadata_json
      )
      VALUES (?, ?, ?)
      `,
      projectName,
      input.project?.description ?? null,
      jsonParam(input.project?.metadata),
    );

    return lastInsertRowIdToString(inserted.lastInsertRowid);
  }

  private findOrCreateSuite(projectId: string, input: PersistParsedRunInput): string {
    const parsedRun = input.parsedRun;
    const scenarioName = parsedRun.suite.scenarioName ?? null;
    const existing = this.get<IdRow>(
      `
      SELECT id
      FROM benchmark_suites
      WHERE project_id = ?
        AND name = ?
        AND source_type = ?
        AND (
          (scenario_name IS NULL AND ? IS NULL)
          OR scenario_name = ?
        )
      ORDER BY id
      LIMIT 1
      `,
      projectId,
      parsedRun.suite.name,
      parsedRun.sourceType,
      scenarioName,
      scenarioName,
    );

    if (existing !== undefined) {
      return idToString(existing.id);
    }

    const inserted = this.run(
      `
      INSERT INTO benchmark_suites (
        project_id,
        name,
        source_type,
        scenario_name,
        tags_json
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      projectId,
      parsedRun.suite.name,
      parsedRun.sourceType,
      scenarioName,
      jsonParam(parsedRun.suite.tags),
    );

    return lastInsertRowIdToString(inserted.lastInsertRowid);
  }

  private insertRun(suiteId: string, input: PersistParsedRunInput): string {
    const parsedRun = input.parsedRun;
    const runAt = parsedRun.run.runAt ?? new Date().toISOString();
    const inserted = this.run(
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
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
    );

    return lastInsertRowIdToString(inserted.lastInsertRowid);
  }

  private insertMetrics(runId: string, metrics: CanonicalMetric[]): string[] {
    const metricIds: string[] = [];

    for (const metric of metrics) {
      const inserted = this.run(
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
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        runId,
        metric.metricName,
        metric.metricGroup,
        metric.unit,
        metric.aggregationType,
        metric.valueNumeric,
        metric.direction,
        jsonParam(metric.metadata),
      );

      metricIds.push(lastInsertRowIdToString(inserted.lastInsertRowid));
    }

    return metricIds;
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

function buildSuiteHistorySql(query: SuiteHistoryQuery): string {
  const whereClauses = ["r.suite_id = ?"];

  if (query.environment !== undefined) {
    whereClauses.push("r.environment = ?");
  }

  if (query.branchName !== undefined) {
    whereClauses.push("r.branch_name = ?");
  }

  if (query.sourceType !== undefined) {
    whereClauses.push("r.source_type = ?");
  }

  if (query.metrics.length > 0) {
    const metricClauses = query.metrics.map(
      () => "(m.metric_name = ? AND m.aggregation_type = ? AND m.unit = ?)",
    );
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
    run.durationMs = Number(row.duration_ms);
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

function mapSuiteMetricKeyRow(row: SuiteMetricKeyRow): SuiteMetricKey {
  return {
    metricName: row.metric_name,
    metricGroup: row.metric_group,
    aggregationType: row.aggregation_type,
    unit: row.unit,
  };
}
