# Interview Notes

These notes frame Benchmark Results Analyzer as a CLI-only npm package and an engineering-focused portfolio project.

## Short Pitch

> Benchmark Results Analyzer is a CLI-only benchmark review package. It imports k6 and Jest result artifacts, normalizes them into a canonical metric model, stores runs and metrics in a local SQLite database by default, compares baseline and candidate runs with deterministic threshold rules, and prints concise reports in terminal, Markdown, or JSON format.

## Senior Skills Demonstrated

- CLI product design: explicit `init`, `import`, `compare`, `report`, and `history` commands.
- Boundary design: parser, ingestion, persistence, comparison, reporting, and CLI output are separate concerns.
- Domain modeling: raw benchmark artifacts become canonical metrics before downstream use.
- Deterministic decision logic: comparison results are explainable, testable, and not dependent on an LLM.
- Persistence design: projects, suites, runs, metrics, comparisons, and findings are stored relationally.
- Error handling: invalid files, unsupported formats, parser failures, missing runs, and suite mismatches produce explicit errors.
- Test strategy: parser unit tests, comparison tests, persistence integration tests, CLI tests, and demo fixture validation.
- MVP judgment: the project solves the local artifact review workflow before adding CI adapters, hosted dashboards, auth, queues, or advanced statistics.

Good summary:

> I treated this as a CLI data pipeline. The main design goal was to normalize heterogeneous benchmark artifacts into a stable internal model, then keep comparison, history, and reporting source-agnostic.

## Why CLI-Only

CLI-only is the smallest useful product shape for this project.

It was chosen because it:

- matches how k6 and Jest artifacts are produced: local commands and CI jobs write files
- is scriptable and easy to automate
- avoids browser upload flows and multipart request handling
- avoids premature raw artifact storage decisions
- avoids forcing developers to run infrastructure before trying the package
- makes the npm package surface clear
- keeps demos repeatable from a terminal
- keeps failure modes easy to test: missing file, unsupported source, invalid JSON, parser validation error, missing run IDs

Interview framing:

> CI integration and dashboards are useful, but they are not the hard part. The hard part is turning inconsistent benchmark outputs into comparable metrics and producing trustworthy findings. A CLI validates that core workflow directly.

## Why Normalization Is Central

Normalization is the main architectural decision.

k6 and Jest do not share a natural schema:

- k6 has trends, counters, rates, gauges, thresholds, and summary stats
- Jest has test counts, suite counts, status fields, and duration data

The canonical metric model gives every downstream feature the same input:

```ts
{
  metricName: string;
  metricGroup: string;
  unit: string;
  aggregationType: string;
  valueNumeric: number;
  direction: "lower_is_better" | "higher_is_better" | "neutral";
}
```

Why this matters:

- comparison logic does not need source-specific branches
- report generation does not know whether a metric came from k6 or Jest
- history can query selected metric identities across runs
- adding a new source means adding a parser, not rewriting comparison or reporting
- tests can target parser correctness and comparison correctness independently

Interview framing:

> The parser boundary absorbs source-specific complexity. Everything after that boundary operates on canonical metrics.

## How Threshold Rules Are Designed

Thresholds are explicit rules designed to avoid over-reporting small or expected benchmark noise.

Rule matching supports:

- exact `metricName`
- wildcard `metricNamePattern`
- optional `metricGroup`
- optional `aggregationType`
- optional `unit`

Rules can define:

- above thresholds for metrics where increases matter, such as latency or failures
- below thresholds for metrics where decreases matter, such as throughput
- low, medium, and high severity boundaries
- missing metric severity
- explicit status behavior for neutral metrics

Example:

```json
{
  "metricName": "http_req_duration",
  "aggregationType": "p95",
  "warnAbovePercent": 10,
  "mediumAbovePercent": 20,
  "highAbovePercent": 30
}
```

Design rationale:

- rule data is inspectable and testable
- exact rules can override broader pattern rules
- threshold behavior stays deterministic
- direction comes from the metric model, while tolerance comes from rules

Interview framing:

> Direction answers whether a change is good or bad. Thresholds answer whether the change is large enough to care about.

## How Benchmark Noise Is Handled

The MVP handles noise through deterministic tolerance thresholds, not statistical modeling.

Current behavior:

- small directional changes can be classified as `unchanged` if they stay within configured tolerance
- severity appears when a percent delta crosses a rule boundary
- missing metrics are explicit rather than silently ignored
- zero baselines avoid invalid percent deltas

Important caveat:

> This is deterministic thresholding, not variance analysis.

What it does not do yet:

- repeated-run baseline modeling
- confidence intervals
- standard deviation or percentile stability checks
- automatic flaky-test detection
- environment drift detection
- warm-up or traffic-shape correction

Interview framing:

> For an MVP, thresholding is the right level of complexity because it is transparent and maps to how teams usually define performance budgets. A v2 should add repeated-run statistics for suites where noise matters.

## Key MVP Tradeoffs

- CLI-only before CI adapters
  - Fast to validate and script locally, but not yet integrated with a specific CI provider.
- SQLite default before shared database storage
  - Good for local npm package ergonomics and history queries; PostgreSQL remains optional for shared/team workflows.
- Startup schema application before migrations
  - Simple local setup, but not enough for production change management.
- Per-command thresholds before policy storage
  - Easy to reason about, but teams will eventually want project/suite-level policies.
- Deterministic summary before generated narrative
  - Reproducible and testable, but less flexible than a natural-language assistant.
- Single baseline vs single candidate before statistical baselines
  - Clear and simple, but limited for noisy benchmark suites.
- Normalized metric rows before analytics storage
  - Good for MVP querying, but large-scale histories may need rollups or columnar storage later.

Good way to say it:

> I deliberately spent complexity budget on the canonical model, metric identity, and comparison correctness instead of dashboards or integration breadth.

## What To Do Next In V2

Most valuable next steps:

- CI artifact adapters
  - Add GitHub Actions or another CI adapter that calls the same ingestion service.
- Raw artifact storage
  - Store imported files in object storage and keep artifact URLs on runs.
- Threshold policies
  - Add project/suite-level threshold rules with inheritance and versioning.
- Repeated-run statistics
  - Compare candidates against a baseline window, not just one run.
  - Track variance, confidence, and historical stability.
- Storage migrations
  - Replace startup schema application with migration tooling for SQLite and PostgreSQL.
- Parser extensibility
  - Add custom parser plugins or a documented parser interface for new sources.
- Report exports
  - Add HTML/PDF output generated from the same persisted comparison data.

V2 framing:

> The next version should not change the core invariant. New integrations and output formats should still feed canonical metrics, and comparison/reporting should remain source-agnostic.

## Interview Close

Use this when wrapping up:

> The project is intentionally small, but the boundaries are the point: local artifacts enter through a CLI, parsers normalize them, persistence stores canonical runs, comparison applies deterministic rules, and reports are repeatable. That makes the system easy to test, explain, and extend.
