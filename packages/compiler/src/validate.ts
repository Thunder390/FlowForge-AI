/**
 * Stage 1: the document is well-formed and semantically legal.
 *
 * Composes every validation stage that exists: 0 and 1 and 4 from `ffir`, then
 * 2 and 3 from `registry`. All failures come back at once rather than the
 * first, because the AI repair loop needs the complete list to fix everything
 * in a single retry, and a compiler that reports one error per run turns a
 * three-error document into three round trips.
 *
 * ## Why this runs even though the caller already validated
 *
 * The AI layer runs this same validator before it ever calls the compiler.
 * Running it again is deliberate. The compiler is a public library boundary and
 * must not assume its caller validated: hand-written FFIR, a document imported
 * from the marketplace, and generated FFIR all hit the same gate. Marketplace
 * input in particular is untrusted, which is why stage 0's document limits run
 * first and short-circuit. Handing an unbounded document to a schema validator
 * is the denial of service the limits exist to stop.
 *
 * The cost is one pass over a document that is at most a few hundred nodes, and
 * it buys the property that no caller can produce a compiled artifact from a
 * document that would not validate.
 */

import { validateWithoutRegistry, type ValidationError } from "@flowforge/ffir";
import { validateAgainstRegistry, type Registry } from "@flowforge/registry";

import { failed, ok, type CompileError, type CompileResult } from "./errors.js";

/**
 * Runs stages 0, 1, 4, 2, and 3, in that order.
 *
 * The order is not the numbering. Stages 0 and 1 prove shape, stage 4 proves
 * the graph, and only then do the registry stages ask what the nodes mean;
 * `ffir`'s own composition already short-circuits 0 before 1 and both before 4.
 * Running the registry stages against a document that failed its schema would
 * mean reading fields that may not be there.
 *
 * Both halves run when the first half passes, so a document with a graph
 * problem and a bad parameter reports both.
 */
export function validateForCompile(
  input: unknown,
  registry: Registry,
): CompileResult<void> {
  const structural = validateWithoutRegistry(input);
  if (!structural.ok) return failed(structural.errors.map(toCompileError));

  // Safe: stage 1 proved the shape, which is the precondition `ffir` documents
  // for its own stage 4 and the same one the registry stages rely on.
  const doc = input as Parameters<typeof validateAgainstRegistry>[0];
  const semantic = validateAgainstRegistry(doc, registry);
  if (!semantic.ok) return failed(semantic.errors.map(toCompileError));

  return ok(undefined);
}

/**
 * A `ValidationError` becomes a `CompileError` without losing anything.
 *
 * The code is forwarded verbatim rather than remapped. Every consumer of a
 * compile failure, the repair prompt above all, keys off `ffir`'s vocabulary,
 * and a compiler that renamed the codes on the way through would force a
 * translation table that has to be kept in step with a frozen enum.
 *
 * `nodeId` is lifted out of `details` because the UI highlights a node on the
 * canvas from it and should not have to know that one validator puts it in a
 * details bag. Not every error has one: a document-limit breach is about the
 * document.
 */
function toCompileError(error: ValidationError): CompileError {
  const nodeId = error.details?.["node_id"];
  return {
    stage: "validate",
    code: error.code,
    message: error.message,
    path: error.path,
    ...(typeof nodeId === "string" ? { nodeId } : {}),
  };
}
