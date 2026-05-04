import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { resolve } from "node:path";
import { ApiModule } from "./api/app.module.js";
import { openSqliteDatabase } from "./persistence/sqlite/open-sqlite-database.js";

const port = Number(process.env.PORT ?? 3000);
const databasePath = resolve(
  process.cwd(),
  process.env.BENCHMARK_ANALYZER_DB ?? ".benchmark-analyzer/runs.db",
);
const database = await openSqliteDatabase(databasePath);

const app = await NestFactory.create(ApiModule.register({ database }));
app.enableCors({ origin: true });
await app.listen(port);
