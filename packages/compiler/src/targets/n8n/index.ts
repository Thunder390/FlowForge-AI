/**
 * The n8n target: stages 4, 5, and 6.
 *
 * The MVP target, and the first implementation of `Target`. Output is a JSON
 * file importable through n8n's "Import from File".
 *
 * What lives here is everything n8n-specific and nothing else. The proof that
 * the split held is that adding this directory required no change to `ffir`, to
 * `registry`, to `ai`, or to any of the compiler's shared stages: `lower`,
 * `emit`, and `verify` were called through the interface that already existed.
 * That is the design goal the architecture is subordinate to, tested rather
 * than asserted.
 *
 * `TargetCapabilities` says n8n can do everything FFIR can express, which is
 * unsurprising given FFIR was designed against it. The declaration still earns
 * its place: it is what the pre-lowering check reads, and when Make.com and
 * Zapier arrive their declarations are what make an honest refusal possible.
 */

import type { EmitResult, PlatformIR, Target, TargetCapabilities, VerifyResult } from "../../target.js";
import { emitN8n } from "./emit.js";
import { isN8nIR, N8N_TARGET_KEY } from "./ir.js";
import { lowerToN8n } from "./lower.js";
import { verifyN8n } from "./verify.js";

export const N8N_CAPABILITIES: TargetCapabilities = {
  branching: "full",
  loops: true,
  errorRouting: true,
  retryPolicy: true,
  parallelBranches: true,
  expressionSyntax: "n8n",
};

export const n8nTarget: Target = {
  key: N8N_TARGET_KEY,
  displayName: "n8n",
  fileExtension: "json",
  capabilities: N8N_CAPABILITIES,

  lower: lowerToN8n,

  emit(ir: PlatformIR): EmitResult {
    if (!isN8nIR(ir)) {
      // The driver checks the target stamp before calling this, so reaching
      // here means the IR was built by someone else's `lower`. Failing beats
      // reading fields off a shape that does not have them.
      throw new Error(`n8n cannot emit IR stamped "${ir.target}"`);
    }
    return emitN8n(ir);
  },

  verify(output: EmitResult): VerifyResult {
    return verifyN8n(output);
  },
};

export { N8N_TARGET_KEY, isN8nIR, type N8nIR, type N8nNode, type N8nWorkflow } from "./ir.js";
export { N8N_BUILTINS, compileTemplate, compileReference } from "./expression.js";
export { CONDITION_OPERATORS, inferOperandType } from "./conditions.js";
export {
  LAYER_WIDTH,
  ROW_HEIGHT,
  ERROR_TRACK_OFFSET,
  assignLayers,
  layoutGraph,
} from "./layout.js";
export { mapParameters, prefixExpressions } from "./parameters.js";
export { CREDENTIAL_PLACEHOLDER, lowerToN8n } from "./lower.js";
export { emitN8n } from "./emit.js";
export { verifyN8n } from "./verify.js";
