import { DynamicModule, Module } from "@nestjs/common";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { RunRepository } from "../../persistence/run-repository.js";
import { SqliteRunRepository } from "../../persistence/sqlite/sqlite-run.repository.js";
import { CatalogController } from "./catalog.controller.js";
import { CATALOG_RUN_REPOSITORY } from "./catalog.tokens.js";

export interface CatalogModuleOptions {
  database?: SqliteDatabase;
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

            return new SqliteRunRepository(options.database);
          },
        },
      ],
      exports: [CATALOG_RUN_REPOSITORY],
    };
  }
}
