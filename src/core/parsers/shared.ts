import { ParserValidationError } from "./parser-validation-error.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJsonObjectInput(
  input: unknown,
  sourceLabel: string,
): Record<string, unknown> {
  const parsed = typeof input === "string" ? parseJsonString(input, sourceLabel) : input;

  if (!isRecord(parsed)) {
    throw new ParserValidationError(`Invalid ${sourceLabel} payload: expected object`);
  }

  return parsed;
}

export function maybeParseJsonObjectInput(input: unknown): Record<string, unknown> | undefined {
  try {
    const parsed = typeof input === "string" ? JSON.parse(input) : input;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function compactRecord(
  input: Record<string, unknown | undefined>,
): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

export function sortedEntries(
  record: Record<string, unknown>,
): Array<[string, unknown]> {
  return Object.entries(record).sort(([left], [right]) => left.localeCompare(right));
}

export function cloneSortedRecord(record: Record<string, unknown>): Record<string, unknown> {
  const cloned: Record<string, unknown> = {};

  for (const [key, value] of sortedEntries(record)) {
    if (isRecord(value)) {
      cloned[key] = cloneSortedRecord(value);
    } else if (Array.isArray(value)) {
      cloned[key] = [...value];
    } else {
      cloned[key] = value;
    }
  }

  return cloned;
}

export function filenameBase(filename?: string): string | undefined {
  const safeFilename = readNonEmptyString(filename);

  if (safeFilename === undefined) {
    return undefined;
  }

  const lastSegment = safeFilename.split(/[\\/]/).at(-1) ?? safeFilename;
  const withoutJsonExtension = lastSegment.replace(/\.json$/i, "");
  return readNonEmptyString(withoutJsonExtension);
}

function parseJsonString(input: string, sourceLabel: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw new ParserValidationError(
      `Invalid ${sourceLabel} payload: input string is not valid JSON`,
    );
  }
}
