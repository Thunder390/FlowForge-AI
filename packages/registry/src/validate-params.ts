/**
 * Validation stage 3: a parameters object against its capability's registry
 * entry.
 *
 * This lives in `registry` rather than in `ai` because the rules *are* registry
 * data. Re-expressing `pattern` and `one_of` as hand-written TypeScript guards
 * next to the retrieval layer is how the validator and the compiler start
 * disagreeing about what a legal value is. `ai` owns walking the document and
 * turning what comes back into FFIR error codes; this module owns the rules.
 *
 * Two checks, kept structurally apart because they answer different questions
 * and map to different FFIR rules:
 *
 * - **Names** (rule 13). Every supplied key is a parameter the capability
 *   declares. This runs even though pass B's synthesized schema already makes
 *   an illegal name structurally impossible, because that guarantee belongs to
 *   one provider rather than to the architecture, and it does not apply at all
 *   to hand-authored FFIR or to a workflow imported from the marketplace. An
 *   unknown name that reaches the compiler misses the `parameter_map` lookup
 *   and is silently dropped, producing a workflow that imports cleanly and is
 *   missing configuration.
 * - **Values** (rule 8). Presence, type, and the capability's own validation
 *   rules.
 *
 * ## Expressions are not checked against value rules
 *
 * A parameter value may be a template: `"#{{ $vars.channel }}"` is a legal
 * value for a parameter whose pattern demands a leading `#`, and what it
 * resolves to is unknowable until the workflow runs. Checking a template
 * against a pattern, an enum, or a numeric range would reject most real
 * workflows, so a value carrying an expression is exempt from every rule about
 * its shape. It is still subject to the name check and to being present.
 *
 * Detecting one needs no parser. Grammar v1 has no escape sequence for a
 * literal `{{`, so an unclosed brace pair is a parse error rather than text,
 * which makes the presence of `{{` an exact test. A template that does not
 * parse is reported by stage 4, which owns expression syntax; reporting it
 * again here as a pattern failure would send the repair prompt after the wrong
 * problem.
 */

import type { ParameterValue } from "@flowforge/ffir";

import type {
  Capability,
  ConditionSpec,
  ParameterDefinition,
  ParameterType,
} from "./types.js";

/**
 * The failure codes from NODE_REGISTRY.md, which the repair prompt consumes
 * directly. They sit alongside the FFIR error code rather than replacing it:
 * rule 8 produces one FFIR code, `invalid_parameter_value`, and these say which
 * of its rules failed.
 */
export const PARAMETER_FAILURES = [
  "param_missing",
  "param_type_mismatch",
  "param_pattern_failed",
  "param_not_in_enum",
  "param_out_of_range",
  "param_conditional_missing",
] as const;
export type ParameterFailure = (typeof PARAMETER_FAILURES)[number];

/** A rule 8 failure: a value that is absent when it should not be, or wrong. */
export interface ParameterIssue {
  failure: ParameterFailure;
  /** Readable path within the parameters object, such as `assignments[0].field`. */
  parameter: string;
  /** JSON Pointer to the same place, relative to the node's `parameters`. */
  pointer: string;
  message: string;
  details: Record<string, unknown>;
}

/** A rule 13 failure: a key the capability does not declare. */
export interface UnknownParameterIssue {
  parameter: string;
  pointer: string;
  message: string;
  /** The names that are legal here, so a repair prompt can offer the real list. */
  declared: string[];
  /** A declared name one edit away, when there is exactly one. */
  suggestion?: string;
}

export interface ParameterCheck {
  /** Rule 13, outermost first. */
  unknown: UnknownParameterIssue[];
  /** Rule 8, in the order the registry declares the parameters. */
  issues: ParameterIssue[];
}

/**
 * Grammar v1's expression opener. Its presence is what marks a value as
 * unknowable until run time.
 */
const EXPRESSION_OPEN = "{{";

