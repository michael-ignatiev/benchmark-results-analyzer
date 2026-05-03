import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

import type {
  Database as SqliteDatabase,
  Options as SqliteOptions,
} from "better-sqlite3";

import { applySqliteSchema } from "./schema.js";

const require = createRequire(import.meta.url);

export async function openSqliteDatabase(path: string): Promise<SqliteDatabase> {
  await mkdir(dirname(path), { recursive: true });

  const BetterSqlite3 = require("better-sqlite3") as {
    new (filename: string, options?: SqliteOptions): SqliteDatabase;
  };
  const database = new BetterSqlite3(path);
  applySqliteSchema(database);

  return database;
}
