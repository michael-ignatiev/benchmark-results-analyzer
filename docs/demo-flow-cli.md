# CLI Demo Flow

This walkthrough shows Benchmark Results Analyzer as a CLI-only npm package. It uses the included k6 fixtures to initialize config, import a baseline and candidate run, compare them, generate a Markdown report, and inspect suite history.

The commands assume you are running from the repository root. If the package is installed, replace the local `bra` shell function with the installed `benchmark-analyzer` or `bra` binary.

## 1. Prepare The CLI

Prerequisites:

- Node.js and npm
- `jq` for copy-paste ID capture, or manual copying from JSON output

Build the local CLI once:

```bash
npm run build
```

Create a shell helper for the local demo:

```bash
bra() {
  node dist/cli/main.js "$@"
}
```

Use an isolated config file for the demo so the repository default config is not overwritten:

```bash
export BRA_CONFIG=".benchmark-analyzer.demo.json"
```

## 2. Init

Create local CLI config:

```bash
bra init \
  --config "$BRA_CONFIG" \
  --project "Acme Commerce Demo" \
  --project-description "CLI demo for k6 checkout benchmark review" \
  --metadata owner=platform-performance \
  --metadata environment=staging \
  --force
```

Expected result:

```text
Initialized Benchmark Results Analyzer config: .../.benchmark-analyzer.demo.json
```

What to mention:

- The config is local and deterministic.
- Storage uses a local SQLite file by default: `.benchmark-analyzer/runs.db`.
- Metadata defaults can be versioned with the project if desired.

## 3. Optional Threshold Rules

Create a small threshold file for the comparison:

```bash
mkdir -p demo/output
cat > demo/output/checkout-thresholds.json <<'JSON'
[
  {
    "metricName": "http_req_duration",
    "aggregationType": "p95",
    "warnAbovePercent": 10,
    "mediumAbovePercent": 20,
    "highAbovePercent": 30
  },
  {
    "metricName": "http_req_duration",
    "aggregationType": "p99",
    "warnAbovePercent": 10,
    "mediumAbovePercent": 25,
    "highAbovePercent": 35
  },
  {
    "metricName": "http_reqs",
    "aggregationType": "rate",
    "warnBelowPercent": 5,
    "mediumBelowPercent": 10,
    "highBelowPercent": 15
  },
  {
    "metricName": "data_sent",
    "missingSeverity": "low"
  }
]
JSON
```

What to mention:

- Direction comes from the canonical metric model.
- Thresholds define tolerance and severity.
- Missing metric severity is explicit and configurable.

## 4. Import k6 Baseline

Import the latest main-branch k6 fixture:

```bash
BASELINE_JSON=$(bra import \
  --config "$BRA_CONFIG" \
  --file demo/fixtures/k6/checkout-main-2026-04-26.json \
  --source k6 \
  --project "Acme Commerce Demo" \
  --label checkout-main-2026-04-26 \
  --branch main \
  --environment staging \
  --run-at 2026-04-26T10:00:00.000Z \
  --no-git \
  --json)

printf '%s\n' "$BASELINE_JSON"
```

Capture the run and suite IDs:

```bash
BASELINE_RUN_ID=$(printf '%s' "$BASELINE_JSON" | jq -r '.runId')
SUITE_ID=$(printf '%s' "$BASELINE_JSON" | jq -r '.suiteId')
```

If `jq` is not installed, copy `runId` and `suiteId` from the JSON output manually.

Expected result:

```json
{
  "projectId": "...",
  "suiteId": "...",
  "runId": "...",
  "sourceType": "k6",
  "metricsInserted": 27
}
```

What to mention:

- The parser converts k6 trend/counter/rate metrics into canonical metrics.
- The CLI stores normalized rows, not just raw JSON.
- `--no-git` keeps the demo deterministic; normal imports can capture git branch and commit.

## 5. Import k6 Candidate

Import the feature-branch k6 fixture:

```bash
CANDIDATE_JSON=$(bra import \
  --config "$BRA_CONFIG" \
  --file demo/fixtures/k6/checkout-feature-cart-cache.json \
  --source k6 \
  --project "Acme Commerce Demo" \
  --label checkout-feature-cart-cache \
  --branch feature/cart-cache \
  --environment staging \
  --run-at 2026-04-26T11:00:00.000Z \
  --no-git \
  --json)

printf '%s\n' "$CANDIDATE_JSON"
```

