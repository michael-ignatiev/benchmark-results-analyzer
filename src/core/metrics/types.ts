export const SOURCE_TYPES = ["k6", "jest"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export const METRIC_DIRECTIONS = [
  "lower_is_better",
  "higher_is_better",
  "neutral",
] as const;

export type MetricDirection = (typeof METRIC_DIRECTIONS)[number];

export interface CanonicalMetric {
  metricName: string;
  metricGroup: string;
  unit: string;
  aggregationType: string;
  valueNumeric: number;
  direction: MetricDirection;
  metadata?: Record<string, unknown>;
}
