export class ComparisonValidationError extends Error {
  readonly code: string;

  constructor(message: string, code = "COMPARISON_VALIDATION_ERROR") {
    super(message);
    this.name = "ComparisonValidationError";
    this.code = code;
  }
}
