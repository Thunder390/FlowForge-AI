/**
 * Prompt loading and versioning.
 *
 * Prompts are files under `prompts/<name>/v<n>.md`, not string literals,
 * because a generation record has to be attributable to a prompt revision. An
 * eval result that cannot be traced to the text that produced it cannot be used
 * to bisect a regression, and "the prompt changed at some point last week" is
 * how a quality drop becomes unfixable.
 *
 * ## Why the version is composite
 *
 * `metadata.prompt_version` is one string and a generation uses several
 * prompts, so the recorded version names each of them: `pass_a@1+pass_b@1`.
 * That is longer than a single number and it is the only form that answers the
 * question actually asked of it later, which is "which text produced this
 * document". A single counter bumped by hand drifts the first time two prompts
 * are edited in one change.
 *
 * ## Reading from disk
 *
 * Lazily, and cached. This package is allowed I/O, unlike the compiler, and a
 * markdown file that a prompt engineer can edit without touching TypeScript is
 * worth the read. The cache means the cost is paid once per process rather than
 * once per generation.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every prompt this build ships, with the revision in use. */
export const PROMPTS = {
  pass_a: 1,
  pass_b: 1,
} as const;

export type PromptName = keyof typeof PROMPTS;

export const PROMPT_NAMES = Object.keys(PROMPTS) as PromptName[];

/**
 * The composite version stamped onto every generated document.
 *
 * Built from `PROMPTS` rather than written out, so bumping a revision cannot be
 * done without the recorded version following.
 */
export const PROMPT_VERSION: string = PROMPT_NAMES.map(
  (name) => `${name}@${PROMPTS[name]}`,
).join("+");

const cache = new Map<PromptName, string>();

/** The text of a prompt, with trailing whitespace normalized away. */
export function loadPrompt(name: PromptName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const text = readFileSync(promptPath(name), "utf8").trimEnd();
  cache.set(name, text);
  return text;
}

/** Absolute path to a prompt file. Exported so a test can assert it exists. */
export function promptPath(name: PromptName): string {
  return fileURLToPath(new URL(`../prompts/${name}/v${PROMPTS[name]}.md`, import.meta.url));
}
