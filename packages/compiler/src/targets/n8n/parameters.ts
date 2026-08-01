/**
 * FFIR parameters to an n8n `parameters` object.
 *
 * Four things happen, in this order, and the order is the specification:
 *
 * 1. `static_parameters` merge in first. These are platform values with no FFIR
 *    source, like Slack's `resource: "message"`.
 * 2. Each FFIR parameter's strings are compiled from expression AST to n8n
 *    syntax.
 * 3. A named transform reshapes the value, if the binding asked for one.
 * 4. The result is placed at the `parameter_map` path, where dots mean nesting,
 *    so `otherOptions.thread_ts` builds `{ otherOptions: { thread_ts: ... } }`.
 *
 * Mapped FFIR parameters override statics. That is what lets a capability pin
 * `resource: "message"` while still letting FFIR drive everything else.
 *
 * ## The `=` prefix is decided last
 *
 * n8n marks an expression-bearing parameter by prefixing the whole string with
 * `=`. It has to be applied to the finished string, after transforms, because
 * `object_to_json_string` turns a whole object into one string and the prefix
 * belongs to that string rather than to any value inside it.
 *
 * Detecting one needs no bookkeeping. Grammar v1 has no escape for a literal
 * `{{`, so a `{{` in FFIR is always an expression, and the compiled output only
 * contains `{{` where an expression produced it. The presence of the braces is
 * therefore an exact test rather than a heuristic, which is the same property
 * validation stage 3 uses to exempt expressions from shape rules.
 *
 * ## An unmapped parameter is dropped
 *
 * Registry build rule 4 requires every `parameter_map` entry to name a real
 * parameter. It does not require every parameter to have an entry, and some
 * genuinely cannot have one: n8n's Split In Batches iterates whatever arrives
 * on its input, so `core.loop.for_each`'s `items` has nowhere to go. The names
 * that were dropped are returned rather than swallowed, so the caller can raise
 * the warnings the architecture specifies for the cases it names.
 */

import type { ParameterValue, Parameters, Template } from "@flowforge/ffir";
import type { Binding } from "@flowforge/registry";

import { applyTransform } from "../../transforms.js";
import { compileTemplate, type ExpressionContext } from "./expression.js";

export interface MapParametersInput {
  parameters: Parameters;
  templates: ReadonlyMap<string, Template>;
  binding: Binding;
  workflowId: string;
  nodeId: string;
  expressions: ExpressionContext;
}

export interface MappedParameters {
  parameters: Record<string, unknown>;
  /** FFIR parameter names the binding has no path for. */
  unmapped: string[];
  /** Transform names the binding asked for that the closed table does not hold. */
  unknownTransforms: string[];
}

export function mapParameters(input: MapParametersInput): MappedParameters {
  const { parameters, templates, binding, workflowId, nodeId, expressions } = input;

  const result: Record<string, unknown> = structuredClone(
    binding.static_parameters ?? {},
  ) as Record<string, unknown>;

  const parameterMap = binding.parameter_map ?? {};
  const transforms = binding.transform ?? {};
  const unmapped: string[] = [];
  const unknownTransforms: string[] = [];

  for (const name of Object.keys(parameters)) {
    const path = parameterMap[name];
    if (path === undefined) {
      unmapped.push(name);
      continue;
    }

    let value = compileValue(
      parameters[name] as ParameterValue,
      `/${escapePointerSegment(name)}`,
      templates,
      expressions,
    );

    const transform = transforms[name];
    if (transform !== undefined) {
      const applied = applyTransform(transform, value, {
        workflowId,
        nodeId,
        parameter: name,
      });
      if (applied.ok) value = applied.value;
      else unknownTransforms.push(transform);
    }

    setPath(result, path, value);
  }

  return { parameters: prefixExpressions(result), unmapped, unknownTransforms };
}

/**
 * Replaces every string with its compiled form, keeping the value's shape.
 *
 * Templates are keyed by pointer, so the walk has to track where it is. A string
 * with no template is emitted unchanged: stage 3 parses every string a node
 * carries, so that can only happen for a value a transform has already
 * introduced, which is not the author's text and must not be reinterpreted.
 */
function compileValue(
  value: ParameterValue,
  pointer: string,
  templates: ReadonlyMap<string, Template>,
  ctx: ExpressionContext,
): ParameterValue {
  if (typeof value === "string") {
    const template = templates.get(pointer);
    return template === undefined ? value : compileTemplate(template, ctx);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      compileValue(item, `${pointer}/${index}`, templates, ctx),
    );
  }

  if (isRecord(value)) {
    const mapped: Record<string, ParameterValue> = {};
    for (const [key, child] of Object.entries(value)) {
      mapped[key] = compileValue(
        child as ParameterValue,
        `${pointer}/${escapePointerSegment(key)}`,
        templates,
        ctx,
      );
    }
    return mapped;
  }

  return value;
}

/**
 * Writes a value at a dotted path, creating objects along the way.
 *
 * An existing non-object in the middle of the path is replaced rather than
 * merged into. That case means a binding maps one parameter to `options` and
 * another to `options.timeout`, which is a broken binding; overwriting makes it
 * visible in the output instead of throwing at a depth nobody can read.
 */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  const last = segments.pop();
  if (last === undefined) return;

  let cursor = target;
  for (const segment of segments) {
    const existing = cursor[segment];
    if (!isRecord(existing)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[last] = value;
}

/**
 * Prefixes every expression-bearing string with `=`.
 *
 * Applied to the finished parameter tree so that each leaf string, which is
 * what n8n treats as one parameter, gets the prefix exactly once and only when
 * it carries an expression.
 */
export function prefixExpressions<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("{{") ? `=${value}` : value) as unknown as T;
  }

  if (Array.isArray(value)) {
    return value.map((item: unknown) => prefixExpressions(item)) as unknown as T;
  }

  if (isRecord(value)) {
    const mapped: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      mapped[key] = prefixExpressions(child);
    }
    return mapped as unknown as T;
  }

  return value;
}

/** RFC 6901 escaping, matching the pointers stage 3 built. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
