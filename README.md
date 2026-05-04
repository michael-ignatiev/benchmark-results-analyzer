# Benchmark Results Analyzer

Benchmark Results Analyzer is a CLI-only npm package for importing k6/Jest result artifacts, normalizing them into canonical metrics, and producing deterministic benchmark comparisons.

## Why This Exists

Benchmark review is often harder than running the benchmark. k6 and Jest produce different JSON shapes, CI jobs store artifacts differently, and reviewers still need clear answers:

- Did this candidate run regress against the baseline?
- Which metrics changed enough to matter?
- Which important metrics are missing?
- What has the suite looked like over recent runs?
- Can the result be explained without opening raw JSON?

This project treats benchmark review as a local developer workflow: import artifacts from disk, store normalized runs, compare baseline and candidate runs, and print deterministic reports.

## Package Shape

The npm package exposes a CLI binary:

```bash
benchmark-analyzer <command> [options]
bra <command> [options]
```

In this repository, the same binary is available through:

```bash
npm run cli -- <command> [options]
```

Core commands:

- `init` creates `.benchmark-analyzer.json`
- `import` parses and persists one local artifact
- `compare` compares two runs or latest vs previous
- `report` renders terminal text, Markdown, or JSON
- `history` prints recent runs and selected metric trends

## Installation

Install directly from a GitHub repository whose root is this package:

```bash
npm install --save-dev git+ssh://git@github.com:<owner>/<repo>.git
```

Then run the CLI from the consuming project:

```bash
npx benchmark-analyzer --help
npx bra init --project "Benchmark Demo"
```

The Git install runs the package `prepare` script, which builds `dist/` from TypeScript. Node.js 20+ is required.

The reusable core APIs are also exported for ESM consumers:

```ts
import { compareRuns, createDefaultParserRegistry } from "benchmark-results-analyzer/core";
```

## Supported Input Sources

Current parsers:

- `k6` JSON summary exports
  - Latency trends, throughput counters, reliability rates, concurrency gauges, data volume, and iteration metrics.
- `jest` JSON output
  - Total/passed/failed tests, total/passed/failed suites, pending/todo counts, and total duration.

Example import:

```bash
npm run cli -- import \
  --file demo/fixtures/k6/checkout-main-2026-04-26.json \
  --project "Acme Commerce Demo" \
  --label checkout-main \
  --branch main \
  --environment staging \
  --no-git
```

## Architecture Overview

The package is structured around a reusable core with a thin CLI entrypoint:

```text
src/core/          Canonical model, parser registry, parsers, comparison engine, report summary logic
src/cli/           Commands, config loading, file handling, git metadata, terminal/report output
src/runs/          Artifact ingestion service
src/comparisons/   Persisted comparison orchestration
src/persistence/   SQLite storage repositories and schema setup
demo/fixtures/       Local demo artifacts
docs/                Architecture, rules, demo, and interview notes
```

Main workflow:

```text
benchmark-analyzer import
  -> read local artifact
  -> parse k6/Jest through parser registry
  -> normalize into ParsedRunPayload
  -> persist project, suite, run, and canonical metrics to local SQLite by default

benchmark-analyzer compare
  -> load baseline and candidate runs
  -> align metrics by identity
  -> calculate deltas, thresholds, severities, and missing metrics
  -> optionally persist comparison and findings

benchmark-analyzer report
  -> load comparison
  -> render deterministic summary as text, Markdown, or JSON

benchmark-analyzer history
  -> load suite runs
  -> print recent runs and key metric trends
```

The important boundary is that parsers know source formats, while comparison and reporting only know canonical metrics.

## Canonical Metric Model

Parsers isolate source-format details and emit a shared metric model:

```ts
type MetricDirection = "lower_is_better" | "higher_is_better" | "neutral";

type CanonicalMetric = {
  metricName: string;
  metricGroup: string;
  unit: string;
  aggregationType: string;
  valueNumeric: number;
  direction: MetricDirection;
  metadata?: Record<string, unknown>;
};
```

Metric identity for comparisons is:

```text
metricName::aggregationType::unit
```

Examples:

| Source | Metric | Group | Aggregation | Unit | Direction |
| --- | --- | --- | --- | --- | --- |
| k6 | `http_req_duration` | `latency` | `p95` | `ms` | `lower_is_better` |
| k6 | `http_req_failed` | `reliability` | `rate` | `percent` | `lower_is_better` |
| k6 | `http_reqs` | `throughput` | `rate` | `rps` | `higher_is_better` |
| Jest | `tests_failed` | `tests` | `count` | `count` | `lower_is_better` |
| Jest | `tests_passed` | `tests` | `count` | `count` | `higher_is_better` |
| Jest | `duration_total` | `duration` | `total` | `ms` | `lower_is_better` |

Run payloads also carry suite and run metadata: suite name, scenario, tags, run label, commit SHA, branch, environment, run timestamp, duration, and source metadata.

