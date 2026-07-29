/**
 * The contract every grammar implementation satisfies.
 *
 * It lives apart from both `ast.ts` and `parse.ts` so that a grammar module can
 * depend on it without depending on the dispatcher that selects it, which is
 * what keeps version dispatch a one-line table rather than a cycle.
 */

import type { TemplatePart } from "./ast.js";

/**
 * A positioned syntax failure.
 *
 * Offsets are absolute within the template source, not relative to the
 * expression, because the caller holds the source and the repair prompt quotes
 * it. A failure that says "column 3" of something the reader cannot see is not
 * a positioned error.
 */
export interface SyntaxFailure {
  /** Character offset into the template source. */
  offset: number;
  /** Length of the offending span. At least 1, so a caret always has width. */
  length: number;
  /** Specific enough to act on without reading the grammar. */
  message: string;
  /** What the grammar permits here, when that is a short enough list to state. */
  expected?: string;
  /** The offending text, when quoting it helps. */
  found?: string;
  /** The whole `{{ ... }}` the failure occurred inside, when there is one. */
  expression?: string;
}

export type GrammarParseResult =
  | { ok: true; parts: TemplatePart[] }
  | { ok: false; failures: SyntaxFailure[] };

/**
 * Parses one template source string. Implementations collect every failure in
 * the string rather than stopping at the first, because the repair prompt needs
 * the complete list to fix everything in one retry.
 */
export type GrammarParser = (source: string) => GrammarParseResult;
