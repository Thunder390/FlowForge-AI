/**
 * Expression grammar version 1.
 *
 *     expression   := "{{" ws reference ws "}}"
 *     reference    := node_ref | var_ref | builtin
 *     node_ref     := node_id ( "." path_segment )+
 *     var_ref      := "$vars." identifier
 *     builtin      := "$now" | "$workflow_id" | "$execution_id"
 *     path_segment := identifier | identifier "[" integer "]"
 *     node_id      := identifier
 *
 * Transcribed from the grammar block in docs/WORKFLOW_SCHEMA.md and implemented
 * strictly. Deliberately excluded from version 1: arithmetic, function calls,
 * ternaries, string concatenation inside the braces, and inline JavaScript.
 * Those exist on n8n but not on Zapier, and accepting them here would make FFIR
 * uncompilable to the more restrictive platforms. Anything needing real
 * computation becomes an explicit `transform` node instead.
 *
 * Strictness is the point. A parser that accepts more than the grammar states
 * moves the failure from here, where it is one positioned error, to a target's
 * lowering stage, where it is a miscompile. Every rejection below is a rejection
 * the spec asks for, and widening the grammar is a version bump rather than a
 * patch.
 */

import {
  BUILTIN_NAMES,
  VARS_PREFIX,
  type BuiltinName,
  type PathSegment,
  type Reference,
  type TemplatePart,
} from "../ast.js";
import type { GrammarParseResult, SyntaxFailure } from "../diagnostics.js";

const OPEN = "{{";
const CLOSE = "}}";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*/;
/** No leading zeros, so one index has exactly one source form. */
const INTEGER = /^(?:0|[1-9][0-9]*)/;

const BUILTIN_SOURCE_FORMS = BUILTIN_NAMES.map((name) => `$${name}`);
const REFERENCE_FORMS = `${BUILTIN_SOURCE_FORMS.join(", ")}, $vars.<variable_id>, or <node_id>.<field>`;

/** Reading position within a slice of the source, tracking absolute offsets. */
interface Cursor {
  readonly text: string;
  /** Offset of `text[0]` within the template source. */
  readonly base: number;
  pos: number;
}

type ReferenceResult =
  | { ok: true; reference: Reference }
  | { ok: false; failure: SyntaxFailure };

/**
 * Parses a template: literal text with `{{ ... }}` expressions embedded in it.
 *
 * Collects every failure in the string. After a bad expression it resumes at
 * that expression's `}}`, so one mistake does not mask the rest.
 */
export function parseTemplateV1(source: string): GrammarParseResult {
  const parts: TemplatePart[] = [];
  const failures: SyntaxFailure[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf(OPEN, cursor);
    if (open === -1) {
      pushLiteral(parts, source.slice(cursor));
      cursor = source.length;
      break;
    }

    pushLiteral(parts, source.slice(cursor, open));

    const close = source.indexOf(CLOSE, open + OPEN.length);
    if (close === -1) {
      // Grammar 1 has no escape for a literal `{{`, so an unclosed one is
      // always a mistake. Treating it as text would silently drop a reference
      // the author meant to make, which is the worse failure.
      failures.push({
        offset: open,
        length: source.length - open,
        message: `Unterminated expression: "${OPEN}" is never closed by "${CLOSE}".`,
        found: source.slice(open),
      });
      break;
    }

    const innerStart = open + OPEN.length;
    const inner = source.slice(innerStart, close);
    const raw = source.slice(open, close + CLOSE.length);

    const result = parseReference(inner, innerStart);
    if (result.ok) {
      parts.push({ type: "expression", reference: result.reference, raw, offset: open });
    } else {
      failures.push({ ...result.failure, expression: raw });
    }

    cursor = close + CLOSE.length;
  }

  if (failures.length > 0) return { ok: false, failures };
  return { ok: true, parts };
}

function pushLiteral(parts: TemplatePart[], value: string): void {
  if (value !== "") parts.push({ type: "literal", value });
}

/**
 * Parses the text between the braces. Whitespace is permitted only at the two
 * edges: the grammar puts `ws` outside `reference` and nowhere inside it.
 */