## Comparison And Threshold Logic

Comparison operates only on canonical metrics.

For each aligned metric:

- absolute delta is `candidate - baseline`
- percent delta is `((candidate - baseline) / baseline) * 100`
- percent delta is `null` when the baseline value is zero
- direction determines whether the delta is an improvement or regression
- neutral metrics are unchanged unless a matching rule assigns status
- baseline-only and candidate-only metrics become explicit missing findings

Threshold rules are configurable:

```ts
type ThresholdRule = {
  metricName?: string;
  metricNamePattern?: string;
  metricGroup?: string;
  aggregationType?: string;
  unit?: string;
  warnAbovePercent?: number;
  mediumAbovePercent?: number;
  highAbovePercent?: number;
  warnBelowPercent?: number;
  mediumBelowPercent?: number;
  highBelowPercent?: number;
  statusOnAbove?: "improved" | "regressed";
  statusOnBelow?: "improved" | "regressed";
  missingSeverity?: "none" | "low" | "medium" | "high";
};
```

Findings include status, severity, raw values, absolute and percent deltas, and a human-readable reason. Report summaries are generated in code; no LLM is used.

## CLI Examples

Initialize config:

```bash
npm run cli -- init --project "Acme Commerce Demo"
```

Import baseline and candidate artifacts:

```bash
npm run cli -- import --file demo/fixtures/k6/checkout-main-2026-04-26.json --project "Acme Commerce Demo" --label checkout-main --branch main --environment staging --no-git
npm run cli -- import --file demo/fixtures/k6/checkout-feature-cart-cache.json --project "Acme Commerce Demo" --label cart-cache-feature --branch feature/cart-cache --environment staging --no-git
```

Compare explicit runs:

```bash
npm run cli -- compare --baseline <baseline-run-id> --candidate <candidate-run-id>
```

Compare latest vs previous in a suite:

```bash
npm run cli -- compare --latest --previous --suite checkout-api-load
```

Render a report:

```bash
npm run cli -- report --comparison <comparison-id> --format markdown
```

Inspect suite history:

```bash
npm run cli -- history --suite checkout-api-load --metric http_req_duration:p95:ms --limit 5
```

## Demo Flow

The included demo dataset creates an `Acme Commerce Demo` project with:

- three main-branch k6 checkout load-test runs
- one feature-branch k6 candidate with higher latency, lower throughput, and one missing metric
- one passing Jest baseline
- one Jest candidate with failing tests and longer duration
- two precomputed comparisons

Validate fixtures without writing storage:

```bash
npm run demo:seed:dry-run
```

Import the demo dataset with the CLI's default local SQLite storage:

```bash
npm run demo:seed:reset
```

Then run CLI commands against the imported run and comparison IDs printed by the script:

```bash
npm run cli -- history --suite checkout-api-load
npm run cli -- report --comparison <comparison-id> --format text
```

## Local Setup

Prerequisites:

- Node.js 20+
- npm

Install dependencies:

```bash
npm ci
```

Build and test:

```bash
npm run typecheck
npm test
```

Create CLI config:

```bash
npm run cli -- init --project "Benchmark Demo"
```

Run commands with local SQLite storage:

```bash
npm run cli -- import --file demo/fixtures/k6/checkout-main-2026-04-26.json --project "Benchmark Demo" --no-git
```

By default, `init` writes:

```json
{
  "storage": {
    "type": "sqlite",
    "path": ".benchmark-analyzer/runs.db"
  }
}
```

## Screenshots

Suggested terminal screenshots:

- CLI init/import: `docs/screenshots/cli-import.png`
- CLI compare: `docs/screenshots/cli-compare.png`
- CLI report Markdown output: `docs/screenshots/cli-report.png`
- CLI history trends: `docs/screenshots/cli-history.png`

## Known Limitations

- SQLite is the only built-in store; schema is applied from TypeScript-managed SQL at startup.
- No migration framework yet.
- No pagination for long-lived project, suite, run, or finding lists.
- No background job queue for large imports or expensive comparisons.
- Raw artifact files are not copied into durable object storage.
- Threshold configuration is command/request-level only; there is no project-level policy store yet.
- Custom benchmark parser plugins are not implemented yet.
- Benchmark noise is handled through deterministic thresholds, not statistical modeling.

## Future Improvements

- Publish to the public npm registry with versioned release notes.
- Add custom parser plugins.
- Add project/suite-level threshold policies with inheritance.
- Add database migrations and versioned schema management.
- Add CI artifact adapters that call the same ingestion service.
- Add repeated-run baseline statistics and variance-aware comparisons.
- Add export formats such as HTML or PDF generated from the CLI.

## Development Notes

Useful commands:

```bash
npm run typecheck
npm test
npm run demo:seed:dry-run
npm run cli -- --help
```

The tests use `node:test`, `supertest`, and `better-sqlite3` for parser, CLI, API, persistence, and integration coverage.
