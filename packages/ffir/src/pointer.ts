/**
 * RFC 6901 JSON Pointer construction.
 *
 * Every validation error carries a pointer into the document, and a parameter
 * legitimately named `a/b` would otherwise produce a pointer that addresses
 * something else entirely. Shared rather than duplicated because two escapers
 * that disagree is the same bug as no escaper at all.
 */

/** Escapes one path segment. `~` becomes `~0` and `/` becomes `~1`, in that order. */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Builds a pointer from segments. `pointer("nodes", 3, "id")` is `/nodes/3/id`. */
export function pointer(...segments: Array<string | number>): string {
  return segments.map((segment) => `/${escapePointer(String(segment))}`).join("");
}
