export interface IdRow {
  id: string | number;
}

export function idToString(id: string | number | bigint): string {
  return id.toString();
}

export function lastInsertRowIdToString(id: number | bigint): string {
  return id.toString();
}

export function jsonParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function timestampToIsoString(value: string): string {
  return new Date(value).toISOString();
}

export function parseMaybeJson(value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? JSON.parse(value) : value;
}

export function jsonRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = parseMaybeJson(value);

  if (parsed === undefined) {
    return undefined;
  }

  if (isRecord(parsed)) {
    return parsed;
  }

  throw new Error("Stored JSON value is not an object");
}

export function nullableNumber(value: number | string | null): number | null {
  if (value === null) {
    return null;
  }

  return typeof value === "number" ? value : Number(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