/**
 * ISO 8601, anchored, for the `datetime` type.
 *
 * A regular expression rather than `Date.parse`, whose behaviour on non-ISO
 * input is implementation-defined. A validator that accepts a value on one
 * engine and rejects it on another is not a validator.
 */
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Checks one node's parameters against its capability.
 *
 * Collects everything rather than stopping at the first failure: the repair
 * prompt needs the complete list to fix a document in one retry.
 *
 * Deterministic by construction. Value checks walk the parameters the registry
 * declares, in registry order; name checks walk the keys the document supplied,
 * in document order. The same capability and the same object always produce the
 * same lists in the same order.
 */
export function validateParameters(
  capability: Capability,
  parameters: Readonly<Record<string, ParameterValue>>,
): ParameterCheck {
  const check: ParameterCheck = { unknown: [], issues: [] };
  checkObject(capability.parameters, parameters, [], check);
  return check;
}

/** True when two JSON literals are structurally the same value. */
export function sameParameterValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameParameterValue(item, b[index]));
  }
  if (typeof a !== "object" || typeof b !== "object") return false;

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(
    (key) => has(right, key) && sameParameterValue(left[key], right[key]),
  );
}

// ---------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------

type Segment = { kind: "field"; name: string } | { kind: "index"; index: number };

/**
 * One level of a parameters object: the top level, or a nested `object`
 * parameter that declares its `fields`.
 *
 * Names are checked before values so that the outermost surprise is reported
 * before anything nested inside it.
 */
function checkObject(
  declared: Readonly<Record<string, ParameterDefinition>>,
  supplied: Readonly<Record<string, ParameterValue>>,
  at: Segment[],
  check: ParameterCheck,
): void {
  const names = Object.keys(declared);

  for (const name of Object.keys(supplied)) {
    if (has(declared, name)) continue;
    const path = [...at, { kind: "field", name } as const];
    const suggestion = nearest(name, names);
    check.unknown.push({
      parameter: display(path),
      pointer: toPointer(path),
      message:
        `"${name}" is not a parameter of this capability. Legal names here are: ${names.join(", ")}.` +
        (suggestion === undefined ? "" : ` Did you mean "${suggestion}"?`),
      declared: names,
      ...(suggestion === undefined ? {} : { suggestion }),
    });
  }

  for (const name of names) {
    const definition = declared[name];
    if (definition === undefined) continue;
    const path = [...at, { kind: "field", name } as const];
    const present = has(supplied, name);
    const value = present ? supplied[name] : undefined;

    if (!present || value === undefined) {
      checkAbsent(name, definition, declared, supplied, path, check);
      continue;
    }

    checkValue(definition, value, path, check);
  }
}

/**
 * A parameter that was not supplied.
 *
 * An absent key is the only thing that counts as missing. An empty string does
 * not: pass B is told to emit one when a required parameter does not apply, so
 * treating it as missing would reject the document the prompt asked for. A
 * parameter that genuinely cannot be blank says so with `not_empty`.
 */
function checkAbsent(
  name: string,
  definition: ParameterDefinition,
  declared: Readonly<Record<string, ParameterDefinition>>,
  supplied: Readonly<Record<string, ParameterValue>>,
  path: Segment[],
  check: ParameterCheck,
): void {
  if (definition.required) {
    check.issues.push({
      failure: "param_missing",
      parameter: display(path),
      pointer: toPointer(path),
      message: `Required parameter "${name}" is missing. ${definition.description}`,
      details: { expected_type: definition.type },
    });
    return;
  }

  const when = definition.conditional_required?.when;
  if (when === undefined || definition.default !== undefined) return;

  const triggers = Object.entries(when);
  const holds = triggers.every(([sibling, spec]) =>
    conditionHolds(spec, effectiveValue(declared, supplied, sibling)),
  );
  if (!holds) return;

  check.issues.push({
    failure: "param_conditional_missing",
    parameter: display(path),
    pointer: toPointer(path),
    message: `Parameter "${name}" is required when ${triggers
      .map(([sibling, spec]) => `${sibling} ${describeCondition(spec)}`)
      .join(" and ")}. ${definition.description}`,
    details: { when: Object.fromEntries(triggers) },
  });
}

