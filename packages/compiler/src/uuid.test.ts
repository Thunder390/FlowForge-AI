import { describe, expect, it } from "vitest";

import { FLOWFORGE_NAMESPACE, nodeUuid, partUuid, uuidv5 } from "./uuid.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

describe("uuidv5", () => {
  it("matches the published test vector", () => {
    // RFC 4122's own example: v5 of "www.example.org" in the DNS namespace.
    // Anchoring to a value computed elsewhere is what proves this is UUIDv5 and
    // not merely a stable hash of our own invention.
    expect(uuidv5("www.example.org", DNS)).toBe("74738ff5-5367-5958-9aee-98fffdcd1876");
  });

  it("derives the FlowForge namespace from the DNS namespace", () => {
    expect(uuidv5("flowforge.dev", DNS)).toBe(FLOWFORGE_NAMESPACE);
  });

  it("produces a well-formed version 5 UUID", () => {
    const value = uuidv5("anything");
    expect(value).toMatch(UUID);
    expect(value[14]).toBe("5");
    expect("89ab").toContain(value[19]);
  });

  it("is stable across calls", () => {
    expect(uuidv5("same")).toBe(uuidv5("same"));
  });

  it("separates different names", () => {
    expect(uuidv5("a")).not.toBe(uuidv5("b"));
  });

  it("rejects a namespace that is not a UUID", () => {
    expect(() => uuidv5("x", "not-a-uuid")).toThrow();
  });
});

describe("node ids", () => {
  it("depends on both the workflow and the node", () => {
    // Scoped by workflow so two workflows using the same node id do not collide
    // once a user imports both into one n8n instance.
    expect(nodeUuid("wf_1", "n_a")).not.toBe(nodeUuid("wf_2", "n_a"));
    expect(nodeUuid("wf_1", "n_a")).not.toBe(nodeUuid("wf_1", "n_b"));
  });

  it("is the same every time, which is what makes golden files possible", () => {
    expect(nodeUuid("wf_01HQ8XONBOARD", "n_trigger")).toBe(
      nodeUuid("wf_01HQ8XONBOARD", "n_trigger"),
    );
  });

  it("does not collide with a part id built from the same strings", () => {
    expect(nodeUuid("wf", "n")).not.toBe(partUuid("wf", "n", ""));
  });

  it("separates parts within one node", () => {
    expect(partUuid("wf", "n", "a")).not.toBe(partUuid("wf", "n", "b"));
  });
});
