/**
 * How the model learns what exists.
 *
 * Retrieval is the reason there are two passes. The MVP registry is roughly 120
 * capabilities with full parameter schemas, far too large to send on every
 * request and enough to degrade output quality even if it fit. Splitting the
 * work means pass A decides *what* it needs from a compact index, and pass B
 * fills in details for *only those things*. A five-node workflow needs a two to
 * four thousand token bundle against roughly two hundred thousand for the whole
 * registry, and that ratio is the entire justification for the architecture.
 *
 * The interface exists because the inline strategy stops being right somewhere
 * past two hundred capabilities, at which point the catalog no longer wants to
 * sit in every request and retrieval becomes a tool the model calls. That is a
 * different implementation of the same idea, and naming the seam now is cheaper
 * than discovering it later.
 */

import type { Registry } from "@flowforge/registry";

/**
 * Full parameter and output detail for the capabilities a plan named.
 *
 * `unknown` is a list rather than a failure because the unknown-capability
 * ladder owns what happens next: alias search locally, then one cheap model
 * call against the integration's real capability list, then honest degradation
 * to an HTTP step. Deciding that here would put a retry policy inside a lookup.
 */
export interface SchemaBundle {
  /** The prompt text. Deterministic for a given registry and capability set. */
  text: string;
  /** Capability ids that resolved, sorted. */
  resolved: string[];
  /** Capability ids the registry does not contain, sorted. Feed to the ladder. */
  unknown: string[];
}

export interface CapabilityRetriever {
  /** `"inline" | "tool-search"`. Recorded on the generation. */
  readonly key: string;

  /**
   * The capability catalog for pass A's cached prefix.
   *
   * Must be byte-identical across every request against one registry build. A
   * single reordered key invalidates the whole cached prefix and the hit rate
   * silently drops to zero, which costs roughly ten times more per request
   * while every test still passes.
   */
  catalog(registry: Registry): string;

  /** Full schemas for exactly the capabilities named, and nothing else. */
  bundle(registry: Registry, capabilityIds: readonly string[]): SchemaBundle;
}