/** A supplied value: its type, its enum membership, and its validation rules. */
function checkValue(
  definition: ParameterDefinition,
  value: ParameterValue,
  path: Segment[],
  check: ParameterCheck,
): void {
  if (carriesExpression(value)) return;

  // An enum's closed list is its type and its validation both, so membership
  // settles it either way and no `validation` block applies on top.
  if (definition.type === "enum") {
    const values = definition.values ?? [];
    if (!values.some((allowed) => sameParameterValue(allowed, value))) {
      check.issues.push({
        failure: "param_not_in_enum",
        parameter: display(path),
        pointer: toPointer(path),
        message: `${JSON.stringify(value)} is not one of the allowed values: ${values
          .map((allowed) => JSON.stringify(allowed))
          .join(", ")}.`,
        details: { value, allowed: values },
      });
    }
    return;
  }

  if (!matchesType(definition.type, value)) {
    check.issues.push({
      failure: "param_type_mismatch",
      parameter: display(path),
      pointer: toPointer(path),
      message: `Expected ${describeType(definition.type)} but got ${describeActual(value)}.`,
      details: { expected_type: definition.type, value },
    });
    return;
  }

  checkRules(definition, value, path, check);

  if (definition.type === "array" && definition.items !== undefined) {
    const items = definition.items;
    (value as ParameterValue[]).forEach((element, index) => {
      checkValue(items, element, [...path, { kind: "index", index }], check);
    });
    return;
  }

  // An object with no declared `fields` is opaque on purpose: HTTP headers and
  // a Block Kit payload have no fixed key set, and inventing one would reject
  // legitimate values.
  if (definition.type === "object" && definition.fields !== undefined) {
    checkObject(
      definition.fields,
      value as Record<string, ParameterValue>,
      path,
      check,
    );
  }
}

/** The `validation` block, which is data so the compiler enforces the same thing. */
function checkRules(
  definition: ParameterDefinition,
  value: ParameterValue,
  path: Segment[],
  check: ParameterCheck,
): void {
  const rules = definition.validation;
  if (rules === undefined) return;

  const parameter = display(path);
  const pointer = toPointer(path);
  const fail = (
    failure: ParameterFailure,
    message: string,
    details: Record<string, unknown>,
  ): void => {
    check.issues.push({ failure, parameter, pointer, message, details });
  };

  if (rules.one_of !== undefined) {
    if (!rules.one_of.some((allowed) => sameParameterValue(allowed, value))) {
      fail(
        "param_not_in_enum",
        `${JSON.stringify(value)} is not one of the allowed values: ${rules.one_of
          .map((allowed) => JSON.stringify(allowed))
          .join(", ")}.`,
        { value, allowed: rules.one_of },
      );
    }
  }

  if (typeof value === "string" && rules.pattern !== undefined) {
    // Registry load rejects a build carrying a pattern that will not compile,
    // so this can only be reached through a hand-built capability. Skipping the
    // rule rather than throwing keeps a fault in our own data from taking down
    // a request; the load-time gate is what actually catches it.
    const expression = compile(rules.pattern);
    if (expression !== undefined && !expression.test(value)) {
      fail(
        "param_pattern_failed",
        `${JSON.stringify(value)} does not match the required format. ${definition.description}`,
        { value, pattern: rules.pattern },
      );
    }
  }

  const length = measurable(value);
  if (length !== undefined) {
    if (rules.min_length !== undefined && length < rules.min_length) {
      fail(
        "param_out_of_range",
        `Length ${length} is below the minimum of ${rules.min_length}.`,
        { value, length, min_length: rules.min_length },
      );
    }
    if (rules.max_length !== undefined && length > rules.max_length) {
      fail(
        "param_out_of_range",
        `Length ${length} is above the maximum of ${rules.max_length}.`,
        { value, length, max_length: rules.max_length },
      );
    }
  }

  if (typeof value === "number") {
    if (rules.min !== undefined && value < rules.min) {
      fail("param_out_of_range", `${value} is below the minimum of ${rules.min}.`, {
        value,
        min: rules.min,
      });
    }
    if (rules.max !== undefined && value > rules.max) {
      fail("param_out_of_range", `${value} is above the maximum of ${rules.max}.`, {
        value,
        max: rules.max,
      });
    }
  }

  if (rules.not_empty === true && isEmpty(value)) {
    fail("param_out_of_range", `This parameter must not be empty.`, { value });
  }
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** True when the value is a template rather than a literal. See the module note. */
function carriesExpression(value: ParameterValue): boolean {
  return typeof value === "string" && value.includes(EXPRESSION_OPEN);
}

function compile(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function matchesType(type: ParameterType, value: ParameterValue): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "datetime":
      return typeof value === "string" && ISO_8601.test(value);
    case "enum":
      // Handled before the type check: membership in `values` is the type.
      return true;
  }
}

