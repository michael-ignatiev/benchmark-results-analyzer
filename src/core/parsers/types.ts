import type { CanonicalMetric, SourceType } from "../metrics/types.js";

export {
  METRIC_DIRECTIONS,
  SOURCE_TYPES,
} from "../metrics/types.js";
export type {
  CanonicalMetric,
  MetricDirection,
  SourceType,
} from "../metrics/types.js";

export interface ParsedRunPayload {
  sourceType: SourceType;
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
}

export interface BenchmarkParser {
  canParse(input: unknown, filename?: string): boolean;
  parse(input: unknown, filename?: string): ParsedRunPayload;
}
