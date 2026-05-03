import type { SourceType } from "./types.js";

export interface ParserValidationErrorOptions {
  sourceType?: SourceType;
  code?: string;
  issues?: string[];
}

export class ParserValidationError extends Error {
  readonly sourceType?: SourceType;
  readonly code: string;
  readonly issues?: string[];

  constructor(message: string, options: ParserValidationErrorOptions = {}) {
    super(message);
    this.name = "ParserValidationError";
    this.code = options.code ?? "PARSER_VALIDATION_ERROR";

    if (options.sourceType !== undefined) {
      this.sourceType = options.sourceType;
    }

    if (options.issues !== undefined) {
      this.issues = options.issues;
    }
  }
}