function parseReference(inner: string, innerBase: number): ReferenceResult {
  const leading = inner.length - inner.trimStart().length;
  const body = inner.trim();
  const base = innerBase + leading;

  if (body === "") {
    return {
      ok: false,
      failure: failure(innerBase, Math.max(inner.length, OPEN.length), {
        message: "An expression must contain a reference.",
        expected: REFERENCE_FORMS,
      }),
    };
  }

  const cursor: Cursor = { text: body, base, pos: 0 };
  const parsed = body.startsWith("$") ? parseDollarForm(cursor) : parseNodeRef(cursor);
  if (!parsed.ok) return parsed;

  if (cursor.pos < body.length) {
    return { ok: false, failure: trailingFailure(cursor, parsed.reference) };
  }

  return parsed;
}

/** `$vars.<identifier>` or one of the builtins. */
function parseDollarForm(cursor: Cursor): ReferenceResult {
  if (cursor.text.startsWith(VARS_PREFIX, cursor.pos)) {
    const start = cursor.pos;
    cursor.pos += VARS_PREFIX.length;
    const variableId = readIdentifier(cursor);
    if (variableId === undefined) {
      return {
        ok: false,
        failure: failure(cursor.base + start, VARS_PREFIX.length, {
          message: `"${VARS_PREFIX}" must be followed by a variable id.`,
          expected: `${VARS_PREFIX}<variable_id>`,
        }),
      };
    }
    return { ok: true, reference: { type: "var_ref", variable_id: variableId } };
  }

  const start = cursor.pos;
  cursor.pos += 1; // the "$"
  const name = readIdentifier(cursor);
  const token = cursor.text.slice(start, cursor.pos);

  if (name === undefined || !isBuiltinName(name)) {
    return {
      ok: false,
      failure: failure(cursor.base + start, Math.max(token.length, 1), {
        message: `"${token}" is not a value that expression grammar 1 provides.`,
        expected: REFERENCE_FORMS,
        found: token,
      }),
    };
  }

  return { ok: true, reference: { type: "builtin", name } };
}

/** `node_id ( "." path_segment )+` with at least one segment. */
function parseNodeRef(cursor: Cursor): ReferenceResult {
  const start = cursor.pos;
  const nodeId = readIdentifier(cursor);
  if (nodeId === undefined) {
    return {
      ok: false,
      failure: failure(cursor.base + start, 1, {
        message: `Expected a node id, found ${describeChar(peek(cursor))}.`,
        expected: REFERENCE_FORMS,
      }),
    };
  }

  if (peek(cursor) === "[") {
    return {
      ok: false,
      failure: failure(cursor.base + cursor.pos, 1, {
        message: "An array index must follow a field name, not the node id.",
        expected: `${nodeId}.<field>[0]`,
      }),
    };
  }

  const path: PathSegment[] = [];
  while (peek(cursor) === ".") {
    cursor.pos += 1;
    const fieldStart = cursor.pos;
    const name = readIdentifier(cursor);
    if (name === undefined) {
      return {
        ok: false,
        failure: failure(cursor.base + fieldStart, 1, {
          message: `Expected a field name after ".", found ${describeChar(peek(cursor))}.`,
          expected: "an identifier",
        }),
      };
    }
    path.push({ type: "field", name });

    if (peek(cursor) === "[") {
      const indexResult = parseIndex(cursor);
      if (!indexResult.ok) return indexResult;
      path.push(indexResult.segment);

      if (peek(cursor) === "[") {
        return {
          ok: false,
          failure: failure(cursor.base + cursor.pos, 1, {
            message:
              "Expression grammar 1 allows at most one array index per path segment.",
            expected: '"." or the end of the expression',
          }),
        };
      }
    }
  }

  if (path.length === 0) {
    return {
      ok: false,
      failure: failure(cursor.base + start, nodeId.length, {
        message: `A node reference must name at least one field: "${nodeId}" on its own does not identify a value.`,
        expected: `${nodeId}.<field>`,
        found: nodeId,
      }),
    };
  }

  return { ok: true, reference: { type: "node_ref", node_id: nodeId, path } };
}

