/**
 * The retrieval index: how a phrase a person typed becomes a capability ID.
 *
 * This module owns `index.json`, both building it and searching it. It is also
 * the package entry point, so the re-exports at the bottom are the public
 * surface of `@flowforge/registry`.
 *
 * Two consumers, one index. Pass A gets the whole thing inlined behind a prompt
 * cache breakpoint and picks capabilities from it, which is what makes "the
 * model can only choose from things that exist" true rather than hoped for.
 * Rung 1 of the unknown-capability ladder searches it locally, with no model
 * call, to recover from a proposed ID that does not resolve.
 *
 * Search is deterministic. The same index and the same query produce the same
 * array in the same order, every time, because a retrieval layer that reorders
 * itself between runs makes a cache and a regression test equally useless.
 * Ties break on capability ID rather than on whatever order the files loaded in.
 */

import { compareStrings } from "./types.js";
import type {
  Capability,
  CapabilityFile,
  IndexEntry,
  IndexIntegration,
  NodeKind,
  RegistryIndex,
} from "./types.js";

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Builds the retrieval index from the capability files.
 *
 * Step 4 of the generation pipeline, as a pure function, so the M20 generator
 * and the load-time consistency check cannot disagree about what the index for
 * a given set of capability files is.
 */
export function buildIndex(
  files: readonly CapabilityFile[],
  version: string,
): RegistryIndex {
  const byIntegration = [...files].sort((a, b) =>
    compareStrings(a.integration, b.integration),
  );

  const integrations: IndexIntegration[] = byIntegration.map((file) => ({
    integration: file.integration,
    display_name: file.display_name,
    aliases: [...file.aliases],
    categories: [...file.categories],
  }));

  const entries: IndexEntry[] = byIntegration
    .flatMap((file) =>
      file.capabilities.map((capability) => toEntry(file, capability)),
    )
    .sort((a, b) => compareStrings(a.capability_id, b.capability_id));

  return { version, integrations, entries };
}

function toEntry(file: CapabilityFile, capability: Capability): IndexEntry {
  return {
    capability_id: capability.id,
    integration: file.integration,
    kind: capability.kind,
    display_name: capability.display_name,
    description: capability.description,
    aliases: [...capability.aliases],
    categories: [...file.categories],
  };
}

/**
 * The canonical on-disk form of an index.
 *
 * Key order is fixed by construction and the indentation is pinned, so a
 * regenerated `index.json` diffs as a content change or not at all. An artifact
 * whose formatting drifts between builds produces review noise that trains
 * people to skim exactly the diffs they should read.
 */
