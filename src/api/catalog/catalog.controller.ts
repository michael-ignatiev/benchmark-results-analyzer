import { Controller, Get, Inject, NotFoundException, Param } from "@nestjs/common";
import type { RunRepository } from "../../persistence/run-repository.js";
import { CATALOG_RUN_REPOSITORY } from "./catalog.tokens.js";

@Controller()
export class CatalogController {
  constructor(
    @Inject(CATALOG_RUN_REPOSITORY)
    private readonly runRepository: RunRepository,
  ) {}

  @Get("projects")
  async listProjects() {
    return {
      data: {
        projects: await this.runRepository.listProjects(),
      },
    };
  }

  @Get("projects/:projectId/suites")
  async listProjectSuites(
    @Param("projectId") projectId: string,
  ) {
    return {
      data: {
        suites: await this.runRepository.listSuites({ projectId }),
      },
    };
  }

  @Get("suites")
  async listSuites() {
    return {
      data: {
        suites: await this.runRepository.listSuites(),
      },
    };
  }

  @Get("suites/:suiteId")
  async getSuite(@Param("suiteId") suiteId: string) {
    const suite = await this.runRepository.getSuiteDetail(suiteId);

    if (suite === undefined) {
      throw new NotFoundException({
        code: "SUITE_NOT_FOUND",
        message: `Suite "${suiteId}" was not found`,
      });
    }

    return {
      data: suite,
    };
  }
}
