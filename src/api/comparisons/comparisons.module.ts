import { DynamicModule, Module } from "@nestjs/common";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { PersistedComparisonService } from "../../comparisons/persisted-comparison.service.js";
import type { ComparisonRepository } from "../../persistence/comparison-repository.js";
import type { RunRepository } from "../../persistence/run-repository.js";
import { SqliteComparisonRepository } from "../../persistence/sqlite/sqlite-comparison.repository.js";
import { SqliteRunRepository } from "../../persistence/sqlite/sqlite-run.repository.js";
import { ComparisonsController } from "./comparisons.controller.js";
import {
  COMPARISON_REPOSITORY,
  COMPARISON_RUN_REPOSITORY,
  PERSISTED_COMPARISON_SERVICE,
} from "./comparisons.tokens.js";

export interface ComparisonsModuleOptions {
  database?: SqliteDatabase;
  runRepository?: RunRepository;
  comparisonRepository?: ComparisonRepository;
}

@Module({})
export class ComparisonsModule {
  static register(options: ComparisonsModuleOptions): DynamicModule {
    return {
      module: ComparisonsModule,
      controllers: [ComparisonsController],
      providers: [
        {
          provide: COMPARISON_RUN_REPOSITORY,
          useFactory: () => {
            if (options.runRepository !== undefined) {
              return options.runRepository;
            }

            if (options.database === undefined) {
              throw new Error("ComparisonsModule requires database or runRepository");
            }

            return new SqliteRunRepository(options.database);
          },
        },
        {
          provide: COMPARISON_REPOSITORY,
          useFactory: () => {
            if (options.comparisonRepository !== undefined) {
              return options.comparisonRepository;
            }

            if (options.database === undefined) {
              throw new Error("ComparisonsModule requires database or comparisonRepository");
            }

            return new SqliteComparisonRepository(options.database);
          },
        },
        {
          provide: PERSISTED_COMPARISON_SERVICE,
          useFactory: (
            runRepository: RunRepository,
            comparisonRepository: ComparisonRepository,
          ) => new PersistedComparisonService(runRepository, comparisonRepository),
          inject: [COMPARISON_RUN_REPOSITORY, COMPARISON_REPOSITORY],
        },
      ],
      exports: [
        COMPARISON_RUN_REPOSITORY,
        COMPARISON_REPOSITORY,
        PERSISTED_COMPARISON_SERVICE,
      ],
    };
  }
}
