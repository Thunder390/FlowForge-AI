/**
 * Expression parsing, dispatched on the document's `expression_grammar`.
 *
 * The grammar is versioned separately from `ffir_version` on purpose.
 * Expressions live inside strings inside parameter values, so a grammar change
 * cannot be handled by the FFIR migration chain without rewriting every stored
 * string in every stored document. Versioning it independently means an old
 * document keeps parsing under the rules it was written against.
 *
 * The consequence for this module is the important one: a document declaring a
 * grammar this build does not implement is **rejected, not parsed
 * optimistically**. Parsing version 2 with the version 1 parser would
 * mis-parse rather than fail, and a mis-parsed expression compiles to a
 * workflow that silently reads the wrong field.
 */

import { SUPPORTED_EXPRESSION_GRAMMARS } from "../types.js";
import { ErrorCode } from "../validate/codes.js";
import { invalid, type ValidationError, type ValidationResult } from "../validate/result.js";
import type { Template } from "./ast.js";
import type { GrammarParser, SyntaxFailure } from "./diagnostics.js";
import { parseTemplateV1 } from "./grammar/v1.js";

/**
 * Every grammar this build implements.
 *
 * The keys must equal `SUPPORTED_EXPRESSION_GRAMMARS`, which types.ts declares
 * and the schema documentation refers to. A test pins the agreement, because a
 * grammar advertised as supported and absent here would be rejected at parse
 * time with a message saying it is supported.
 *
 * A `Map` rather than an object literal because the version string arrives from
 * an untrusted document, and an object lookup for `"constructor"` returns a
 * function rather than `undefined`.
 */
const GRAMMARS: ReadonlyMap<string, GrammarParser> = new Map([
  ["1", parseTemplateV1],
]);

export type ParseResult =
  | { ok: true; template: Template }
  | { ok: false; errors: ValidationError[] };

export interface ParseOptions {
  /**
   * JSON Pointer to the string being parsed, used as the error path so a
   * failure names the node and parameter it came from. Defaults to `""`.
   */
  path?: string;
}

/** True when this build implements the named grammar version. */
export function isSupportedGrammar(grammar: string): boolean {
  return GRAMMARS.has(grammar);
}

/** The grammar versions this build implements, for diagnostics and tests. */
export function supportedGrammars(): string[] {
  return [...GRAMMARS.keys()];
}

/**
 * Parses one parameter string under the given grammar version.
 *
 * A string with no braces in it is a valid template with a single literal part,
 * not an error: most parameter values are plain text and must pass through
 * untouched.
 */
export function parseTemplate(
  source: string,
  grammar: string,
  options: ParseOptions = {},
): ParseResult {
  const path = options.path ?? "";

  const parser = GRAMMARS.get(grammar);
  if (parser === undefined) {
    return { ok: false, errors: [unsupportedGrammarError(grammar, path)] };
  }

  const result = parser(source);
  if (!result.ok) {
    return {
      ok: false,
      errors: result.failures.map((f) => toValidationError(f, grammar, path)),
    };
  }

  return { ok: true, template: { source, parts: result.parts } };
}

/**
 * Parse result as a `ValidationResult`, for callers that only need pass or fail
 * and want it in the same shape every other validation stage returns.
 */
export function checkTemplate(
  source: string,
  grammar: string,
  options: ParseOptions = {},
): ValidationResult {
  const result = parseTemplate(source, grammar, options);
  return invalid(result.ok ? [] : result.errors);
}

/**
 * Terminal, not repairable. Re-prompting a model cannot change which grammar
 * versions this build implements.
 */
function unsupportedGrammarError(grammar: string, path: string): ValidationError {
  return {
    code: ErrorCode.EXPRESSION_GRAMMAR_UNSUPPORTED,
    path,
    message: `This build implements expression grammar ${SUPPORTED_EXPRESSION_GRAMMARS.join(", ")} and cannot read grammar ${grammar}. The document is rejected rather than parsed under a grammar it was not written against.`,
    details: { declared: grammar, supported: supportedGrammars() },
  };
}

function toValidationError(
  syntax: SyntaxFailure,
  grammar: string,
  path: string,
): ValidationError {
  const details: Record<string, unknown> = {
    grammar,
    offset: syntax.offset,
    length: syntax.length,
  };
  if (syntax.expected !== undefined) details["expected"] = syntax.expected;
  if (syntax.found !== undefined) details["found"] = syntax.found;
  if (syntax.expression !== undefined) details["expression"] = syntax.expression;

  const where =
    syntax.expression === undefined
      ? `at offset ${syntax.offset}`
      : `${JSON.stringify(syntax.expression)} at offset ${syntax.offset}`;

  const expected =
    syntax.expected === undefined ? "" : ` Expected ${syntax.expected}.`;

  return {
    code: ErrorCode.EXPRESSION_PARSE_ERROR,
    path,
    message: `Expression ${where} does not parse under grammar ${grammar}: ${syntax.message}${expected}`,
    details,
  };
}
