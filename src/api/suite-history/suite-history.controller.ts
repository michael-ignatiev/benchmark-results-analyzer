import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import type { RunRepository } from "../../persistence/run-repository.js";
import {
  buildSuiteHistoryResponse,
  type SuiteHistoryResponse,
} from "./suite-history.response.js";
import { SUITE_HISTORY_RUN_REPOSITORY } from "./suite-history.tokens.js";
import { parseSuiteHistoryRequest } from "./suite-history.validation.js";

@Controller("suites")
export class SuiteHistoryController {
  constructor(
    @Inject(SUITE_HISTORY_RUN_REPOSITORY)
    private readonly runRepository: RunRepository,
  ) {}

  @Get(":suiteId/history")
  async getSuiteHistory(
    @Param("suiteId") suiteId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<SuiteHistoryResponse> {
    const historyQuery = parseSuiteHistoryRequest(suiteId, query);
    const history = await this.runRepository.getSuiteHistory(historyQuery);

    if (history === undefined) {
      throw new NotFoundException({
        code: "SUITE_NOT_FOUND",
        message: `Suite "${suiteId}" was not found`,
      });
    }

    return buildSuiteHistoryResponse(history);
  }
}
