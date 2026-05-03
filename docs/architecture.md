# Architecture

Benchmark Results Analyzer is a CLI-only npm package built around one invariant: source-specific benchmark artifacts must become the same canonical run model before persistence, comparison, history, or reporting.

## System Components

```text
npm package
  -> exposes benchmark-analyzer and bra binaries

CLI layer
  -> parses command arguments
  -> loads .benchmark-analyzer.json
  -> reads local artifact files
  -> captures explicit metadata and optional git metadata
  -> prints concise terminal, Markdown, or JSON output

Core parser layer
  -> detects supported artifact formats
  -> converts raw k6/Jest JSON into canonical run payloads

Run ingestion service
  -> applies CLI-provided artifact metadata
  -> persists project, suite, run, and metrics

Comparison engine
  -> compares canonical metrics
  -> applies direction and threshold rules
  -> classifies regressions, improvements, unchanged metrics, and missing metrics

Report generation
  -> builds deterministic summary text
  -> formats persisted comparisons for terminal, Markdown, and JSON output

Persistence adapters
  -> store projects, suites, runs, metrics, comparisons, and findings
  -> SQLite is the default CLI store
  -> PostgreSQL is optional for shared/server workflows
```

The CLI is the product surface. Core logic does not depend on terminal rendering, HTTP controllers, or UI code.

## CLI Flow

The intended local workflow is:

```text
benchmark-analyzer init
  -> create .benchmark-analyzer.json
  -> record project/storage/default metadata settings

benchmark-analyzer import --file results.json
  -> read artifact from disk
  -> parse source format
  -> normalize metrics
  -> persist run and metrics
  -> print run/suite IDs

benchmark-analyzer compare
  -> resolve explicit run IDs or latest/previous suite runs
  -> execute comparison engine
  -> optionally persist comparison and findings
  -> print concise summary

benchmark-analyzer report
  -> load persisted comparison
  -> print deterministic report as text, Markdown, or JSON

benchmark-analyzer history
  -> load recent suite runs
  -> print key metric trends
```

Each command is intentionally explicit. There are no hidden uploads, implicit remote calls, or generated narratives.

## Parser Flow

Import path:

```text
CLI reads file
  -> ParserRegistry.findParser(...)
  -> parser.parse(...)
  -> RunIngestionService.ingestBenchmarkArtifact(...)
  -> RunRepository.persistParsedRun(...)
```

Parser contract:

```ts
interface BenchmarkParser {
  canParse(input: unknown, filename?: string): boolean;
  parse(input: unknown, filename?: string): ParsedRunPayload;
}
```

`canParse` is conservative and only claims payloads it can safely parse. `parse` either returns a normalized payload or throws a structured parser validation error.

Supported parsers:

- `K6Parser`: reads k6 JSON summary metrics such as `http_req_duration`, `http_req_failed`, `http_reqs`, `iterations`, `vus`, and data counters.
- `JestParser`: reads Jest result counts and duration from explicit duration fields or test-result timing data.

## Normalization Flow

Raw input is normalized into `ParsedRunPayload`:

```ts
type ParsedRunPayload = {
  sourceType: "k6" | "jest";
  suite: {
    name: string;
    scenarioName?: string;
    tags?: Record<string, unknown>;
  };
  run: {
    label?: string;
    commitSha?: string;
    branchName?: string;
    environment?: string;
    runAt?: string;
    durationMs?: number;
    metadata?: Record<string, unknown>;
  };
  metrics: CanonicalMetric[];
};
```

Canonical metric:

```ts
type CanonicalMetric = {
  metricName: string;
  metricGroup: string;
  unit: string;
  aggregationType: string;
  valueNumeric: number;
  direction: "lower_is_better" | "higher_is_better" | "neutral";
  metadata?: Record<string, unknown>;
};
```

Normalization rules:

- names are stable source-level identifiers, such as `http_req_duration` or `tests_failed`
- groups make metrics scannable, such as `latency`, `throughput`, `reliability`, `tests`, and `duration`
- units are normalized, such as `ms`, `percent`, `count`, and `rps`
- aggregations are explicit, such as `avg`, `p95`, `rate`, `count`, and `total`
- direction captures comparison semantics before the comparison engine runs

