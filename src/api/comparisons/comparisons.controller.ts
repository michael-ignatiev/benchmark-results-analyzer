import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { ComparisonValidationError } from "../../comparisons/comparison-validation-error.js";
import { generateComparisonReportSummary } from "../../comparisons/report-summary.service.js";
import type {
  CreatePersistedComparisonInput,
  CreatePersistedComparisonResult,
  PersistedComparisonService,
} from "../../comparisons/persisted-comparison.service.js";
import type {
  ComparisonFinding,
  ComparisonStatus,
  ComparisonSummary,
  Severity,
  ThresholdRule,
} from "../../comparisons/types.js";
import type {
  PersistedComparisonFindingReadModel,
  PersistedComparisonReadModel,
} from "../../persistence/comparison-repository.js";
import { PERSISTED_COMPARISON_SERVICE } from "./comparisons.tokens.js";
import {
  parseCreateComparisonRequest,
  validateComparisonIdParam,
} from "./comparisons.validation.js";

@Controller("comparisons")
export class ComparisonsController {
  constructor(
    @Inject(PERSISTED_COMPARISON_SERVICE)
    private readonly persistedComparisonService: PersistedComparisonService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createComparison(
    @Body() body: unknown = {},
  ): Promise<CreateComparisonResponse> {
    const input = parseCreateComparisonRequest(body);

    try {
      const result = await this.persistedComparisonService.compareAndPersist(input);
      return buildCreateComparisonResponse(result, input);
    } catch (error) {
      throwComparisonApiError(error);
    }
  }

  @Get(":id")
  async getComparison(@Param("id") id: string): Promise<GetComparisonResponse> {
    const comparisonId = validateComparisonIdParam(id);
    const comparison = await this.persistedComparisonService.getComparison(comparisonId);

    if (comparison === undefined) {
      throw new NotFoundException({
        code: "COMPARISON_NOT_FOUND",
        message: `Comparison "${comparisonId}" was not found`,
      });
    }

    return buildGetComparisonResponse(comparison);
  }
}

export interface CreateComparisonResponse {
  data: {
    comparisonId: string;
    suiteId: string;
    baselineRunId: string;
    candidateRunId: string;
    label?: string;
    thresholdRules?: ThresholdRule[];
    summary: ComparisonSummary;
    reportSummary: string;
    findings: ComparisonFinding[];
    groupedFindings: GroupedComparisonFindings<ComparisonFinding>;
    findingIds: string[];
  };
}

export interface GetComparisonResponse {
  data: {
    comparisonId: string;
    suiteId: string;
    baselineRunId: string;
    candidateRunId: string;
    label?: string;
    thresholdRules?: ThresholdRule[];
    summary: ComparisonSummary;
    reportSummary: string;
    findings: PersistedComparisonFindingReadModel[];
    groupedFindings: GroupedComparisonFindings<PersistedComparisonFindingReadModel>;
  };
}

export interface GroupedComparisonFindings<TFinding extends ComparisonFinding> {
  byStatus: Record<ComparisonStatus, TFinding[]>;
  bySeverity: Record<Severity, TFinding[]>;
  byMetricGroup: Record<string, TFinding[]>;
}

function buildCreateComparisonResponse(
  result: CreatePersistedComparisonResult,
  input: CreatePersistedComparisonInput,
): CreateComparisonResponse {
  const data: CreateComparisonResponse["data"] = {
    comparisonId: result.comparisonId,
    suiteId: result.suiteId,
    baselineRunId: result.baselineRunId,
    candidateRunId: result.candidateRunId,
    summary: result.summary,
    reportSummary: result.reportSummary,
    findings: result.findings,
    groupedFindings: groupFindings(result.findings),
    findingIds: result.findingIds,
  };

  if (result.label !== undefined) {
    data.label = result.label;
  }

  if (input.thresholdRules !== undefined) {
    data.thresholdRules = input.thresholdRules;
  }

  return { data };
}

function buildGetComparisonResponse(
  comparison: PersistedComparisonReadModel,
): GetComparisonResponse {
  const data: GetComparisonResponse["data"] = {
    comparisonId: comparison.id,
    suiteId: comparison.suiteId,
    baselineRunId: comparison.baselineRunId,
    candidateRunId: comparison.candidateRunId,
    summary: comparison.summary,
    reportSummary: generateComparisonReportSummary({
      summary: comparison.summary,
      findings: comparison.findings,
    }),
    findings: comparison.findings,
    groupedFindings: groupFindings(comparison.findings),
  };

  if (comparison.label !== undefined) {
    data.label = comparison.label;
  }

  if (comparison.thresholdRules !== undefined) {
    data.thresholdRules = comparison.thresholdRules;
  }

  return { data };
}

function groupFindings<TFinding extends ComparisonFinding>(
  findings: TFinding[],
): GroupedComparisonFindings<TFinding> {
  const byStatus: Record<ComparisonStatus, TFinding[]> = {
    improved: [],
    regressed: [],
    unchanged: [],
    missing: [],
  };
  const bySeverity: Record<Severity, TFinding[]> = {
    none: [],
    low: [],
    medium: [],
    high: [],
  };
  const byMetricGroup: Record<string, TFinding[]> = {};

  for (const finding of findings) {
    byStatus[finding.status].push(finding);
    bySeverity[finding.severity].push(finding);
    const metricGroup = byMetricGroup[finding.metricGroup] ?? [];
    metricGroup.push(finding);
    byMetricGroup[finding.metricGroup] = metricGroup;
  }

  return {
    byStatus,
    bySeverity,
    byMetricGroup,
  };
}

function throwComparisonApiError(error: unknown): never {
  if (error instanceof ComparisonValidationError) {
    const payload = {
      code: error.code,
      message: error.message,
    };

    if (error.code === "COMPARISON_RUN_NOT_FOUND") {
      throw new NotFoundException(payload);
    }

    throw new BadRequestException(payload);
  }

  throw error;
}
