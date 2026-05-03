import { DynamicModule, Module } from "@nestjs/common";
import { PostgresRunRepository } from "../../persistence/postgres/postgres-run.repository.js";
import type { PgPoolLike } from "../../persistence/postgres/types.js";
import type { RunRepository } from "../../persistence/run-repository.js";
import { CatalogController } from "./catalog.controller.js";
import { CATALOG_RUN_REPOSITORY } from "./catalog.tokens.js";

export interface CatalogModuleOptions {
  database?: PgPoolLike;
  runRepository?: RunRepository;
}

@Module({})
export class CatalogModule {
  static register(options: CatalogModuleOptions): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [CatalogController],
      providers: [
        {
          provide: CATALOG_RUN_REPOSITORY,
          useFactory: () => {
            if (options.runRepository !== undefined) {
              return options.runRepository;
            }

            if (options.database === undefined) {
              throw new Error("CatalogModule requires database or runRepository");
            }

            return new PostgresRunRepository(options.database);
          },
        },
      ],
      exports: [CATALOG_RUN_REPOSITORY],
    };
  }
}
