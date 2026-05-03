import { CliError } from "./errors.js";

export interface ParsedCliArgs {
  command?: string;
  positionals: string[];
  options: Map<string, string[]>;
}

const BOOLEAN_OPTIONS = new Set([
  "force",
  "git",
  "help",
  "json",
  "latest",
  "no-git",
  "no-save",
  "previous",
]);

export function parseCliArgs(argv: string[]): ParsedCliArgs {
  const [first, ...rest] = argv;
  const command = first !== undefined && !first.startsWith("-") ? first : undefined;
  const tokens = command === undefined ? argv : rest;
  const positionals: string[] = [];
  const options = new Map<string, string[]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === undefined) {
      continue;
    }

    if (token === "--") {
      positionals.push(...tokens.slice(index + 1));
      break;
    }

    if (token === "-h") {
      pushOption(options, "help", "true");
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const withoutPrefix = token.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    const optionName =
      equalsIndex === -1 ? withoutPrefix : withoutPrefix.slice(0, equalsIndex);

    if (optionName.length === 0) {
      throw new CliError(`Invalid option "${token}"`);
    }

    if (equalsIndex !== -1) {
      pushOption(options, optionName, withoutPrefix.slice(equalsIndex + 1));
      continue;
    }

    if (BOOLEAN_OPTIONS.has(optionName)) {
      pushOption(options, optionName, "true");
      continue;
    }

    const next = tokens[index + 1];

    if (next === undefined || next.startsWith("-")) {
      throw new CliError(`Option --${optionName} requires a value`);
    }

    pushOption(options, optionName, next);
    index += 1;
  }

  const parsed: ParsedCliArgs = { positionals, options };

  if (command !== undefined) {
    parsed.command = command;
  }

  return parsed;
}

export function hasOption(args: ParsedCliArgs, name: string): boolean {
  return args.options.has(name);
}

export function getStringOption(
  args: ParsedCliArgs,
  name: string,
): string | undefined {
  const values = args.options.get(name);
  return values?.at(-1);
}

export function getStringOptions(args: ParsedCliArgs, name: string): string[] {
  return args.options.get(name) ?? [];
}

export function getRequiredStringOption(
  args: ParsedCliArgs,
  name: string,
  fallback?: string,
): string {
  const value = getStringOption(args, name) ?? fallback;

  if (value === undefined || value.trim().length === 0) {
    throw new CliError(`Missing required option --${name}`);
  }

  return value;
}

function pushOption(
  options: Map<string, string[]>,
  name: string,
  value: string,
): void {
  const existing = options.get(name) ?? [];
  existing.push(value);
  options.set(name, existing);
}
