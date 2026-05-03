import { BadRequestException } from "@nestjs/common";
import type { PersistProjectInput } from "../../persistence/run-repository.js";
import type { UploadedBenchmarkFile } from "../../runs/run-ingestion.service.js";

export interface RunsUploadMetadata {
  project: PersistProjectInput;
  suite?: UploadedBenchmarkFile["suite"];
  run?: UploadedBenchmarkFile["run"];
}

type UploadBody = Record<string, unknown>;

export function parseRunsUploadMetadata(body: UploadBody): RunsUploadMetadata {
  const projectJson = readJsonRecordField(body, "project");
  const suiteJson = readJsonRecordField(body, "suite");
  const runJson = readJsonRecordField(body, "run");
  const projectName = readString(projectJson?.name) ?? readString(body.projectName);

  if (projectName === undefined) {
    throw uploadValidationError("project.name or projectName is required");
  }

  const project: PersistProjectInput = {
    name: projectName,
  };
  const projectDescription =
    readString(projectJson?.description) ?? readString(body.projectDescription);
  const projectMetadata =
    readRecord(projectJson?.metadata, "project.metadata") ??
    readJsonRecordField(body, "projectMetadata");

  if (projectDescription !== undefined) {
    project.description = projectDescription;
  }

  if (projectMetadata !== undefined) {
    project.metadata = projectMetadata;
  }

  const suite = buildSuiteMetadata(body, suiteJson);
  const run = buildRunMetadata(body, runJson);

  return {
    project,
    ...(suite !== undefined ? { suite } : {}),
    ...(run !== undefined ? { run } : {}),
  };
}

function buildSuiteMetadata(
  body: UploadBody,
  suiteJson: Record<string, unknown> | undefined,
): UploadedBenchmarkFile["suite"] {
  const suite: NonNullable<UploadedBenchmarkFile["suite"]> = {};
  const suiteName = readString(suiteJson?.name) ?? readString(body.suiteName);
  const scenarioName = readString(suiteJson?.scenarioName) ?? readString(body.scenarioName);
  const tags =
    readRecord(suiteJson?.tags, "suite.tags") ?? readJsonRecordField(body, "suiteTags");

  if (suiteName !== undefined) {
    suite.name = suiteName;
  }

  if (scenarioName !== undefined) {
    suite.scenarioName = scenarioName;
  }

  if (tags !== undefined) {
    suite.tags = tags;
  }

  return Object.keys(suite).length > 0 ? suite : undefined;
}

function buildRunMetadata(
  body: UploadBody,
  runJson: Record<string, unknown> | undefined,
): UploadedBenchmarkFile["run"] {
  const run: NonNullable<UploadedBenchmarkFile["run"]> = {};
  assignString(run, "label", readString(runJson?.label) ?? readString(body.label));
  assignString(run, "commitSha", readString(runJson?.commitSha) ?? readString(body.commitSha));
  assignString(
    run,
    "branchName",
    readString(runJson?.branchName) ?? readString(runJson?.branch) ?? readString(body.branchName),
  );
  assignString(
    run,
    "environment",
    readString(runJson?.environment) ?? readString(body.environment),
  );

  const runAt = readString(runJson?.runAt) ?? readString(body.runAt);

  if (runAt !== undefined) {
    if (Number.isNaN(Date.parse(runAt))) {
      throw uploadValidationError("runAt must be a valid ISO date-time string");
    }

    run.runAt = runAt;
  }

  const durationMs = readNumber(runJson?.durationMs) ?? readNumber(body.durationMs);

  if (durationMs !== undefined) {
    if (!Number.isInteger(durationMs) || durationMs < 0) {
      throw uploadValidationError("durationMs must be a non-negative integer");
    }

    run.durationMs = durationMs;
  }

  const metadata =
    readRecord(runJson?.metadata, "run.metadata") ?? readJsonRecordField(body, "runMetadata");

  if (metadata !== undefined) {
    run.metadata = metadata;
  }

  return Object.keys(run).length > 0 ? run : undefined;
}

function assignString<T extends keyof NonNullable<UploadedBenchmarkFile["run"]>>(
  run: NonNullable<UploadedBenchmarkFile["run"]>,
  key: T,
  value: NonNullable<UploadedBenchmarkFile["run"]>[T],
): void {
  if (typeof value === "string") {
    run[key] = value;
  }
}

function readJsonRecordField(
  body: UploadBody,
  fieldName: string,
): Record<string, unknown> | undefined {
  const value = body[fieldName];

  if (value === undefined) {
    return undefined;
  }

  if (isRecord(value)) {
    return value;
  }

  const stringValue = readString(value);

  if (stringValue === undefined) {
    throw uploadValidationError(`${fieldName} must be a JSON object`);
  }

  try {
    const parsed = JSON.parse(stringValue);

    if (!isRecord(parsed)) {
      throw uploadValidationError(`${fieldName} must be a JSON object`);
    }

    return parsed;
  } catch (error) {
    if (error instanceof BadRequestException) {
      throw error;
    }

    throw uploadValidationError(`${fieldName} must be valid JSON`);
  }
}

function readRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    throw uploadValidationError(`${label} must be an object`);
  }

  return value;
}

function readString(value: unknown): string | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue !== "string") {
    return undefined;
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(value: unknown): number | undefined {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (typeof rawValue === "number" && Number.isFinite(rawValue)) {
    return rawValue;
  }

  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return undefined;
  }

  const parsed = Number(rawValue);

  if (!Number.isFinite(parsed)) {
    throw uploadValidationError("durationMs must be numeric");
  }

  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function uploadValidationError(message: string): BadRequestException {
  return new BadRequestException({
    code: "UPLOAD_VALIDATION_ERROR",
    message,
  });
}
