import { ParserValidationError } from "./parser-validation-error.js";
import type { BenchmarkParser, ParsedRunPayload } from "./types.js";

export class ParserRegistry {
  private readonly parsers: BenchmarkParser[];

  constructor(parsers: BenchmarkParser[]) {
    this.parsers = [...parsers];
  }

  findParser(input: unknown, filename?: string): BenchmarkParser | undefined {
    return this.parsers.find((parser) => parser.canParse(input, filename));
  }

  parse(input: unknown, filename?: string): ParsedRunPayload {
    const parser = this.findParser(input, filename);

    if (parser === undefined) {
      throw new ParserValidationError(
        "Unable to find a parser for the provided benchmark payload",
        { code: "PARSER_NOT_FOUND" },
      );
    }

    return parser.parse(input, filename);
  }
}
