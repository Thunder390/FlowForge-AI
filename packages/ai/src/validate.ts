/**
 * Validation stages 2 and 3: the registry-dependent half of the pipeline.
 *
 * These live here rather than in `ffir` because they resolve capabilities and
 * parameter schemas against the node registry, and `ffir` must not depend on
 * it. `RULE_OWNERSHIP` in `ffir` records that split in code; this module is the
 * other side of it, and between them rules 1 to 18 are all accounted for.
 *
 * | Stage | Checks | Rules |
 * | --- | --- | --- |
 * | 2. Registry | Every capability resolves. Every capability scope is real. | 7 |
 * | 3. Parameter | Parameter names and values against the registry entry. | 8, 13 |
 *
 * ## What this module deliberately does not do
 *
 * It never reads a binding. `packages/ai` knowing that `slack.message.send` is
 * `n8n-nodes-base.slack` is exactly the leak the architecture is built to
 * prevent, and a validator is the easiest place for it to happen: "check the
 * capability can actually compile" sounds like diligence. It is not this
 * layer's question. Whether a target can express a capability is settled at
 * registry load, where a build with an unbound `core.*` capability is rejected,
 * and again at the compile dry-run, which is stage 5 and belongs to
 * `packages/pipeline` because it is the only layer allowed to call both.
 *
 * ## Ordering
 *
 * Deterministic, and the same document always produces the same list. Stage 2
 * walks nodes then credentials in document order. Stage 3 walks nodes in
 * document order and, within a node, reports rule 8 before rule 13, matching
 * the rule-number order `ffir`'s stage 4 uses.
 *
 * Stage 3 skips a node whose capability did not resolve. There is nothing to
 * check its parameters against, and inventing failures for every parameter of
 * an unknown capability would bury the one error that matters under a dozen
 * that follow from it.
 */

import {
  ErrorCode,
  invalid,
  pointer,
  type FFIRDocument,
  type Node,
  type ValidationError,
  type ValidationResult,
} from "@flowforge/ffir";
import {
  capabilitiesOfIntegration,
  resolve,
  validateParameters,
  type Registry,
} from "@flowforge/registry";

/**
 * Stage 2. Every capability resolves, and every credential scope names an
 * integration the registry contains.
 *
 * A failure here feeds the unknown-capability ladder rather than the ordinary
 * repair prompt, so the errors carry what each rung needs: the integration
 * segment, whether that segment resolved on its own, and the capabilities it
 * offers. Rung 2, handing the model an integration's real capability list, is
 * the common case and repairs reliably, but only if the list is to hand.
 */
export function checkRegistry(doc: FFIRDocument, registry: Registry): ValidationResult {
  const errors: ValidationError[] = [];

  doc.nodes.forEach((node, index) => {
    if (registry.capabilities.has(node.capability)) return;

    const integration = integrationOf(node.capability);
    const known = registry.integrations.get(integration);
    const siblings = capabilitiesOfIntegration(registry, integration).map(
      (capability) => capability.id,
    );

    errors.push({
      code: ErrorCode.UNKNOWN_CAPABILITY,
      path: pointer("nodes", index, "capability"),
      message:
        known === undefined
          ? `Node "${node.id}" uses capability "${node.capability}", and this registry has no integration called "${integration}".`
          : `Node "${node.id}" uses capability "${node.capability}", which ${known.display_name} does not offer. It offers: ${siblings.join(", ")}.`,
      details: {
        node_id: node.id,
        capability: node.capability,
        integration,
        integration_known: known !== undefined,
        available: siblings,
      },
    });
  });

  doc.credentials.forEach((credential, index) => {
    if (registry.integrations.has(credential.capability_scope)) return;
    errors.push({
      code: ErrorCode.UNKNOWN_CAPABILITY_SCOPE,
      path: pointer("credentials", index, "capability_scope"),
      message: `Credential "${credential.id}" is scoped to "${credential.capability_scope}", which this registry has no integration for. The setup guide is built by joining this scope against the registry's auth definitions, so it would have nothing to tell the user to connect.`,
      details: {
        credential_id: credential.id,
        capability_scope: credential.capability_scope,
      },
    });
  });

  return invalid(errors);
}

/**
 * Stage 3. Parameter names and values, both against the registry entry.
 *
 * The name check is the one worth stating plainly. It runs even though pass B's
 * synthesized schema, with `additionalProperties: false` at every level, makes
 * an illegal name structurally impossible, because that guarantee belongs to
 * one provider rather than to the architecture. It weakens on a provider
 * without strict structured outputs, and it does not apply at all to
 * hand-authored FFIR or to a workflow imported from the marketplace. Without an
 * independent check an unknown name reaches the compiler, misses the
 * `parameter_map` lookup, and is silently dropped, producing a workflow that
 * imports cleanly and is missing configuration.
 */
export function checkParameters(doc: FFIRDocument, registry: Registry): ValidationResult {
  const errors: ValidationError[] = [];

  doc.nodes.forEach((node, index) => {
    const resolved = resolve(registry, node.capability);
    if (resolved === undefined) return; // Stage 2 owns this.

    const check = validateParameters(resolved.capability, node.parameters);
    const base = pointer("nodes", index, "parameters");

    for (const issue of check.issues) {
      errors.push({
        code: ErrorCode.INVALID_PARAMETER_VALUE,
        path: base + issue.pointer,
        message: describe(node, issue.parameter, issue.message),
        // The rule's own details go in first, so the canonical fields below
        // cannot be shadowed. `parameter` in particular is the full path here,
        // and a nested rule reporting a bare field name would mislabel it.
        details: {
          ...issue.details,
          node_id: node.id,
          capability: node.capability,
          parameter: issue.parameter,
          failure: issue.failure,
        },
      });
    }

    for (const issue of check.unknown) {
      errors.push({
        code: ErrorCode.UNKNOWN_PARAMETER_NAME,
        path: base + issue.pointer,
        message: describe(node, issue.parameter, issue.message),
        details: {
          node_id: node.id,
          capability: node.capability,
          parameter: issue.parameter,
          declared: issue.declared,
          ...(issue.suggestion === undefined ? {} : { suggestion: issue.suggestion }),
        },
      });
    }
  });

  return invalid(errors);
}

/**
 * Runs both stages this package owns.
 *
 * Stage 3 runs whatever stage 2 found, because a document with one unknown
 * capability and three bad parameters should come back with four findings
 * rather than one and then, a repair later, three more. Nodes whose capability
 * did not resolve are the only ones stage 3 passes over.
 *
 * A caller that stops here has not validated the document: stages 0, 1, and 4
 * live in `ffir` and stage 5 in `pipeline`. Composing all six is the
 * orchestrator's job, which is why nothing here claims to be the pipeline.
 */
export function validateAgainstRegistry(
  doc: FFIRDocument,
  registry: Registry,
): ValidationResult {
  return invalid([
    ...checkRegistry(doc, registry).errors,
    ...checkParameters(doc, registry).errors,
  ]);
}

/** Every message names the node and the parameter. Vague feedback produces vague fixes. */
function describe(node: Node, parameter: string, message: string): string {
  return `Node "${node.id}", parameter "${parameter}": ${message}`;
}

function integrationOf(capability: string): string {
  const dot = capability.indexOf(".");
  return dot === -1 ? capability : capability.slice(0, dot);
}
