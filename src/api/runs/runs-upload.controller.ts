import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ParserValidationError } from "../../parsers/parser-validation-error.js";
import type { RunIngestionResult, RunIngestionService } from "../../runs/run-ingestion.service.js";
import { RUN_INGESTION_SERVICE } from "./runs-upload.tokens.js";
import { parseRunsUploadMetadata, uploadValidationError } from "./runs-upload.validation.js";

@Controller("runs")
export class RunsUploadController {
  constructor(
    @Inject(RUN_INGESTION_SERVICE)
    private readonly runIngestionService: RunIngestionService,
  ) {}

  @Post("upload")
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor("file"))
  async uploadRun(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: Record<string, unknown>,
  ) {
    if (file === undefined) {
      throw uploadValidationError("file is required");
    }

    if (file.buffer === undefined || file.buffer.length === 0) {
      throw uploadValidationError("file must not be empty");
    }

    const metadata = parseRunsUploadMetadata(body);

    try {
      const uploadInput = {
        filename: file.originalname,
        content: file.buffer.toString("utf8"),
        project: metadata.project,
      };

      if (metadata.suite !== undefined) {
        Object.assign(uploadInput, { suite: metadata.suite });
      }

      if (metadata.run !== undefined) {
        Object.assign(uploadInput, { run: metadata.run });
      }

      const result = await this.runIngestionService.ingestBenchmarkArtifact(uploadInput);

      return buildUploadResponse(file.originalname, result);
    } catch (error) {
      if (error instanceof ParserValidationError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
          sourceType: error.sourceType,
        });
      }

      throw error;
    }
  }
}

function buildUploadResponse(
  sourceFilename: string,
  result: RunIngestionResult,
) {
  return {
    data: {
      projectId: result.persistedRun.projectId,
      suiteId: result.persistedRun.suiteId,
      runId: result.persistedRun.runId,
      sourceType: result.parsedRun.sourceType,
      sourceFilename,
      metrics: {
        inserted: result.persistedRun.metricsInserted,
        ids: result.persistedRun.metricIds,
      },
      parsed: {
        suite: result.parsedRun.suite,
        run: result.parsedRun.run,
        metricCount: result.parsedRun.metrics.length,
      },
    },
  };
}
