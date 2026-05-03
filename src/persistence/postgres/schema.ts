import type { PgQueryable } from "./types.js";

export const POSTGRES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS benchmark_projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  metadata_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS benchmark_suites (
  id BIGSERIAL PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES benchmark_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('k6', 'jest')),
  scenario_name TEXT NULL,
  tags_json JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS benchmark_suites_lookup_idx
  ON benchmark_suites (project_id, name, source_type, scenario_name);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id BIGSERIAL PRIMARY KEY,
  suite_id BIGINT NOT NULL REFERENCES benchmark_suites(id) ON DELETE CASCADE,
  label TEXT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('k6', 'jest')),
  source_filename TEXT NOT NULL,
  commit_sha TEXT NULL,
  branch_name TEXT NULL,
  environment TEXT NULL,
  run_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER NULL,
  metadata_json JSONB NULL,
  raw_file_path TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS benchmark_runs_suite_id_idx
  ON benchmark_runs (suite_id);

CREATE TABLE IF NOT EXISTS benchmark_metrics (
  id BIGSERIAL PRIMARY KEY,
  run_id BIGINT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_group TEXT NOT NULL,
  unit TEXT NOT NULL,
  aggregation_type TEXT NOT NULL,
  value_numeric DOUBLE PRECISION NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lower_is_better', 'higher_is_better', 'neutral')),
  metadata_json JSONB NULL
);

CREATE INDEX IF NOT EXISTS benchmark_metrics_run_id_idx
  ON benchmark_metrics (run_id);

CREATE INDEX IF NOT EXISTS benchmark_metrics_identity_idx
  ON benchmark_metrics (run_id, metric_name, aggregation_type, unit);

CREATE TABLE IF NOT EXISTS benchmark_comparisons (
  id BIGSERIAL PRIMARY KEY,
  suite_id BIGINT NOT NULL REFERENCES benchmark_suites(id) ON DELETE CASCADE,
  baseline_run_id BIGINT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  candidate_run_id BIGINT NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  label TEXT NULL,
  threshold_rules_json JSONB NULL,
  summary_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS benchmark_comparisons_suite_id_idx
  ON benchmark_comparisons (suite_id);

CREATE INDEX IF NOT EXISTS benchmark_comparisons_runs_idx
  ON benchmark_comparisons (baseline_run_id, candidate_run_id);

CREATE TABLE IF NOT EXISTS benchmark_comparison_findings (
  id BIGSERIAL PRIMARY KEY,
  comparison_id BIGINT NOT NULL REFERENCES benchmark_comparisons(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_group TEXT NOT NULL,
  aggregation_type TEXT NOT NULL,
  unit TEXT NOT NULL,
  baseline_value DOUBLE PRECISION NULL,
  candidate_value DOUBLE PRECISION NULL,
  delta_absolute DOUBLE PRECISION NULL,
  delta_percent DOUBLE PRECISION NULL,
  status TEXT NOT NULL CHECK (status IN ('improved', 'regressed', 'unchanged', 'missing')),
  severity TEXT NOT NULL CHECK (severity IN ('none', 'low', 'medium', 'high')),
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS benchmark_comparison_findings_comparison_id_idx
  ON benchmark_comparison_findings (comparison_id);

CREATE INDEX IF NOT EXISTS benchmark_comparison_findings_status_idx
  ON benchmark_comparison_findings (comparison_id, status, severity);
`;

export async function applyPostgresSchema(database: PgQueryable): Promise<void> {
  const statements = POSTGRES_SCHEMA_SQL.split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    await database.query(statement);
  }
}
