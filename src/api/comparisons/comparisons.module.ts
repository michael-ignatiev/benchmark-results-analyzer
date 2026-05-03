import { DynamicModule, Module } from "@nestjs/common";
import { PersistedComparisonService } from "../../comparisons/persisted-comparison.service.js";
import type { ComparisonRepository } from "../../persistence/comparison-repository.js";
import { PostgresComparisonRepository } from "../../persistence/postgres/postgres-comparison.repository.js";
import { PostgresRunRepository } from "../../persistence/postgres/postgres-run.repository.js";
import type { PgPoolLike } from "../../persistence/postgres/types.js";
import type { RunRepository } from "../../persistence/run-repository.js";
import { ComparisonsController } from "./comparisons.controller.js";
import {
  COMPARISON_REPOSITORY,
  COMPARISON_RUN_REPOSITORY,
  PERSISTED_COMPARISON_SERVICE,
} from "./comparisons.tokens.js";

export interface ComparisonsModuleOptions {
  database?: PgPoolLike;
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

            return new PostgresRunRepository(options.database);
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

            return new PostgresComparisonRepository(options.database);
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
