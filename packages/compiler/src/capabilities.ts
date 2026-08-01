/**
 * The pre-lowering capability check: honest failure instead of a silent lie.
 *
 * Before lowering, the compiler compares what the document needs against what
 * the target declares it can do. A mismatch produces an error naming the exact
 * node, which is the alternative to silently dropping the feature. Flattening a
 * branch into a linear sequence produces a workflow that runs both paths
 * unconditionally: a data-corrupting bug delivered as a feature. The design
 * system's error guidance applies, "Invalid API Key format" rather than
 * "Failed", so every message here names the node, says what it uses, says why
 * the target cannot, and says what to do instead.
 *
 * ## Errors versus warnings
 *
 * COMPILER_ARCHITECTURE names branching, loops, and error routing as the things
 * a target rejects a document over. Those are structural: without them the
 * exported workflow would have a different shape from the one described, and no
 * amount of manual fixing afterwards is expected of the user.
 *
 * A retry policy is not structural. A target without `retryPolicy` still runs
 * every step in the right order; it just will not retry a failed one. Dropping
 * it changes resilience, not behaviour, so it is a `policy_unsupported`
 * warning. Making it an error would refuse to export a linear three-step
 * workflow to Zapier because one step asked for two attempts, which is a worse
 * answer than exporting it and saying so.
 *
 * ## Stage names classify, they do not timestamp
 *
 * These failures carry `stage: "lower"` and `stage: "emit"` even though the
 * check runs before either. The stage tells a caller what kind of problem it
 * has and who should act, and the frozen error model has no separate stage for
 * a pre-check. Reporting them under the stage that would otherwise have hit
 * them keeps one meaning per code.
 */

import type { FFIRDocument, Node } from "@flowforge/ffir";
import { DEFAULT_PORT, ERROR_PORT, portOf } from "@flowforge/ffir";

import type { CompileError, CompileWarning } from "./errors.js";
import type { Target, TargetCapabilities } from "./target.js";

export interface CapabilityCheck {
  errors: CompileError[];
  warnings: CompileWarning[];
}

/**
 * Checks a document against one target's declared capabilities.
 *
 * Reports every mismatch rather than the first. A user whose workflow uses a
 * branch and a loop against a linear target should learn both at once, because
 * the decision they are about to make is "use a different target", and they
 * cannot weigh it one rejection at a time.
 */
export function checkTargetCapabilities(
  doc: FFIRDocument,
  target: Target,
): CapabilityCheck {
  const errors: CompileError[] = [];
  const warnings: CompileWarning[] = [];
  const { capabilities: supports, displayName } = target;

  for (const node of doc.nodes) {
    if (node.kind === "branch" && supports.branching === "linear_only") {
      errors.push(
        unsupported(
          "branching",
          node,
          `Cannot compile to ${displayName}: this workflow uses conditional branching (node "${node.id}", kind "branch"), and ${displayName} workflows are linear. Remove the branch, or export to a target that supports branching.`,
        ),
      );
    }

    if (node.kind === "loop" && !supports.loops) {
      errors.push(
        unsupported(
          "loops",
          node,
          `Cannot compile to ${displayName}: this workflow loops over items (node "${node.id}", kind "loop"), and ${displayName} has no equivalent. Remove the loop, or export to a target that supports iteration.`,
        ),
      );
    }

    if (node.error_policy?.on_error === "route" && !supports.errorRouting) {
      errors.push(
        unsupported(
          "error_routing",
          node,
          `Cannot compile to ${displayName}: node "${node.id}" routes its failures to another step, and ${displayName} cannot send a failed step somewhere else. Set its error policy to stop or continue, or export to a target that supports error routing.`,
        ),
      );
    }

    if (node.error_policy?.retry !== undefined && !supports.retryPolicy) {
      warnings.push({
        code: "policy_unsupported",
        nodeId: node.id,
        message: `${displayName} cannot retry a failed step, so the retry policy on "${node.label}" will not be exported. The step still runs in the same order; it just will not try again if it fails.`,
      });
    }
  }

  for (const edge of doc.edges) {
    if (portOf(edge) !== ERROR_PORT || supports.errorRouting) continue;
    errors.push(
      unsupported(
        "error_routing",
        nodeOf(doc, edge.from) ?? { id: edge.from, label: edge.from },
        `Cannot compile to ${displayName}: an edge leaves node "${edge.from}" on its error output, and ${displayName} cannot route a failed step to a different one. Remove the error edge, or export to a target that supports error routing.`,
      ),
    );
  }

  if (!supports.parallelBranches) {
    for (const node of doc.nodes) {
      const fanOut = doc.edges.filter(
        (edge) => edge.from === node.id && portOf(edge) === DEFAULT_PORT,
      );
      if (fanOut.length < 2) continue;
      errors.push(
        unsupported(
          "parallel_branches",
          node,
          `Cannot compile to ${displayName}: node "${node.id}" sends its output to ${fanOut.length} steps at once, and ${displayName} runs one step after another. Chain the steps in sequence, or export to a target that supports parallel branches.`,
        ),
      );
    }
  }

  if (supports.maxNodes !== undefined && doc.nodes.length > supports.maxNodes) {
    errors.push({
      stage: "emit",
      code: "target_limit_exceeded",
      detail: `${doc.nodes.length} nodes exceeds the ${supports.maxNodes} ${displayName} allows`,
      message: `Cannot compile to ${displayName}: this workflow has ${doc.nodes.length} steps and ${displayName} allows at most ${supports.maxNodes}. Split it into smaller workflows, or export to a target with a higher ceiling.`,
    });
  }

  return { errors, warnings };
}

/** True when the document can be lowered to this target at all. */
export function supportsDocument(doc: FFIRDocument, target: Target): boolean {
  return checkTargetCapabilities(doc, target).errors.length === 0;
}

/**
 * The subset of a document's needs, as a capability shape.
 *
 * Lets a UI gray out an export option with a tooltip rather than letting the
 * user click into a failure, which is what COMPILER_ARCHITECTURE asks for in
 * the Zapier section.
 */
export function requiredCapabilities(
  doc: FFIRDocument,
): Pick<
  TargetCapabilities,
  "loops" | "errorRouting" | "retryPolicy" | "parallelBranches"
> & { branching: boolean } {
  return {
    branching: doc.nodes.some((node) => node.kind === "branch"),
    loops: doc.nodes.some((node) => node.kind === "loop"),
    errorRouting:
      doc.edges.some((edge) => portOf(edge) === ERROR_PORT) ||
      doc.nodes.some((node) => node.error_policy?.on_error === "route"),
    retryPolicy: doc.nodes.some((node) => node.error_policy?.retry !== undefined),
    parallelBranches: doc.nodes.some(
      (node) =>
        doc.edges.filter(
          (edge) => edge.from === node.id && portOf(edge) === DEFAULT_PORT,
        ).length > 1,
    ),
  };
}

function unsupported(
  feature: string,
  node: Pick<Node, "id" | "label">,
  message: string,
): CompileError {
  return { stage: "lower", code: "unsupported_feature", feature, nodeId: node.id, message };
}

function nodeOf(doc: FFIRDocument, id: string): Node | undefined {
  return doc.nodes.find((node) => node.id === id);
}