type IndexResult =
  | { ok: true; segment: PathSegment }
  | { ok: false; failure: SyntaxFailure };

/** `"[" integer "]"`, positioned at the opening bracket. */
function parseIndex(cursor: Cursor): IndexResult {
  const bracket = cursor.pos;
  cursor.pos += 1;

  const index = readInteger(cursor);
  if (index === undefined) {
    return {
      ok: false,
      failure: failure(cursor.base + cursor.pos, 1, {
        message: `Expected a non-negative array index, found ${describeChar(peek(cursor))}.`,
        expected: "an integer with no leading zeros, such as 0 or 12",
      }),
    };
  }

  if (peek(cursor) !== "]") {
    return {
      ok: false,
      failure: failure(cursor.base + bracket, cursor.pos - bracket, {
        message: `Expected "]" to close the array index, found ${describeChar(peek(cursor))}.`,
        expected: '"]"',
      }),
    };
  }
  cursor.pos += 1;

  return { ok: true, segment: { type: "index", index } };
}

/**
 * Explains leftover text after an otherwise well-formed reference.
 *
 * The message is tailored per reference kind because the three cases have
 * genuinely different fixes, and a repair prompt that says only "unexpected
 * token" produces a guess rather than a correction.
 */
function trailingFailure(cursor: Cursor, reference: Reference): SyntaxFailure {
  // The body is already trimmed, so what remains is non-empty, but it can
  // still start with the space in `n.price * 1.08`. Point past it: an error
  // whose span begins on whitespace reads as an off-by-one.
  const remainder = cursor.text.slice(cursor.pos);
  const padding = remainder.length - remainder.trimStart().length;
  const rest = remainder.slice(padding);
  const offset = cursor.base + cursor.pos + padding;

  const looksLikePath = rest.startsWith(".") || rest.startsWith("[");

  if (reference.type === "var_ref" && looksLikePath) {
    return failure(offset, rest.length, {
      message: `A workflow variable reference is "${VARS_PREFIX}<variable_id>" and takes no further path. To read a field from earlier data, reference the node that produced it.`,
      found: rest,
    });
  }

  if (reference.type === "builtin" && looksLikePath) {
    return failure(offset, rest.length, {
      message: `"$${reference.name}" is a whole value and takes no path.`,
      found: rest,
    });
  }

  return failure(offset, rest.length, {
    message: `Unexpected "${rest}" after the reference. Expression grammar 1 supports field access and array indexing only: no arithmetic, no function calls, no ternaries, no concatenation inside the braces, and no inline JavaScript. Anything needing computation becomes a transform node.`,
    expected: '"." , "[", or the end of the expression',
    found: rest,
  });
}

function readIdentifier(cursor: Cursor): string | undefined {
  const match = IDENTIFIER.exec(cursor.text.slice(cursor.pos));
  if (match === null) return undefined;
  cursor.pos += match[0].length;
  return match[0];
}

function readInteger(cursor: Cursor): number | undefined {
  const match = INTEGER.exec(cursor.text.slice(cursor.pos));
  if (match === null) return undefined;
  cursor.pos += match[0].length;
  return Number(match[0]);
}

function peek(cursor: Cursor): string | undefined {
  return cursor.text[cursor.pos];
}

function isBuiltinName(name: string): name is BuiltinName {
  return (BUILTIN_NAMES as readonly string[]).includes(name);
}

function describeChar(char: string | undefined): string {
  return char === undefined ? "the end of the expression" : `"${char}"`;
}

/** Builds a failure, omitting absent optional fields rather than storing undefined. */
function failure(
  offset: number,
  length: number,
  parts: { message: string; expected?: string; found?: string },
): SyntaxFailure {
  const result: SyntaxFailure = {
    offset,
    length: Math.max(1, length),
    message: parts.message,
  };
  if (parts.expected !== undefined) result.expected = parts.expected;
  if (parts.found !== undefined) result.found = parts.found;
  return result;
}
