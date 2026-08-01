/**
 * FFIR to the things a human looks at.
 *
 * Four renderers, all pure functions of FFIR, three of them joined against the
 * registry or the recorded layout. This is the payoff from the decision that
 * Claude emits FFIR and nothing else: four artifacts, zero additional model
 * calls, zero additional hallucination surfaces, all unit-testable.
 *
 * | Renderer | Input | Output |
 * | --- | --- | --- |
 * | `toMermaid` | FFIR | Mermaid `flowchart TD` source |
 * | `toSetupGuide` | FFIR + registry | Markdown |
 * | `toIntegrations` | FFIR + registry | Structured list for the UI |
 * | `toReactFlow` | FFIR + `metadata.layout` | Nodes and edges for the canvas |
 *
 * ## Renderers are not compiler targets
 *
 * They are siblings of `packages/compiler` and this package does not import it.
 * The distinction is real rather than organizational: a compiler target
 * produces something executable on another platform and must satisfy that
 * platform's semantics, while a renderer produces something a person reads.
 * Different correctness criteria, different tests, and no reason to share the
 * `Target` interface.
 *
 * The one place the two must agree is canvas positions, and they agree by
 * `toReactFlow` consuming what the compiler produced rather than recomputing
 * it. See the note in `react-flow.ts`.
 */

export {
  toMermaid,
  colorOf,
  shapeFor,
  NODE_SHAPES,
  PORT_COLORS,
  DEFAULT_PORT_COLOR,
  type MermaidOptions,
} from "./mermaid.js";

export {
  toSetupGuide,
  credentialGuides,
  type CredentialGuide,
  type SetupGuideOptions,
} from "./setup-guide.js";

export {
  toIntegrations,
  type IntegrationUsage,
  type IntegrationsList,
} from "./integrations.js";

export {
  toReactFlow,
  hasLayout,
  type CanvasData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasPosition,
  type ReactFlowOptions,
} from "./react-flow.js";

export { readingOrder } from "./order.js";
