/**
 * Stage 2: capabilities become registry entries plus a binding.
 *
 * One `ResolvedNode` per FFIR node, carrying the node, what the registry knows
 * about its capability, and the binding for the requested target. The three-way
 * status this switches on comes from `resolveForTarget`, which already
 * distinguishes the two ways a binding can be absent.
 *
 * | Outcome | Action |
 * | --- | --- |
 * | Binding exists | Proceed normally. |
 * | Binding is explicitly `null` | Degrade to `http.request.send`, warn. |
 * | Binding key is absent | Registry gap. Degrade, warn, log for the backlog. |
 *
 * ## Degradation is never silent
 *
 * Every degraded node produces a warning that the canvas renders as a badge and
 * the setup guide renders as its own section. A user who exports a workflow
 * containing a degraded node knows which step needs manual work before they
 * import it. A silent degradation would hand them a file that imports cleanly
 * and then does the wrong thing, which is the worst failure mode this product
 * has.
 *
 * The two degrading outcomes produce identical output under different codes.
 * That is the point: `capability_degraded` is a fact about the platform, and
 * `capability_unknown` is a fact about our registry coverage. Only the second
 * is something we can fix, and merging them would hide the backlog.
 *
 * ## Why this stage is still target-independent
 *
 * It reads `registry.bindings`, which no stage before it may. That is not a
 * leak: a `Binding` is opaque data keyed by target, and this module never looks
 * inside one. Interpreting `node_type` is lowering, and lowering is stage 4.
 * The test for the boundary is whether this file would need editing to add
 * Make.com. It would not.
 */

import type { Node } from "@flowforge/ffir";
import {
  HTTP_FALLBACK_CAPABILITY,
  resolveForTarget,
  type Binding,
  type Registry,
  type ResolvedTargetCapability,
} from "@flowforge/registry";

import {
  failed,
  ok,
  type CompileError,
  type CompileResult,
  type CompileWarning,
} from "./errors.js";

/**
 * One node, resolved against the registry for one target.
 *
 * `capability` is what the node asked for and `binding` is what it will
 * actually compile through. When a node degrades those two stop describing the
 * same capability, which is why the original id is kept: the warning, the setup
 * guide, and any later diagnosis all need to say what the workflow meant, not
 * what it fell back to.
 */
export interface ResolvedNode {
  node: Node;
  /** Index into `doc.nodes`, preserved so document order survives sorting. */
  index: number;
  /** What the FFIR node asked for, resolved. Never the fallback. */
  resolved: ResolvedTargetCapability;
  /** True when the target had no usable binding and this fell back to HTTP. */
  degraded: boolean;
  /**
   * The binding lowering will actually use: the node's own, or
   * `http.request.send`'s when degraded.
   */
  binding: Binding;
  /** The capability id `binding` belongs to. Differs from the node's when degraded. */
  boundCapability: string;
}

export interface ResolveOutput {
  nodes: readonly ResolvedNode[];
  byId: ReadonlyMap<string, ResolvedNode>;
}

/**
 * Resolves every node, in document order.
 *
 * Collects failures rather than stopping at the first, matching every other
 * stage. In practice a failure here should be unreachable: validation stage 2
 * already rejected every unresolvable capability, and stage 1 of this pipeline
 * runs it. The path is kept because "unreachable" is a claim about the current
 * composition, and this is a public library boundary where a future caller may
 * compose it differently. Returning a typed error costs one branch; discovering
 * the assumption was wrong via a thrown `TypeError` costs an incident.
 */
export function resolveNodes(
  nodes: readonly Node[],
  registry: Registry,
  target: string,
): CompileResult<ResolveOutput> {
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];
  const resolvedNodes: ResolvedNode[] = [];

  const fallback = resolveForTarget(registry, HTTP_FALLBACK_CAPABILITY, target);

  nodes.forEach((node, index) => {
    const resolved = resolveForTarget(registry, node.capability, target);
    if (resolved === undefined) {
      errors.push({
        stage: "resolve",
        code: "capability_unknown",
        capability: node.capability,
        nodeId: node.id,
        message: `Node "${node.id}" uses capability "${node.capability}", which is not in registry ${registry.version}.`,
      });
      return;
    }

    if (resolved.status === "bound" && resolved.binding !== undefined) {
      resolvedNodes.push({
        node,
        index,
        resolved,
        degraded: false,
        binding: resolved.binding,
        boundCapability: node.capability,
      });
      return;
    }

    // Degrading needs somewhere to degrade *to*. A registry whose universal
    // escape hatch is itself unbound cannot serve this target at all, and
    // saying so plainly beats emitting a node with no binding and letting
    // stage 4 fail on a field that is missing for a reason nobody can see.
    if (fallback?.status !== "bound" || fallback.binding === undefined) {
      errors.push({
        stage: "resolve",
        code: "capability_unknown",
        capability: HTTP_FALLBACK_CAPABILITY,
        nodeId: node.id,
        message: `Node "${node.id}" needs to degrade to "${HTTP_FALLBACK_CAPABILITY}", but registry ${registry.version} has no binding for it on target "${target}". Every target must bind the HTTP fallback.`,
      });
      return;
    }

    // `bound` cannot reach here with a binding in hand, but the type permits a
    // `bound` status alongside an absent binding and this is not the place to
    // discover that it happened. Treating that shape as `unsupported` claims
    // less: it says the platform cannot, rather than asserting a gap in our
    // coverage that the registry never reported.
    const degradedStatus = resolved.status === "missing" ? "missing" : "unsupported";

    warnings.push(degradationWarning(node, degradedStatus, target));
    resolvedNodes.push({
      node,
      index,
      resolved,
      degraded: true,
      binding: fallback.binding,
      boundCapability: HTTP_FALLBACK_CAPABILITY,
    });
  });

  if (errors.length > 0) return failed(errors, warnings);

  return ok(
    {
      nodes: resolvedNodes,
      byId: new Map(resolvedNodes.map((entry) => [entry.node.id, entry])),
    },
    warnings,
  );
}

/**
 * The message a user reads on the node badge.
 *
 * Written for them rather than for us: it names the step, says what will
 * happen, and says what they have to do about it. "Binding missing" would be
 * accurate and useless.
 */
function degradationWarning(
  node: Node,
  status: "unsupported" | "missing",
  target: string,
): CompileWarning {
  const shared = `It will be exported as a generic HTTP request instead, which you will need to finish configuring by hand after importing.`;

  return {
    code: status === "unsupported" ? "capability_degraded" : "capability_unknown",
    nodeId: node.id,
    message:
      status === "unsupported"
        ? `"${node.label}" uses ${node.capability}, which ${target} cannot do natively. ${shared}`
        : `"${node.label}" uses ${node.capability}, which FlowForge has not mapped to ${target} yet. ${shared}`,
  };
}
