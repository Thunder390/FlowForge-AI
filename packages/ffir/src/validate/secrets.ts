/**
 * The secret scanner (validation rule 14).
 *
 * FFIR is a blueprint people download, store, and eventually publish to a
 * marketplace. A live credential written into a parameter value would be
 * persisted, exported, and shared, so a match is a hard validation failure and
 * never a warning: the workflow does not compile.
 *
 * It is exported as its own module because it runs twice by design, in the
 * validator and again in the compiler. The compiler is a public library
 * boundary and must not assume its caller validated. This is the one property
 * where the cost of the duplicate check is trivially worth it.
 *
 * The pattern list is owned by docs/SECURITY.md. Adding a pattern there means
 * adding it here.
 */

export interface SecretPattern {
  /** Stable machine-readable name, reported in the error details. */
  name: string;
  /** What the pattern recognises, for the human-readable message. */
  describes: string;
  pattern: RegExp;
}

/**
 * Transcribed from the scanner table in docs/SECURITY.md.
 *
 * No `g` flag anywhere: a global regex carries `lastIndex` between calls, and a
 * scanner that matches only every other time it is asked is worse than none.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: "openai_key",
    describes: "an OpenAI-style API key",
    pattern: /sk-[A-Za-z0-9]{20,}/,
  },
  {
    name: "slack_token",
    describes: "a Slack token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "github_token",
    describes: "a GitHub token",
    pattern: /gh[pousr]_[A-Za-z0-9]{36}/,
  },
  {
    name: "aws_access_key_id",
    describes: "an AWS access key ID",
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    name: "google_api_key",
    describes: "a Google API key",
    pattern: /AIza[0-9A-Za-z_-]{35}/,
  },
  {
    name: "private_key",
    describes: "a private key block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "jwt",
    describes: "a JSON Web Token",
    pattern: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./,
  },
];

/**
 * Field-name fragments that make a long opaque string suspicious.
 *
 * The generic fallback needs both a name from this list and a high-entropy run,
 * because either signal alone is far too noisy: plenty of parameters are named
 * `key`, and plenty of long strings are legitimate.
 */
const SECRET_NAME_FRAGMENTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "pwd",
  "apikey",
  "api_key",
  "access_key",
  "private_key",
  "client_secret",
  "credential",
  "auth",
  "bearer",
  "signature",
  "key",
] as const;

/** Minimum length for the generic high-entropy check, from SECURITY.md. */
const GENERIC_MIN_LENGTH = 40;

/**
 * Shannon entropy in bits per character, above which a run of that length is
 * treated as opaque rather than as words.
 *
 * Random base64 measures near 5 over 40 characters; English prose and
 * identifier-like text measure well below 4.
 */
const GENERIC_MIN_ENTROPY = 4;

const BASE64_RUN = /[A-Za-z0-9+/=_-]{40,}/;

/** Expression syntax, stripped before the generic check. See `findSecret`. */
const EXPRESSION = /\{\{[\s\S]*?\}\}/g;

export interface SecretMatch {
  /** The `SecretPattern.name` that matched, or `high_entropy_string`. */
  pattern: string;
  describes: string;
  /**
   * A masked preview. Never the matched text.
   *
   * Validation errors reach logs and the repair prompt, and a repair prompt is
   * sent back to the model and stored with the generation. Echoing the secret
   * to prove we found a secret would spread it to three more places.
   */
  preview: string;
}

export interface SecretScanOptions {
  /**
   * Keys on the path to this value, outermost first. The generic high-entropy
   * check fires only when one of them names something secret-like.
   */
  fieldNames?: readonly string[];
}

/**
 * Returns the first pattern this value matches, or `undefined`.
 *
 * First rather than all: one match is a hard failure, and enumerating every
 * pattern a leaked key matches tells the author nothing extra.
 */
export function findSecret(
  value: string,
  options: SecretScanOptions = {},
): SecretMatch | undefined {
  for (const candidate of SECRET_PATTERNS) {
    const match = candidate.pattern.exec(value);
    if (match !== null) {
      return {
        pattern: candidate.name,
        describes: candidate.describes,
        preview: mask(match[0]),
      };
    }
  }

  return findHighEntropyRun(value, options.fieldNames ?? []);
}

/**
 * The generic fallback: a long high-entropy run in a field named like a secret.
 *
 * Expressions are stripped first. `{{ $vars.temp_password }}` in a parameter
 * named `password` is exactly the shape the architecture asks authors to use,
 * and a scanner that rejects the correct pattern would push people back toward
 * the wrong one.
 */
function findHighEntropyRun(
  value: string,
  fieldNames: readonly string[],
): SecretMatch | undefined {
  if (!fieldNames.some(isSecretFieldName)) return undefined;

  const literal = value.replace(EXPRESSION, " ");
  const run = BASE64_RUN.exec(literal);
  if (run === null) return undefined;
  if (run[0].length < GENERIC_MIN_LENGTH) return undefined;
  if (shannonEntropy(run[0]) < GENERIC_MIN_ENTROPY) return undefined;

  return {
    pattern: "high_entropy_string",
    describes: "an opaque high-entropy value in a field named like a secret",
    preview: mask(run[0]),
  };
}

/** True when the name suggests the field holds a credential. */
export function isSecretFieldName(name: string): boolean {
  const normalized = name.toLowerCase();
  return SECRET_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Shannon entropy of `text` in bits per character. */
export function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;

  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/** Enough to recognise the value you pasted, not enough to use it. */
function mask(matched: string): string {
  const head = matched.slice(0, 4);
  return `${head}... (${matched.length} characters)`;
}
