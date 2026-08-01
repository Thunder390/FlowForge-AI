/**
 * Per-tenant credential resolution.
 *
 * Small surface, and every one of its behaviours is a decision that would be
 * expensive to reverse later: tenant keys win, the platform is a fallback and
 * not a default, a deployment with neither fails where it can name the
 * organization, and nothing is cached.
 */

import { describe, expect, it, vi } from "vitest";

import { ProviderResolver, type ProviderCredentials } from "./resolve.js";
import { ProviderError, type ModelProvider } from "./types.js";
import { REPLAY_CAPABILITIES } from "./replay.js";

function fakeProvider(credentials: ProviderCredentials): ModelProvider {
  return {
    key: `fake:${credentials.apiKey}`,
    capabilities: REPLAY_CAPABILITIES,
    // Never reached: these tests are about which credentials win, not about
    // generating anything.
    async *generate(): AsyncIterable<never> {
      throw new Error("not called");
    },
  };
}

const PLATFORM: ProviderCredentials = { apiKey: "platform-key" };

describe("resolving a provider", () => {
  it("uses the tenant's own credentials when it has them", async () => {
    const resolver = new ProviderResolver({
      create: fakeProvider,
      platform: PLATFORM,
      store: { forOrganization: async () => ({ apiKey: "tenant-key" }) },
    });

    const resolved = await resolver.resolve("org_1");
    expect(resolved.source).toBe("tenant");
    expect(resolved.provider.key).toBe("fake:tenant-key");
  });

  it("falls back to the platform's when the tenant has none", async () => {
    const resolver = new ProviderResolver({
      create: fakeProvider,
      platform: PLATFORM,
      store: { forOrganization: async () => undefined },
    });

    const resolved = await resolver.resolve("org_1");
    expect(resolved.source).toBe("platform");
    expect(resolved.provider.key).toBe("fake:platform-key");
  });

  it("works with no store at all, which is the single-tenant deployment", async () => {
    const resolver = new ProviderResolver({ create: fakeProvider, platform: PLATFORM });
    expect((await resolver.resolve("org_1")).source).toBe("platform");
  });

  it("fails by naming the organization when there are no credentials anywhere", async () => {
    // A configuration error, and it belongs here rather than as a 401 from
    // inside a stream three stages later.
    const resolver = new ProviderResolver({ create: fakeProvider });

    let thrown: unknown;
    try {
      await resolver.resolve("org_missing");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as ProviderError).code).toBe("credentials_missing");
    expect((thrown as ProviderError).message).toContain("org_missing");
  });

  it("asks the store every time, so a rotated key takes effect immediately", async () => {
    // Memoising a provider per organization would keep using a revoked key
    // until the process restarted, and key rotation is the exact scenario
    // tenant credentials exist for.
    const forOrganization = vi
      .fn<(id: string) => Promise<ProviderCredentials | undefined>>()
      .mockResolvedValueOnce({ apiKey: "old" })
      .mockResolvedValueOnce({ apiKey: "new" });

    const resolver = new ProviderResolver({
      create: fakeProvider,
      store: { forOrganization },
      platform: PLATFORM,
    });

    expect((await resolver.resolve("org_1")).provider.key).toBe("fake:old");
    expect((await resolver.resolve("org_1")).provider.key).toBe("fake:new");
    expect(forOrganization).toHaveBeenCalledTimes(2);
  });

  it("passes the organization id through to the store", async () => {
    const forOrganization = vi
      .fn<(id: string) => Promise<ProviderCredentials | undefined>>()
      .mockResolvedValue(undefined);

    await new ProviderResolver({
      create: fakeProvider,
      store: { forOrganization },
      platform: PLATFORM,
    }).resolve("org_abc");

    expect(forOrganization).toHaveBeenCalledWith("org_abc");
  });
});
