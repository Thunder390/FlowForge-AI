/**
 * The expression parser.
 *
 * It lives in `ffir`, not in the compiler, so every consumer parses
 * identically. Targets receive a parsed AST and never the raw string.
 */

export {
  BUILTIN_NAMES,
  VARS_PREFIX,
  isExpressionPart,
  expressionParts,
  isLiteralTemplate,
  referencedNodeIds,
  referencedVariableIds,
  referenceDepth,
  formatReference,
  formatExpression,
  type BuiltinName,
  type Builtin,
  type ExpressionPart,
  type FieldSegment,
  type IndexSegment,
  type LiteralPart,
  type NodeRef,
  type PathSegment,
  type Reference,
  type Template,
  type TemplatePart,
  type VarRef,
} from "./ast.js";

export type {
  GrammarParseResult,
  GrammarParser,
  SyntaxFailure,
} from "./diagnostics.js";

export {
  parseTemplate,
  checkTemplate,
  checkGrammar,
  isSupportedGrammar,
  supportedGrammars,
  type ParseOptions,
  type ParseResult,
} from "./parse.js";
