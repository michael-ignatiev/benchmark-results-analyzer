import { Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import type { ComparisonRepository } from "../../persistence/comparison-repository.js";
import { REPORT_COMPARISON_REPOSITORY } from "./reports.tokens.js";
import { buildReportResponse, type ReportResponse } from "./reports.response.js";

@Controller("reports")
export class ReportsController {
  constructor(
    @Inject(REPORT_COMPARISON_REPOSITORY)
    private readonly comparisonRepository: ComparisonRepository,
  ) {}

  @Get(":comparisonId")
  async getReport(
    @Param("comparisonId") comparisonId: string,
  ): Promise<ReportResponse> {
    const comparison = await this.comparisonRepository.getComparisonWithFindings(comparisonId);

    if (comparison === undefined) {
      throw new NotFoundException({
        code: "COMPARISON_NOT_FOUND",
        message: `Comparison "${comparisonId}" was not found`,
      });
    }

    return buildReportResponse(comparison);
  }
}
