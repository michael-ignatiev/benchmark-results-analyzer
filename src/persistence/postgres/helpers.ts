import type { PgPoolLike, PgQueryable } from "./types.js";

export interface IdRow {
  id: string | number;
}

export async function withOptionalTransaction<T>(
  database: PgPoolLike,
  operation: (client: PgQueryable) => Promise<T>,
): Promise<T> {
  if (database.connect === undefined) {
    return operation(database);
  }

  const client = await database.connect();

  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release?.();
  }
}

export function requiredInsertedId(row: IdRow | undefined, entityName: string): string {
  if (row === undefined) {
    throw new Error(`PostgreSQL did not return inserted ${entityName} id`);
  }

  return idToString(row.id);
}

export function idToString(id: string | number): string {
  return id.toString();
}

export function jsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function timestampToIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
