import { access, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ThresholdRule } from "../core/index.js";
import { CliError } from "./errors.js";

export const DEFAULT_CONFIG_FILENAME = ".benchmark-analyzer.json";
export const DEFAULT_SQLITE_STORAGE_PATH = ".benchmark-analyzer/runs.db";

export interface BenchmarkAnalyzerStorageConfig {
  type: "sqlite";
  path: string;
}

export interface BenchmarkAnalyzerConfig {
  projectName?: string;
  projectDescription?: string;
  storage?: BenchmarkAnalyzerStorageConfig;
  thresholdRules?: ThresholdRule[];
  metadataDefaults?: Record<string, unknown>;
}

export interface WriteInitialConfigInput {
  explicitPath?: string;
  projectName?: string;
  projectDescription?: string;
  sqlitePath?: string;
  thresholdRules?: ThresholdRule[];
  metadataDefaults?: Record<string, unknown>;
  force?: boolean;
}

export async function loadConfig(
  cwd: string,
  explicitPath?: string,
): Promise<BenchmarkAnalyzerConfig> {
  const configPath = resolveConfigPath(cwd, explicitPath);

  if (!(await pathExists(configPath))) {
    if (explicitPath !== undefined) {
      throw new CliError(`Config file not found: ${configPath}`);
    }

    return {};
  }

  const parsed = parseJson(await readFile(configPath, "utf8"), configPath);

  if (!isRecord(parsed)) {
    throw new CliError(`Config file must contain a JSON object: ${configPath}`);
  }

  return normalizeConfig(parsed, configPath);
}

export async function writeInitialConfig(
  cwd: string,
  input: WriteInitialConfigInput,
): Promise<string> {
  const configPath = resolveConfigPath(cwd, input.explicitPath);

  if (!input.force && (await pathExists(configPath))) {
    throw new CliError(
      `Config already exists: ${configPath}. Re-run with --force to overwrite.`,
    );
  }

  const config: BenchmarkAnalyzerConfig = {
    projectName: nonEmptyOrDefault(
      input.projectName,
      basename(cwd) || "benchmark-project",
      "project name",
    ),
    storage: {
      type: "sqlite",
      path: nonEmptyOrDefault(
        input.sqlitePath,
        DEFAULT_SQLITE_STORAGE_PATH,
        "SQLite storage path",
      ),
    },
    thresholdRules: input.thresholdRules ?? [],
    metadataDefaults: input.metadataDefaults ?? {},
  };
  const projectDescription = nonEmptyOrUndefined(
    input.projectDescription,
    "project description",
  );

  if (projectDescription !== undefined) {
    config.projectDescription = projectDescription;
  }

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

export function resolveConfigPath(cwd: string, explicitPath?: string): string {
  return resolve(cwd, explicitPath ?? DEFAULT_CONFIG_FILENAME);
}

function normalizeConfig(
  value: Record<string, unknown>,
  configPath: string,
): BenchmarkAnalyzerConfig {
  const config: BenchmarkAnalyzerConfig = {};

  if (value.projectName !== undefined) {
    config.projectName = requiredString(value.projectName, "projectName", configPath);
  }

  if (value.projectDescription !== undefined) {
    config.projectDescription = requiredString(
      value.projectDescription,
      "projectDescription",
      configPath,
    );
  }

  if (value.storage !== undefined) {
    if (!isRecord(value.storage)) {
      throw new CliError(`Config field "storage" must be an object: ${configPath}`);
    }

    const storageType = requiredString(value.storage.type, "storage.type", configPath);

    if (storageType !== "sqlite") {
      throw new CliError(`Unsupported config storage.type "${storageType}"`);
    }

    config.storage = {
      type: "sqlite",
      path: requiredString(value.storage.path, "storage.path", configPath),
    };
  }

  if (value.thresholdRules !== undefined) {
    if (!Array.isArray(value.thresholdRules)) {
      throw new CliError(`Config field "thresholdRules" must be an array: ${configPath}`);
    }

    config.thresholdRules = value.thresholdRules as ThresholdRule[];
  }

  if (value.metadataDefaults !== undefined) {
    if (!isRecord(value.metadataDefaults)) {
      throw new CliError(`Config field "metadataDefaults" must be an object: ${configPath}`);
    }

    config.metadataDefaults = value.metadataDefaults;
  }

  return config;
}

function parseJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(`Invalid JSON in ${path}: ${detail}`);
  }
}

function requiredString(value: unknown, field: string, configPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CliError(`Config field "${field}" must be a non-empty string: ${configPath}`);
  }

  return value;
}

function nonEmptyOrDefault(
  value: string | undefined,
  fallback: string,
  field: string,
): string {
  return nonEmptyOrUndefined(value, field) ?? fallback;
}

function nonEmptyOrUndefined(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new CliError(`Init ${field} must be a non-empty string`);
  }

  return trimmed;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