/** The length `min_length` and `max_length` bound, for the values that have one. */
function measurable(value: ParameterValue): number | undefined {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function isEmpty(value: ParameterValue | undefined): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

/**
 * Whether a `conditional_required` trigger fires.
 *
 * Every entry in `when` must hold. One sibling in a given state is the common
 * case and the only one NODE_REGISTRY.md shows; requiring all of them is the
 * reading that makes a second entry narrow the condition rather than widen it.
 */
function conditionHolds(spec: ConditionSpec, value: ParameterValue | undefined): boolean {
  if ("is_empty" in spec) return spec.is_empty === isEmpty(value);
  if ("is_not_empty" in spec) return spec.is_not_empty === !isEmpty(value);
  if ("equals" in spec) return sameParameterValue(spec.equals, value);
  return spec.one_of.some((allowed) => sameParameterValue(allowed, value));
}

/** What a sibling's value will be at run time: what was supplied, or its default. */
function effectiveValue(
  declared: Readonly<Record<string, ParameterDefinition>>,
  supplied: Readonly<Record<string, ParameterValue>>,
  name: string,
): ParameterValue | undefined {
  if (has(supplied, name)) {
    const value = supplied[name];
    if (value !== undefined) return value;
  }
  return has(declared, name) ? declared[name]?.default : undefined;
}

// ---------------------------------------------------------------------------
// Paths and phrasing
// ---------------------------------------------------------------------------

function display(path: readonly Segment[]): string {
  return path
    .map((segment, position) => {
      if (segment.kind === "index") return `[${segment.index}]`;
      return position === 0 ? segment.name : `.${segment.name}`;
    })
    .join("");
}

/**
 * A JSON Pointer relative to the node's `parameters`, escaped, because a
 * parameter legitimately named `a/b` would otherwise address something else.
 */
function toPointer(path: readonly Segment[]): string {
  return path
    .map((segment) =>
      segment.kind === "index"
        ? `/${segment.index}`
        : `/${segment.name.replace(/~/g, "~0").replace(/\//g, "~1")}`,
    )
    .join("");
}

function describeType(type: ParameterType): string {
  return type === "datetime" ? "an ISO 8601 date or timestamp" : `a ${type}`;
}

function describeActual(value: ParameterValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

function describeCondition(spec: ConditionSpec): string {
  if ("is_empty" in spec) return spec.is_empty ? "is empty" : "is not empty";
  if ("is_not_empty" in spec) return spec.is_not_empty ? "is not empty" : "is empty";
  if ("equals" in spec) return `is ${JSON.stringify(spec.equals)}`;
  return `is one of ${spec.one_of.map((value) => JSON.stringify(value)).join(", ")}`;
}

/**
 * The one declared name within a single edit of what was written, if exactly
 * one qualifies. An ambiguous guess is worse than none: it sends the repair
 * prompt confidently at the wrong parameter.
 */
function nearest(name: string, declared: readonly string[]): string | undefined {
  const close = declared.filter((candidate) => withinOneEdit(name, candidate));
  return close.length === 1 ? close[0] : undefined;
}

function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let short = 0;
  let long = 0;
  let edits = 0;

  while (short < shorter.length && long < longer.length) {
    if (shorter[short] === longer[long]) {
      short += 1;
      long += 1;
      continue;
    }
    if (++edits > 1) return false;
    if (shorter.length === longer.length) short += 1;
    long += 1;
  }
  return edits + (longer.length - long) <= 1;
}

/** Own-property test. Parameter names arrive from an untrusted document, and
 * `"constructor" in declared` is true for every object. */
function has(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}