This keeps downstream logic source-agnostic. Adding a source should mean adding a parser, not rewriting comparison or report code.

## Persistence Model

The persistence model is organized around durable analysis entities:

```text
benchmark_projects
  -> benchmark_suites
    -> benchmark_runs
      -> benchmark_metrics

benchmark_comparisons
  -> benchmark_comparison_findings
```

Design choices:

- projects namespace suites
- suites group comparable runs by project, source type, name, and scenario
- runs store source metadata, branch, environment, timestamp, duration, and raw artifact reference
- metrics are stored one row per canonical metric
- comparisons store baseline/candidate run IDs, threshold rules, and summary JSON
- findings store metric-level comparison results

The CLI uses `src/persistence/sqlite/*` by default and writes a local `.benchmark-analyzer/runs.db` file. The existing PostgreSQL adapter in `src/persistence/postgres/*` keeps the same repository contracts for shared databases or server/API usage. Both schemas should move to versioned migrations before production use.

## Comparison Engine

The comparison engine takes two canonical metric arrays. It does not depend on parser internals, raw artifact shape, CLI flags, or database row ordering.

Metric identity:

```text
metricName::aggregationType::unit
```

Comparison behavior:

- metrics are aligned by identity
- duplicate identities fail fast
- absolute delta is `candidate - baseline`
- percent delta is `((candidate - baseline) / baseline) * 100`
- baseline zero produces `null` percent delta
- direction determines whether a change is improved or regressed
- neutral metrics remain unchanged unless a threshold rule assigns status
- metrics present in only one run become explicit `missing` findings

Threshold rules can match exact metric names or wildcard patterns and can define warn, medium, and high boundaries for increases or decreases.

Examples:

- p95 latency regresses when it increases beyond tolerance
- throughput regresses when it decreases beyond tolerance
- failed tests regress when they increase from zero
- missing critical metrics can carry configured severity

The output is deterministic: summary counts plus ordered findings with status, severity, raw values, deltas, and reason text.

## Report Generation

Reports are generated from persisted comparison data:

```bash
benchmark-analyzer report --comparison <id> --format text
benchmark-analyzer report --comparison <id> --format markdown
benchmark-analyzer report --comparison <id> --format json
```

The report path returns:

- comparison metadata
- summary counts
- deterministic summary text
- grouped findings
- raw metric comparison data

The summary text is generated by `generateComparisonReportSummary`. It highlights regressions, improvements, unchanged critical metrics, and important missing metrics without using an LLM.

## CLI Responsibilities

The CLI owns workflow orchestration:

- config initialization
- local artifact reading
- source type selection or autodetection
- git metadata capture when available
- project/suite/run metadata collection
- command output formatting
- explicit error messages

The CLI does not own parser logic, comparison logic, threshold evaluation, or report summary generation. Those live in reusable services/core modules.

## Why CLI-Only For The MVP

CLI-only is the right MVP shape because benchmark artifacts already exist on disk after local runs or CI jobs.

Benefits:

- scriptable in local workflows and CI
- no browser form state or multipart transport concerns
- no premature artifact storage service
- direct fit for npm package distribution
- easy to test with fixtures, SQLite, and pg-mem
- clear interview story: artifacts in, deterministic findings out

This keeps complexity focused on the hard parts: normalization, metric identity, thresholding, missing metric handling, and deterministic reporting.

## Scaling Later

The design can scale without changing the core invariant:

- Add CI adapters that call the same ingestion service.
- Add object storage for raw artifacts and persist artifact URLs.
- Add a job queue for large imports or slow comparisons.
- Promote threshold rules to project/suite-level policies.
- Replace startup schema application with migrations for both SQLite and PostgreSQL.
- Add repeated-run baseline statistics and variance-aware comparison.
- Add parser plugins for custom benchmark formats.
- Add CLI-generated HTML/PDF reports if richer presentation is needed.

Source-specific complexity should still stop at the parser boundary.
