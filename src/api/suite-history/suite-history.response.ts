import type { SourceType } from "../../parsers/types.js";
import type {
  PersistedSuiteReadModel,
  SuiteHistoryFilters,
  SuiteHistoryMetricPoint,
  SuiteHistoryReadModel,
} from "../../persistence/run-repository.js";

export interface SuiteHistoryResponse {
  data: {
    suite: PersistedSuiteReadModel;
    filters: SuiteHistoryResponseFilters;
    runs: SuiteHistoryRun[];
    metrics: SuiteHistoryMetricSeries[];
    chartSections: SuiteHistoryChartSection[];
  };
}

export interface SuiteHistoryResponseFilters extends SuiteHistoryFilters {
  metricKeys: string[];
}

export interface SuiteHistoryRun {
  id: string;
  runAt: string;
  label?: string;
  branchName?: string;
  environment?: string;
  sourceType: SourceType;
}

export interface SuiteHistoryMetricSeries {
  metricKey: string;
  metricName: string;
  metricGroup: string | null;
  aggregationType: string;
  unit: string;
  points: SuiteHistoryMetricSeriesPoint[];
}

export interface SuiteHistoryMetricSeriesPoint extends SuiteHistoryRun {
  value: number;
}

export interface SuiteHistoryChartSection {
  id: "suite-metric-trends";
  title: string;
  visualization: "line";
  xKey: "runAt";
  yKey: "value";
  seriesKey: "metricKey";
  data: SuiteHistoryChartDatum[];
}

export interface SuiteHistoryChartDatum extends SuiteHistoryMetricSeriesPoint {
  metricKey: string;
  metricName: string;
  metricGroup: string | null;
  aggregationType: string;
  unit: string;
}

export function buildSuiteHistoryResponse(
  history: SuiteHistoryReadModel,
): SuiteHistoryResponse {
  const metrics = history.metrics.map((selector) => buildMetricSeries(selector, history.points));
  const filters = buildFilters(history);

  return {
    data: {
      suite: history.suite,
      filters,
      runs: buildRuns(history.points),
      metrics,
      chartSections: [
        {
          id: "suite-metric-trends",
          title: "Suite Metric Trends",
          visualization: "line",
          xKey: "runAt",
          yKey: "value",
          seriesKey: "metricKey",
          data: buildChartData(metrics),
        },
      ],
    },
  };
}

function buildFilters(history: SuiteHistoryReadModel): SuiteHistoryResponseFilters {
  const filters: SuiteHistoryResponseFilters = {
    metricKeys: history.metrics.map(metricKey),
  };

  if (history.filters.environment !== undefined) {
    filters.environment = history.filters.environment;
  }

  if (history.filters.branchName !== undefined) {
    filters.branchName = history.filters.branchName;
  }

  if (history.filters.sourceType !== undefined) {
    filters.sourceType = history.filters.sourceType;
  }

  return filters;
}

function buildMetricSeries(
  selector: SuiteHistoryReadModel["metrics"][number],
  points: SuiteHistoryMetricPoint[],
): SuiteHistoryMetricSeries {
  const selectorKey = metricKey(selector);
  const matchingPoints = points.filter((point) => metricKey(point) === selectorKey);
  const metricGroup = matchingPoints[0]?.metricGroup ?? null;

  return {
    metricKey: selectorKey,
    metricName: selector.metricName,
    metricGroup,
    aggregationType: selector.aggregationType,
    unit: selector.unit,
    points: matchingPoints.map((point) => ({
      ...runMetadata(point),
      value: point.valueNumeric,
    })),
  };
}

function buildRuns(points: SuiteHistoryMetricPoint[]): SuiteHistoryRun[] {
  const runsById = new Map<string, SuiteHistoryRun>();

  for (const point of points) {
    if (!runsById.has(point.runId)) {
      runsById.set(point.runId, runMetadata(point));
    }
  }

  return [...runsById.values()].sort(compareRuns);
}

function buildChartData(metrics: SuiteHistoryMetricSeries[]): SuiteHistoryChartDatum[] {
  return metrics
    .flatMap((metric) =>
      metric.points.map((point) => ({
        ...point,
        metricKey: metric.metricKey,
        metricName: metric.metricName,
        metricGroup: metric.metricGroup,
        aggregationType: metric.aggregationType,
        unit: metric.unit,
      })),
    )
    .sort(
      (left, right) =>
        left.runAt.localeCompare(right.runAt) ||
        left.metricKey.localeCompare(right.metricKey) ||
        left.id.localeCompare(right.id),
    );
}

function runMetadata(point: SuiteHistoryMetricPoint): SuiteHistoryRun {
  const run: SuiteHistoryRun = {
    id: point.runId,
    runAt: point.runAt,
    sourceType: point.sourceType,
  };

  if (point.runLabel !== undefined) {
    run.label = point.runLabel;
  }

  if (point.branchName !== undefined) {
    run.branchName = point.branchName;
  }

  if (point.environment !== undefined) {
    run.environment = point.environment;
  }

  return run;
}

function compareRuns(left: SuiteHistoryRun, right: SuiteHistoryRun): number {
  return left.runAt.localeCompare(right.runAt) || left.id.localeCompare(right.id);
}

function metricKey(metric: {
  metricName: string;
  aggregationType: string;
  unit: string;
}): string {
  return `${metric.metricName}::${metric.aggregationType}::${metric.unit}`;
}
