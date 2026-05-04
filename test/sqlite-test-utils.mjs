import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  openSqliteDatabase,
  SqliteComparisonRepository,
  SqliteRunRepository,
} from "../dist/index.js";

export async function createSqliteDatabase(prefix = "bra-test-") {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  return openSqliteDatabase(join(cwd, "test.db"));
}

export async function createRunRepository(prefix) {
  const database = await createSqliteDatabase(prefix);

  return {
    database,
    repository: new SqliteRunRepository(database),
  };
}

export async function createRepositories(prefix) {
  const database = await createSqliteDatabase(prefix);

  return {
    database,
    runRepository: new SqliteRunRepository(database),
    comparisonRepository: new SqliteComparisonRepository(database),
  };
}

export function countRows(database, tableName) {
  const result = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get();
  return Number(result.count);
}
