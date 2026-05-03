import { DynamicModule, Module } from "@nestjs/common";
import type { ComparisonRepository } from "../../persistence/comparison-repository.js";
import { PostgresComparisonRepository } from "../../persistence/postgres/postgres-comparison.repository.js";
import type { PgPoolLike } from "../../persistence/postgres/types.js";
import { ReportsController } from "./reports.controller.js";
import { REPORT_COMPARISON_REPOSITORY } from "./reports.tokens.js";

export interface ReportsModuleOptions {
  database?: PgPoolLike;
  comparisonRepository?: ComparisonRepository;
}

@Module({})
export class ReportsModule {
  static register(options: ReportsModuleOptions): DynamicModule {
    return {
      module: ReportsModule,
      controllers: [ReportsController],
      providers: [
        {
          provide: REPORT_COMPARISON_REPOSITORY,
          useFactory: () => {
            if (options.comparisonRepository !== undefined) {
              return options.comparisonRepository;
            }

            if (options.database === undefined) {
              throw new Error("ReportsModule requires database or comparisonRepository");
            }

            return new PostgresComparisonRepository(options.database);
          },
        },
      ],
      exports: [REPORT_COMPARISON_REPOSITORY],
    };
  }
}
