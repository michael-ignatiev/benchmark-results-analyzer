import { DynamicModule, Module } from "@nestjs/common";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { ComparisonRepository } from "../../persistence/comparison-repository.js";
import { SqliteComparisonRepository } from "../../persistence/sqlite/sqlite-comparison.repository.js";
import { ReportsController } from "./reports.controller.js";
import { REPORT_COMPARISON_REPOSITORY } from "./reports.tokens.js";

export interface ReportsModuleOptions {
  database?: SqliteDatabase;
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

            return new SqliteComparisonRepository(options.database);
          },
        },
      ],
      exports: [REPORT_COMPARISON_REPOSITORY],
    };
  }
}
