/**
 * Deterministic UUIDv5.
 *
 * n8n nodes carry an `id`, and generating it with `randomUUID()` would make
 * every compile of the same document produce a different file. That would end
 * golden-file testing, which is the only technique that makes a compiler's
 * otherwise silent bugs visible in review. COMPILER_ARCHITECTURE calls this out
 * as "a small decision with outsized value", and it is: the id is invisible to
 * the user and load-bearing for us.
 *
 * RFC 4122 section 4.3. SHA-1 over the namespace bytes followed by the name,
 * truncated to 16 bytes, with the version and variant bits overwritten. SHA-1 is
 * doing no security work here, only providing a stable spread, which is why its
 * collision weakness does not matter.
 */

import { createHash } from "node:crypto";

/**
 * The FlowForge namespace, `uuidv5("flowforge.dev", DNS_NAMESPACE)`.
 *
 * Hard-coded rather than computed at startup so that this file is the whole
 * story: reproduce it with the standard DNS namespace
 * `6ba7b810-9dad-11d1-80b4-00c04fd430c8` and the name `flowforge.dev`. Changing
 * it renumbers every node in every workflow anyone has ever exported, so it is
 * effectively permanent.
 */
export const FLOWFORGE_NAMESPACE = "37263b35-e483-5cfc-a59c-8119406691d2";

/**
 * The id for one node, from the workflow it belongs to and its FFIR id.
 *
 * Scoped by workflow so that two workflows using the same node id do not
 * collide, which matters once a user imports both into one n8n instance.
 */
export function nodeUuid(workflowId: string, nodeId: string): string {
  return uuidv5(`node:${workflowId}:${nodeId}`);
}

/**
 * The id for something inside a node, such as one Set-node field assignment.
 *
 * n8n gives several nested structures their own ids. They need the same
 * treatment as node ids and the same guarantee: same input, same id.
 */
export function partUuid(workflowId: string, nodeId: string, part: string): string {
  return uuidv5(`part:${workflowId}:${nodeId}:${part}`);
}

export function uuidv5(name: string, namespace: string = FLOWFORGE_NAMESPACE): string {
  const digest = createHash("sha1")
    .update(Buffer.concat([namespaceBytes(namespace), Buffer.from(name, "utf8")]))
    .digest();

  const bytes = Buffer.from(digest.subarray(0, 16));
  // Version 5 in the high nibble of octet 6, RFC 4122 variant in octet 8.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

function namespaceBytes(namespace: string): Buffer {
  const hex = namespace.replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`not a UUID: ${namespace}`);
  }
  return Buffer.from(hex, "hex");
}
