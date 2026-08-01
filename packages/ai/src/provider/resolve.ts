/**
 * Per-tenant provider credentials.
 *
 * Credentials resolve **per tenant, not per deployment.** The Agency tier
 * already promises custom API keys, and an enterprise customer will want
 * Bedrock or Vertex under their own contract and data-residency terms. A
 * provider constructed once from environment variables makes that a rewrite
 * later rather than a configuration change now, and the cost of getting it
 * right at this point is this file.
 *
 * ## Nothing here reads the environment
 *
 * Environment variables are parsed once at startup and exported as a typed
 * object; `process.env` is not read anywhere else. So the platform's own
 * credentials arrive as a value, which is also what makes this testable without
 * mutating global state.
 *
 * ## Nothing here caches
 *
 * A resolver that memoised a provider per organization would keep using a
 * revoked key until the process restarted, and key rotation is the exact
 * scenario tenant credentials exist for. Caching belongs to the store, which
 * knows when its own data changed.
 */

import { ProviderError, type ModelProvider } from "./types.js";

export interface ProviderCredentials {
  apiKey: string;
  /** For a gateway, a compatible endpoint, or a regional deployment. */
  baseUrl?: string;
}

/**
 * Where a tenant's own credentials come from.
 *
 * An interface rather than a concrete repository because `packages/db` does not
 * exist yet and this layer should not wait for it. The production
 * implementation reads the encrypted `provider_credentials` row; the test
 * implementation is a `Map`.
 */
export interface ProviderCredentialStore {
  /** The tenant's credentials, or `undefined` to fall back to the platform's. */
  forOrganization(organizationId: string): Promise<ProviderCredentials | undefined>;
}

export type ProviderFactory = (credentials: ProviderCredentials) => ModelProvider;

/** Which key paid for the call. Metering treats the two differently. */
export type CredentialSource = "tenant" | "platform";

export interface ResolvedProvider {
  provider: ModelProvider;
  source: CredentialSource;
}

export interface ProviderResolverOptions {
  create: ProviderFactory;
  store?: ProviderCredentialStore;
  /** Used when the tenant has supplied none. Absent in a bring-your-own-key deployment. */
  platform?: ProviderCredentials;
}

export class ProviderResolver {
  readonly #create: ProviderFactory;
  readonly #store: ProviderCredentialStore | undefined;
  readonly #platform: ProviderCredentials | undefined;

  constructor(options: ProviderResolverOptions) {
    this.#create = options.create;
    this.#store = options.store;
    this.#platform = options.platform;
  }

  /**
   * The provider this organization's generations run on.
   *
   * Tenant credentials win when present. A deployment with neither is a
   * configuration error and fails here, at the point where it can name the
   * organization, rather than as a 401 from inside a stream.
   */
  async resolve(organizationId: string): Promise<ResolvedProvider> {
    const tenant = await this.#store?.forOrganization(organizationId);
    if (tenant !== undefined) {
      return { provider: this.#create(tenant), source: "tenant" };
    }

    if (this.#platform === undefined) {
      throw new ProviderError(
        "credentials_missing",
        `Organization "${organizationId}" has no model provider credentials and this deployment has no platform credentials to fall back to.`,
        { organizationId },
      );
    }

    return { provider: this.#create(this.#platform), source: "platform" };
  }
}