Capture the candidate run ID:

```bash
CANDIDATE_RUN_ID=$(printf '%s' "$CANDIDATE_JSON" | jq -r '.runId')
```

Expected result:

```json
{
  "projectId": "...",
  "suiteId": "...",
  "runId": "...",
  "sourceType": "k6",
  "metricsInserted": 25
}
```

What to mention:

- The candidate intentionally has worse latency and lower throughput.
- It also omits a byte metric, which the comparison engine surfaces as missing instead of ignoring.

## 6. Compare Runs

Compare baseline and candidate by explicit run IDs:

```bash
COMPARISON_JSON=$(bra compare \
  --config "$BRA_CONFIG" \
  --baseline "$BASELINE_RUN_ID" \
  --candidate "$CANDIDATE_RUN_ID" \
  --label "Checkout cart cache feature vs latest main" \
  --thresholds demo/output/checkout-thresholds.json \
  --json)

printf '%s\n' "$COMPARISON_JSON"
```

Capture the comparison ID:

```bash
COMPARISON_ID=$(printf '%s' "$COMPARISON_JSON" | jq -r '.comparisonId')
```

Expected result shape:

```json
{
  "saved": true,
  "comparisonId": "...",
  "baselineRunId": "...",
  "candidateRunId": "...",
  "summary": {
    "regressions": 4,
    "improvements": 0,
    "missing": 2
  }
}
```

The exact counts can change if fixture metrics or threshold rules change. The important demo point is that the command returns a persisted comparison ID plus deterministic summary counts.

What to mention:

- Metrics are matched by `metricName::aggregationType::unit`.
- Deltas are candidate minus baseline.
- Direction determines whether a delta is good or bad.
- Thresholds classify severity without an LLM.
- Missing metrics are first-class findings.

## 7. Generate Markdown Report

Render a Markdown report:

```bash
bra report \
  --config "$BRA_CONFIG" \
  --comparison "$COMPARISON_ID" \
  --format markdown \
  > demo/output/checkout-comparison-report.md
```

Preview it in the terminal:

```bash
sed -n '1,120p' demo/output/checkout-comparison-report.md
```

Expected sections:

```text
# Comparison ...

Compared ... metrics: ...

- Baseline run: ...
- Candidate run: ...
- Summary: ...

## Regressions
...

## Missing Metrics
...
```

What to mention:

- The report is generated from persisted comparison data.
- The summary text is deterministic and testable.
- Markdown output is suitable for pull request comments, CI logs, or saved artifacts.

## 8. Inspect History

Show recent runs in the suite:

```bash
bra history \
  --config "$BRA_CONFIG" \
  --suite-id "$SUITE_ID" \
  --limit 5
```

Show selected metric trends:

```bash
bra history \
  --config "$BRA_CONFIG" \
  --suite-id "$SUITE_ID" \
  --metric http_req_duration:p95:ms \
  --metric http_req_duration:p99:ms \
  --metric http_reqs:rate:rps \
  --limit 5
```

Expected output shape:

```text
Suite ... checkout-api-load
Recent runs (2 shown):
- run ... checkout-feature-cart-cache ...
- run ... checkout-main-2026-04-26 ...
Key metric trends:
- http_req_duration p95 ms: ... -> ... (+..., 2 points)
- http_req_duration p99 ms: ... -> ... (+..., 2 points)
- http_reqs rate rps: ... -> ... (-..., 2 points)
```

What to mention:

- History is concise by design.
- It is useful before opening raw artifacts because it shows which runs exist and how key metrics moved.
- It reuses the same persisted canonical metrics as comparison and reporting.

## Clean Up

Remove generated demo files if needed:

```bash
rm -f "$BRA_CONFIG"
rm -rf .benchmark-analyzer
rm -rf demo/output
```

If you explicitly configured PostgreSQL storage, remove the demo project from that shared database manually or rerun the seed script with reset behavior before the next demo.

## Interview Close

Use this summary:

> This is a CLI-first benchmark review flow. Local k6 artifacts are imported into a canonical metric model, comparisons align metrics by identity and apply deterministic threshold rules, reports are generated without an LLM, and history gives a compact view of run trends. The architecture keeps parser logic, comparison rules, persistence, and CLI output separate so each part is testable and replaceable.
