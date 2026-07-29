/**
 * FFIR: the FlowForge intermediate representation.
 *
 * Claude produces FFIR and nothing else. The n8n export is a compile of it, the
 * mermaid diagram is a render of it, and the setup guide is a render of it
 * joined against the registry. Four artifacts, one hallucination surface.
 *
 * This package depends on nothing.
 */

export * from "./types.js";
export { DOCUMENT_LIMITS, type DocumentLimits, type LimitName } from "./limits.js";
export * from "./validate/index.js";
