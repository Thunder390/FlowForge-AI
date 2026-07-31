/**
 * The AI layer: prompts, providers, generation passes, and the
 * registry-dependent validation stages.
 *
 * **This package must not import `@flowforge/compiler`.** Both depend on `ffir`
 * and `registry`; neither depends on the other. That is the structural
 * expression of the architecture's central decision, which is that the AI layer
 * produces FFIR and knows nothing about any target platform. The moment this
 * package can import the compiler, someone reaches for a platform detail from
 * inside a prompt, and the claim that adding Make.com requires no AI change
 * becomes false. `package.json` not listing the compiler is what actually
 * enforces it: with a strict node linker the import fails to resolve at build
 * time rather than at review time.
 *
 * Validation stages 2 and 3 are all that exist here so far. The provider
 * interface, the two generation passes, the merge, and schema synthesis arrive
 * in M8.
 */

export {
  checkRegistry,
  checkParameters,
  validateAgainstRegistry,
} from "./validate.js";
