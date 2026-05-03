# Three-Minute Demo Flow

This walkthrough presents Benchmark Results Analyzer as a CLI-only npm package. It is designed for a short engineering interview or portfolio demo.

## Setup Before The Demo

Build and validate fixtures:

```bash
npm run build
npm run demo:seed:dry-run
```

Import the demo dataset into the default local SQLite store:

```bash
npm run demo:seed:reset
```

Keep the run IDs and comparison IDs printed by the seed script visible. The demo should stay terminal-driven and avoid switching to a browser.

## Sample Artifacts

Main k6 pair:

- baseline: `demo/fixtures/k6/checkout-main-2026-04-26.json`
- candidate: `demo/fixtures/k6/checkout-feature-cart-cache.json`

Optional Jest pair:

- baseline: `demo/fixtures/jest/checkout-jest-main.json`
- candidate: `demo/fixtures/jest/checkout-jest-feature.json`

Live import snippet:

```bash
npm run cli -- import \
  --file demo/fixtures/k6/checkout-main-2026-04-26.json \
  --project "Acme Commerce Demo" \
  --label checkout-main \
  --branch main \
  --environment staging \
  --no-git
```

## Three-Minute Script

### 0:00-0:30 - Problem And Package

Say:

> Benchmark Results Analyzer is a CLI-only npm package for reviewing benchmark artifacts. It imports k6 and Jest JSON files, normalizes them into a canonical metric model, persists runs, compares baseline and candidate runs, and prints deterministic reports.

Emphasize the problem:

- k6 and Jest output very different JSON shapes.
- Reviewers need consistent answers: what regressed, what improved, what stayed within tolerance, and what went missing.
- The package avoids black-box scoring and generated narratives.

Command to show:

```bash
npm run cli -- --help
```

### 0:30-1:05 - Import And Normalization

Show the fixture paths and the `import` command.

Say:

> Import is deliberately local and explicit. The CLI reads an artifact from disk, applies metadata from flags and optional git metadata, asks the parser registry to detect k6 or Jest, then persists a normalized run and canonical metric rows.

Engineering decisions to mention:

- Parser logic is isolated from persistence.
- The comparison engine never reads raw k6 or Jest JSON.
- Metrics carry direction semantics such as `lower_is_better`, `higher_is_better`, or `neutral`.
- The CLI prints IDs that can be reused by later commands.

Useful command:

```bash
npm run cli -- import --file demo/fixtures/k6/checkout-feature-cart-cache.json --project "Acme Commerce Demo" --label feature-cart-cache --branch feature/cart-cache --environment staging --no-git
```

### 1:05-1:35 - History

Show recent suite history:

```bash
npm run cli -- history --suite checkout-api-load
```

Then show an explicit metric:

```bash
npm run cli -- history --suite checkout-api-load --metric http_req_duration:p95:ms --limit 5
```

Metrics to call out:

- `http_req_duration::p95::ms`
- `http_req_duration::p99::ms`
- `http_reqs::rate::rps`
- `http_req_failed::rate::percent`

Say:

> History is intentionally concise. It is for quick terminal review: which runs exist, and how key metrics moved across recent runs.

Tradeoff to mention:

- This is not statistical variance analysis.
- It shows deterministic trends and leaves confidence intervals for a later version.

### 1:35-2:15 - Comparison

Use either explicit run IDs from the seed output:

```bash
npm run cli -- compare --baseline <baseline-run-id> --candidate <candidate-run-id>
```

Or latest vs previous:

```bash
npm run cli -- compare --latest --previous --suite checkout-api-load
```

Highlight expected findings from the seeded k6 comparison:

- `http_req_duration p95`: candidate latency is worse.
- `http_req_duration p99`: tail latency is worse.
- `http_reqs rate`: throughput drops.
- `http_req_failed rate`: reliability worsens.
- `data_sent`: candidate is missing a metric that existed in the baseline.

Say:

> Metrics are matched by `metricName::aggregationType::unit`, not by array position. Deltas are candidate minus baseline, percent deltas are relative to baseline, and direction determines whether the change is good or bad.

Threshold details to mention:

- latency uses above-threshold regression rules
- throughput uses below-threshold regression rules
- missing metric severity can be configured
- zero baselines do not produce misleading infinite percentages

### 2:15-2:45 - Report

Render text output:

```bash
npm run cli -- report --comparison <comparison-id> --format text
```

Render Markdown:

```bash
npm run cli -- report --comparison <comparison-id> --format markdown
```

Render JSON:

```bash
npm run cli -- report --comparison <comparison-id> --format json
```

Say:

> The report summary is generated deterministically in code. There is no LLM in the report path, which keeps output repeatable, testable, and tied to metric-level findings.

Engineering decision to mention:

- Report generation reads persisted comparison data.
- It does not inspect raw files.
- Markdown/JSON output makes it easy to attach results to pull requests or CI logs later.

### 2:45-3:00 - Interview Close

Use this explanation:

> Architecturally, this is a CLI-first data pipeline: source-specific parsers normalize artifacts into canonical metrics; ingestion persists runs; comparison aligns metrics by identity and applies direction plus threshold rules; reporting renders deterministic text. I spent the complexity budget on correctness and explainability rather than on UI or integrations.

Close with tradeoffs:

- CLI import was chosen because benchmark artifacts already exist on disk locally or in CI.
- Schema setup is simple and should become migrations later.
- Thresholds are command-level today; project-level policies would be next.
- The comparison engine is deterministic, but not a statistical model yet.

## Optional Jest Demo

Compare the seeded Jest pair:

```bash
npm run cli -- compare --latest --previous --suite checkout-service-tests
```

Highlight:

- `tests_failed::count::count`
- `test_suites_failed::count::count`
- `duration_total::total::ms`

Say:

> The same comparison engine works for performance metrics and test-result metrics because both parsers emit the same canonical model.

## Common Questions

### Why CLI-only?

CLI-only matches the artifact lifecycle. k6 and Jest produce files locally or in CI, so a CLI can import them without browser forms, multipart request handling, or an artifact upload service.

### Why not compare raw k6 and Jest directly?

Raw formats couple every downstream feature to source-specific JSON. Normalization keeps comparison, history, and reporting source-agnostic.

### Why not use an LLM for summaries?

The summary needs to be deterministic, testable, and traceable to metric-level findings. A generated narrative could be added later as an optional layer, but the core report should remain reproducible.

### What would you scale next?

- Add CI artifact adapters that call the same ingestion service.
- Add object storage for raw artifacts.
- Add project-level threshold policies.
- Add storage migrations.
- Add repeated-run baseline statistics and noise modeling.
