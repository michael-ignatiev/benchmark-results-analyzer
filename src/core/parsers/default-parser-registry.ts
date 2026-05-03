import { K6Parser } from "./k6/k6.parser.js";
import { JestParser } from "./jest/jest.parser.js";
import { ParserRegistry } from "./parser-registry.js";

export function createDefaultParserRegistry(): ParserRegistry {
  return new ParserRegistry([new K6Parser(), new JestParser()]);
}
