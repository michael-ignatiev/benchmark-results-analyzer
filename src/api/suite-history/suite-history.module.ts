import { DynamicModule, Module } from "@nestjs/common";
import { PostgresRunRepository } from "../../persistence/postgres/postgres-run.repository.js";
import type { PgPoolLike } from "../../persistence/postgres/types.js";
import type { RunRepository } from "../../persistence/run-repository.js";
import { SuiteHistoryController } from "./suite-history.controller.js";
import { SUITE_HISTORY_RUN_REPOSITORY } from "./suite-history.tokens.js";

export interface SuiteHistoryModuleOptions {
  database?: PgPoolLike;
  runRepository?: RunRepository;
}

@Module({})
export class SuiteHistoryModule {
  static register(options: SuiteHistoryModuleOptions): DynamicModule {
    return {
      module: SuiteHistoryModule,
      controllers: [SuiteHistoryController],
      providers: [
        {
          provide: SUITE_HISTORY_RUN_REPOSITORY,
          useFactory: () => {
            if (options.runRepository !== undefined) {
              return options.runRepository;
            }

            if (options.database === undefined) {
              throw new Error("SuiteHistoryModule requires database or runRepository");
            }

            return new PostgresRunRepository(options.database);
          },
        },
      ],
      exports: [SUITE_HISTORY_RUN_REPOSITORY],
    };
  }
}