export function serializeIndex(index: RegistryIndex): string {
  const ordered = {
    version: index.version,
    integrations: index.integrations.map((integration) => ({
      integration: integration.integration,
      display_name: integration.display_name,
      aliases: integration.aliases,
      categories: integration.categories,
    })),
    entries: index.entries.map((entry) => ({
      capability_id: entry.capability_id,
      integration: entry.integration,
      kind: entry.kind,
      display_name: entry.display_name,
      description: entry.description,
      aliases: entry.aliases,
      categories: entry.categories,
    })),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Searching
// ---------------------------------------------------------------------------

/** Which field produced a hit's score. Reported so a substitution can be logged usefully. */
export const MATCH_SOURCES = [
  "capability_id",
  "alias",
  "display_name",
  "integration",
] as const;
export type MatchSource = (typeof MATCH_SOURCES)[number];

/**
 * How much each field counts, and which one to believe when two tie.
 *
 * `weight` scales the raw similarity. `rank` orders equal scores, lowest first,
 * so the most authoritative field is the one reported: an integration's ID and
 * its display name normalize to the same words, and without an order the field
 * named in a hit would be incidental.
 */
interface ScoringProfile {
  weight: Record<MatchSource, number>;
  rank: Record<MatchSource, number>;
}

/**
 * A capability's own ID and curated aliases are the signal. The integration's
 * vocabulary is weak on purpose: "slack" should not be enough to pick one Slack
 * capability over another, and weighting it below the floor is what stops a bare
 * app name returning an arbitrary capability with false confidence.
 */
const CAPABILITY_SCORING: ScoringProfile = {
  weight: { capability_id: 1, alias: 1, display_name: 0.9, integration: 0.45 },
  rank: { capability_id: 0, alias: 1, display_name: 2, integration: 3 },
};

/**
 * Which integration a phrase names is a different question, so the profile
 * differs. Here the integration's own vocabulary is the whole answer rather
 * than a hint, and discounting it would put an exact match on "slack" below the
 * floor.
 */
const INTEGRATION_SCORING: ScoringProfile = {
  weight: { capability_id: 1, alias: 1, display_name: 1, integration: 1 },
  rank: { integration: 0, alias: 1, display_name: 2, capability_id: 3 },
};

export interface SearchHit {
  capability_id: string;
  integration: string;
  display_name: string;
  kind: NodeKind;
  /** 0 to 1. Rounded, so a hit set is comparable across runs and machines. */
  score: number;
  matched_on: MatchSource;
  /** The exact string that scored, so a logged substitution names its evidence. */
  matched_value: string;
}

export interface IntegrationHit {
  integration: string;
  display_name: string;
  score: number;
  matched_on: MatchSource;
  matched_value: string;
}

export interface SearchOptions {
  /** Maximum hits returned. Default 10. */
  limit?: number;
  /** Hits below this are not returned. Default 0.5. */
  minScore?: number;
  /** Restrict to one node kind. Pass A uses this to ask for triggers only. */
  kind?: NodeKind;
  /** Restrict to one integration. Rung 2 of the ladder uses this. */
  integration?: string;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_SCORE = 0.5;

/**
 * Finds capabilities matching free text.
 *
 * Scores every capability against the query and returns those above the floor,
 * best first. An empty result means "nothing is confidently a match", which is
 * a useful answer: it is what sends the unknown-capability ladder to its next
 * rung instead of substituting something wrong.
 */
export function searchCapabilities(
  index: RegistryIndex,
  query: string,
  options: SearchOptions = {},
): SearchHit[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const q = prepare(query);
  if (q.tokens.length === 0 || limit <= 0) return [];

  const integrationsById = new Map(
    index.integrations.map((integration) => [integration.integration, integration]),
  );

  const scored: { hit: SearchHit; match: Match }[] = [];
  for (const entry of index.entries) {
    if (options.kind !== undefined && entry.kind !== options.kind) continue;
    if (options.integration !== undefined && entry.integration !== options.integration) {
      continue;
    }

    const best = bestMatch(q, [
      ...candidates("capability_id", [entry.capability_id]),
      ...candidates("alias", entry.aliases),
      ...candidates("display_name", [entry.display_name]),
      ...candidates("integration", integrationVocabulary(integrationsById.get(entry.integration))),
    ]);
    if (best === undefined || best.score < minScore) continue;

    scored.push({
      hit: {
        capability_id: entry.capability_id,
        integration: entry.integration,
        display_name: entry.display_name,
        kind: entry.kind,
        score: best.score,
        matched_on: best.source,
        matched_value: best.value,
      },
      match: best,
    });
  }

  scored.sort(
    (a, b) =>
      compareMatches(a.match, b.match) ||
      compareStrings(a.hit.capability_id, b.hit.capability_id),
  );
  return scored.slice(0, limit).map((entry) => entry.hit);
}

/**
 * Finds integrations matching free text.
 *
 * Rung 2 of the unknown-capability ladder: when the integration segment
 * resolves but the resource or operation does not, the model is handed that
 * integration's full capability list and asked to pick. That repairs reliably,
 * and it needs the integration identified first.
 */
export function searchIntegrations(
  index: RegistryIndex,
  query: string,
  options: Pick<SearchOptions, "limit" | "minScore"> = {},
): IntegrationHit[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const q = prepare(query);
  if (q.tokens.length === 0 || limit <= 0) return [];

  const scored: { hit: IntegrationHit; match: Match }[] = [];
  for (const integration of index.integrations) {
    const best = bestMatch(
      q,
      [
        ...candidates("integration", [integration.integration]),
        ...candidates("alias", integration.aliases),
        ...candidates("display_name", [integration.display_name]),
      ],
      INTEGRATION_SCORING,
    );
    if (best === undefined || best.score < minScore) continue;

    scored.push({
      hit: {
        integration: integration.integration,
        display_name: integration.display_name,
        score: best.score,
        matched_on: best.source,
        matched_value: best.value,
      },
      match: best,
    });
  }

  scored.sort(
    (a, b) =>
      compareMatches(a.match, b.match) ||
      compareStrings(a.hit.integration, b.hit.integration),
  );
  return scored.slice(0, limit).map((entry) => entry.hit);
}

/** Every index entry for one integration, sorted. The list rung 2 hands to the model. */
export function entriesForIntegration(
  index: RegistryIndex,
  integration: string,
): IndexEntry[] {
  return index.entries.filter((entry) => entry.integration === integration);
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Candidate {
  source: MatchSource;
  value: string;
}

interface Match {
  source: MatchSource;
  value: string;
  score: number;
  /** How many words the matching string covered. The specificity tie-break. */
  tokens: number;
  /** The source's authority under the profile that produced this match. */
  rank: number;
}

interface PreparedQuery {
  normalized: string;
  tokens: string[];
  tokenSet: ReadonlySet<string>;
}

function candidates(source: MatchSource, values: readonly string[]): Candidate[] {
  return values.map((value) => ({ source, value }));
}

function integrationVocabulary(integration: IndexIntegration | undefined): string[] {
  if (integration === undefined) return [];
  return [integration.integration, integration.display_name, ...integration.aliases];
}

function bestMatch(
  query: PreparedQuery,
  pool: readonly Candidate[],
  profile: ScoringProfile = CAPABILITY_SCORING,
): Match | undefined {
  let best: Match | undefined;
  for (const candidate of pool) {
    const raw = similarity(query, candidate.value);
    if (raw === 0) continue;
    const score = round(raw * profile.weight[candidate.source]);
    if (score === 0) continue;

    const match: Match = {
      source: candidate.source,
      value: candidate.value,
      score,
      tokens: tokenize(normalize(candidate.value)).length,
      rank: profile.rank[candidate.source],
    };
    if (best === undefined || compareMatches(match, best) < 0) best = match;
  }
  return best;
}

/**
 * Orders two matches, best first.
 *
 * Score, then which field matched, then how much of the query the matching
 * string covered. That last one settles a genuine ambiguity rather than a
 * cosmetic one: "provision an email address for the new hire" contains two
 * aliases outright, and the longer one is the one the sentence is about.
 */
function compareMatches(a: Match, b: Match): number {
  return b.score - a.score || a.rank - b.rank || b.tokens - a.tokens;
}

/**
 * How well one candidate string matches the query, from 0 to 1.
 *
 * Four bands, strongest first, rather than one blended formula. A blended score
 * is impossible to reason about when a curator asks why their alias did not
 * win; a band is something you can point at.
 */
function similarity(query: PreparedQuery, candidate: string): number {
  const normalized = normalize(candidate);
  if (normalized.length === 0) return 0;
  if (normalized === query.normalized) return 1;

  const tokens = tokenize(normalized);
  if (tokens.length === 0) return 0;

  // The candidate appears verbatim inside the query: "post to slack" within
  // "please post to slack when it finishes".
  if (containsRun(query.tokens, tokens)) return 0.9;

  // Every word of the candidate is somewhere in the query, order aside.
  if (tokens.every((token) => query.tokenSet.has(token))) return 0.75;

  const overlap = jaccard(new Set(tokens), query.tokenSet);
  return overlap === 0 ? 0 : 0.6 * overlap;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  if (intersection === 0) return 0;
  return intersection / (a.size + b.size - intersection);
}

/** True when `needle` occurs as a contiguous run inside `haystack`. */
function containsRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

function prepare(query: string): PreparedQuery {
  const normalized = normalize(query);
  const tokens = tokenize(normalized);
  return { normalized, tokens, tokenSet: new Set(tokens) };
}

/**
 * Lowercases and reduces everything that is not a letter or digit to a single
 * space, which is also what turns `slack.message.send` into three words.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words that carry no retrieval signal.
 *
 * Kept deliberately short. Dropping "new" would lose "new employee", and
 * dropping "send" or "create" would lose the verb that distinguishes one
 * operation from another, so this list holds only articles, prepositions, and
 * possessives.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "be",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "my",
  "of",
  "on",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "with",
]);

function tokenize(normalized: string): string[] {
  if (normalized.length === 0) return [];
  const words = normalized.split(" ");
  const kept = words.filter((word) => !STOPWORDS.has(word));
  // A query made entirely of stopwords keeps them, because the alternative is
  // silently searching for nothing.
  return kept.length > 0 ? kept : words;
}

/** Four decimal places. Enough to separate the bands, few enough to compare exactly. */
function round(score: number): number {
  return Math.round(score * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// Package surface
// ---------------------------------------------------------------------------

export * from "./types.js";
export {
  RegistryError,
  RegistryArtifactError,
  RegistryErrorCode,
} from "./errors.js";
export {
  checkCapabilityFile,
  checkBindingFile,
  checkRegistryIndex,
  capabilityFileSchema,
  bindingFileSchema,
  registryIndexSchema,
  type SchemaViolation,
  type SchemaCheckResult,
} from "./schema.js";
export {
  checkIntegrity,
  IntegrityCode,
  type IntegrityIssue,
  type IntegrityInput,
} from "./integrity.js";
export {
  RegistryLoader,
  RegistryIntegrityError,
  FileSystemArtifactSource,
  MemoryArtifactSource,
  ARTIFACT_PATHS,
  type ArtifactEntry,
  type ArtifactSource,
  type LoaderOptions,
  type PinnedLoad,
  type RegistryWarning,
} from "./load.js";
export {
  resolve,
  resolveForTarget,
  resolveBinding,
  resolveAuth,
  capabilitiesOfIntegration,
  integrationOf,
  isCoreCapability,
  type ResolvedCapability,
  type ResolvedTargetCapability,
  type BindingStatus,
} from "./resolve.js";
