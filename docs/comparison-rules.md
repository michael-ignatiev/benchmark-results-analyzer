# Comparison Rules

This document describes the rules used by the Benchmark Results Analyzer comparison engine. The engine compares canonical metrics only; it does not inspect raw k6, Jest, or imported artifact payloads.

## Metric Matching Key

Metrics are matched by identity:

```text
metricName::aggregationType::unit
```

Examples:

- `http_req_duration::p95::ms`
- `http_req_failed::rate::percent`
- `http_reqs::rate::rps`
- `tests_failed::count::count`

`metricGroup` is not part of the matching key. It is used for display, grouping, and rule matching, but two metrics are comparable only by the identity above.

The engine validates that:

- required metric fields are non-empty strings
- `valueNumeric` is finite
- no run contains duplicate metric identities
- matched baseline and candidate metrics have the same `direction`

Comparison order is deterministic: metric identity keys are sorted before findings are produced.

## Delta Rules

For matched metrics:

```text
absolute delta = candidate - baseline
percent delta = ((candidate - baseline) / baseline) * 100
```

The absolute delta keeps the metric unit. The percent delta is relative to the baseline.

Example:

```text
baseline p95 latency = 300 ms
candidate p95 latency = 360 ms

deltaAbsolute = 60
deltaPercent = 20
```

## Direction Handling

Each canonical metric declares one direction:

```ts
"lower_is_better" | "higher_is_better" | "neutral"
```

Directional metrics:

- `lower_is_better`
  - candidate value increases -> `regressed`
  - candidate value decreases -> `improved`
- `higher_is_better`
  - candidate value increases -> `improved`
  - candidate value decreases -> `regressed`

Neutral metrics:

- default to `unchanged` even when the raw value changes
- can become `improved` or `regressed` only when a matching threshold rule provides `statusOnAbove` or `statusOnBelow`

If the absolute delta is zero, the metric is always `unchanged` with severity `none`.

## Threshold Rules

Threshold rules are optional. Without a matching rule, directional changes are still classified as `improved` or `regressed`, but severity remains `none`.

Rule shape:

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

Matching behavior:

- a rule must include `metricName` or `metricNamePattern`
- `metricName` must match exactly
- `metricNamePattern` supports `*` wildcards
- optional `metricGroup`, `aggregationType`, and `unit` further constrain the match
- when multiple rules match, the most specific wins
- if specificity ties, the earlier rule wins

Specificity ranking:

```text
metricName        +100
metricNamePattern  +50
aggregationType    +20
unit               +10
metricGroup         +5
```

Above/below thresholds are evaluated from the sign of `deltaPercent`:

- positive delta uses `warnAbovePercent`, `mediumAbovePercent`, `highAbovePercent`
- negative delta uses `warnBelowPercent`, `mediumBelowPercent`, `highBelowPercent`

Threshold values are normalized by sign:

- above thresholds are treated as positive percentages
- below thresholds are treated as negative percentages

Example latency rule:

```json
{
  "metricName": "http_req_duration",
  "aggregationType": "p95",
  "warnAbovePercent": 10,
  "mediumAbovePercent": 20,
  "highAbovePercent": 30
}
```

Example throughput rule:

```json
{
  "metricName": "http_reqs",
  "aggregationType": "rate",
  "warnBelowPercent": 5,
  "mediumBelowPercent": 10,
  "highBelowPercent": 15
}
```

## Severity Classification

Severity is assigned only when a matching threshold rule applies and the percent delta crosses a configured boundary.

For positive deltas:

```text
deltaPercent > highAbovePercent   -> high
deltaPercent > mediumAbovePercent -> medium
deltaPercent > warnAbovePercent   -> low
otherwise                         -> none
```

For negative deltas:

```text
deltaPercent < -highBelowPercent   -> high
deltaPercent < -mediumBelowPercent -> medium
deltaPercent < -warnBelowPercent   -> low
otherwise                          -> none
```

Threshold checks are strict. A value equal to the threshold does not cross it.

If a matching directional rule exists and the change is inside the configured tolerance, the finding becomes:

```text
status = unchanged
severity = none
```

This prevents small directional changes from being over-reported as regressions or improvements when the team has defined an acceptable tolerance.

## Zero Baseline Handling

When the baseline value is zero, percent delta is not computed:

```text
deltaPercent = null
```

The engine still computes absolute delta and applies direction:

- baseline `0`, candidate `5`, `lower_is_better` -> `regressed`
- baseline `0`, candidate `5`, `higher_is_better` -> `improved`

Severity remains `none` because threshold rules are percent-based and cannot be evaluated without a percent delta.

The finding reason explicitly states that the baseline was zero and percent delta was not computed.

## Missing Metric Handling

The engine compares the union of baseline and candidate metric keys. If a key exists in only one run, the finding is:

```text
status = missing
deltaAbsolute = null
deltaPercent = null
```

Baseline-only metric:

```text
baselineValue = number
candidateValue = null
reason = "Metric present in baseline but missing in candidate"
```

Candidate-only metric:

```text
baselineValue = null
candidateValue = number
reason = "Metric introduced in candidate but absent in baseline"
```

Missing metrics default to severity `none`. A matching threshold rule can set `missingSeverity`.

Example:

```json
{
  "metricName": "http_req_failed",
  "aggregationType": "rate",
  "missingSeverity": "high"
}
```

## Noise Caveats And Limitations

The comparison engine is deterministic, but it is not a statistical model.

Current caveats:

- It compares one baseline run to one candidate run; it does not model variance across repeated runs.
- Thresholds are static percentages, not confidence intervals.
- Equal-to-threshold changes are treated as within tolerance because threshold checks are strict.
- Percent thresholds do not work when the baseline value is zero.
- Missing metric severity requires explicit rules; otherwise missing metrics are informational.
- The metric matching key excludes `metricGroup`, so parser authors must keep `metricName`, `aggregationType`, and `unit` stable.
- Direction comes from parser normalization. Incorrect parser direction leads to incorrect comparison status.
- Neutral metrics require explicit `statusOnAbove` or `statusOnBelow` if they should be treated as regressions or improvements.
- There is no project-level threshold policy store yet; rules are supplied per comparison.
- No automatic noise suppression exists for flaky tests, warm-up effects, traffic shape changes, or environment drift.

For production use, comparison rules should be paired with repeated-run baselines, suite-specific threshold policies, and metadata checks that ensure baseline and candidate runs are truly comparable.
