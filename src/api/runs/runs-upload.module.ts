import { DynamicModule, Module } from "@nestjs/common";
import { createDefaultParserRegistry } from "../../parsers/default-parser-registry.js";
import { PostgresRunRepository } from "../../persistence/postgres/postgres-run.repository.js";
import type { PgPoolLike } from "../../persistence/postgres/types.js";
import type { RunRepository } from "../../persistence/run-repository.js";
import { RunIngestionService } from "../../runs/run-ingestion.service.js";
import { RunsUploadController } from "./runs-upload.controller.js";
import {
  PARSER_REGISTRY,
  RUN_INGESTION_SERVICE,
  RUN_REPOSITORY,
} from "./runs-upload.tokens.js";

export interface RunsUploadModuleOptions {
  database?: PgPoolLike;
  runRepository?: RunRepository;
}

@Module({})
export class RunsUploadModule {
  static register(options: RunsUploadModuleOptions): DynamicModule {
    return {
      module: RunsUploadModule,
      controllers: [RunsUploadController],
      providers: [
        {
          provide: PARSER_REGISTRY,
          useFactory: createDefaultParserRegistry,
        },
        {
          provide: RUN_REPOSITORY,
          useFactory: () => {
            if (options.runRepository !== undefined) {
              return options.runRepository;
            }

            if (options.database === undefined) {
              throw new Error("RunsUploadModule requires database or runRepository");
            }

            return new PostgresRunRepository(options.database);
          },
        },
        {
          provide: RUN_INGESTION_SERVICE,
          useFactory: (
            parserRegistry: ReturnType<typeof createDefaultParserRegistry>,
            runRepository: RunRepository,
          ) => new RunIngestionService(parserRegistry, runRepository),
          inject: [PARSER_REGISTRY, RUN_REPOSITORY],
        },
      ],
      exports: [PARSER_REGISTRY, RUN_REPOSITORY, RUN_INGESTION_SERVICE],
    };
  }
}
