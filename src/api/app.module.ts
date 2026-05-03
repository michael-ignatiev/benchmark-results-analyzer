import { DynamicModule, Module } from "@nestjs/common";
import type { ComparisonRepository } from "../persistence/comparison-repository.js";
import type { PgPoolLike } from "../persistence/postgres/types.js";
import type { RunRepository } from "../persistence/run-repository.js";
import { CatalogModule } from "./catalog/catalog.module.js";
import { ComparisonsModule } from "./comparisons/comparisons.module.js";
import { ReportsModule } from "./reports/reports.module.js";
import { SuiteHistoryModule } from "./suite-history/suite-history.module.js";

export interface ApiModuleOptions {
  database?: PgPoolLike;
  runRepository?: RunRepository;
  comparisonRepository?: ComparisonRepository;
}

@Module({})
export class ApiModule {
  static register(options: ApiModuleOptions): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CatalogModule.register(options),
        ComparisonsModule.register(options),
        ReportsModule.register(options),
        SuiteHistoryModule.register(options),
      ],
    };
  }
}
