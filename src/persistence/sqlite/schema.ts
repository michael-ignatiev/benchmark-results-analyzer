import type { Database as SqliteDatabase } from "better-sqlite3";

export const SQLITE_SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS benchmark_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NULL,
  metadata_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS benchmark_suites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES benchmark_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('k6', 'jest')),
  scenario_name TEXT NULL,
  tags_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS benchmark_suites_lookup_idx
  ON benchmark_suites (project_id, name, source_type, scenario_name);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL REFERENCES benchmark_suites(id) ON DELETE CASCADE,
  label TEXT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('k6', 'jest')),
  source_filename TEXT NOT NULL,
  commit_sha TEXT NULL,
  branch_name TEXT NULL,
  environment TEXT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NULL,
  metadata_json TEXT NULL,
  raw_file_path TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS benchmark_runs_suite_id_idx
  ON benchmark_runs (suite_id);

CREATE TABLE IF NOT EXISTS benchmark_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_group TEXT NOT NULL,
  unit TEXT NOT NULL,
  aggregation_type TEXT NOT NULL,
  value_numeric REAL NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('lower_is_better', 'higher_is_better', 'neutral')),
  metadata_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS benchmark_metrics_run_id_idx
  ON benchmark_metrics (run_id);

CREATE INDEX IF NOT EXISTS benchmark_metrics_identity_idx
  ON benchmark_metrics (run_id, metric_name, aggregation_type, unit);

CREATE TABLE IF NOT EXISTS benchmark_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  suite_id INTEGER NOT NULL REFERENCES benchmark_suites(id) ON DELETE CASCADE,
  baseline_run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  candidate_run_id INTEGER NOT NULL REFERENCES benchmark_runs(id) ON DELETE CASCADE,
  label TEXT NULL,
  threshold_rules_json TEXT NULL,
  summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS benchmark_comparisons_suite_id_idx
  ON benchmark_comparisons (suite_id);

CREATE INDEX IF NOT EXISTS benchmark_comparisons_runs_idx
  ON benchmark_comparisons (baseline_run_id, candidate_run_id);

CREATE TABLE IF NOT EXISTS benchmark_comparison_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  comparison_id INTEGER NOT NULL REFERENCES benchmark_comparisons(id) ON DELETE CASCADE,
  metric_name TEXT NOT NULL,
  metric_group TEXT NOT NULL,
  aggregation_type TEXT NOT NULL,
  unit TEXT NOT NULL,
  baseline_value REAL NULL,
  candidate_value REAL NULL,
  delta_absolute REAL NULL,
  delta_percent REAL NULL,
  status TEXT NOT NULL CHECK (status IN ('improved', 'regressed', 'unchanged', 'missing')),
  severity TEXT NOT NULL CHECK (severity IN ('none', 'low', 'medium', 'high')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS benchmark_comparison_findings_comparison_id_idx
  ON benchmark_comparison_findings (comparison_id);

CREATE INDEX IF NOT EXISTS benchmark_comparison_findings_status_idx
  ON benchmark_comparison_findings (comparison_id, status, severity);
`;

export function applySqliteSchema(database: SqliteDatabase): void {
  database.pragma("foreign_keys = ON");
  database.exec(SQLITE_SCHEMA_SQL);
}
