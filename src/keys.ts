import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { fetchWithRetry, readJsonBody, type FetchLike } from "./http.js";
import { isRecord } from "./util.js";

/** Config field that holds the server's own key for each built-in provider. */
const SHARED_FIELDS: Record<string, keyof Config> = {
  tavily: "tavilyKey",
  jina: "jinaKey",
  moltsets: "moltsetsKey",
  parallel: "parallelKey",
  you: "youKey",
  linkup: "linkupKey",
  firecrawl: "firecrawlKey",
  serper: "serperKey",
  apify: "apifyKey",
  browserbase: "browserbaseKey",
  apollo: "apolloKey",
  hunter: "hunterKey",
};

/** The server's own extra fields for a slot, e.g. SALESFORCE_INSTANCE_URL. */
export function sharedMeta(config: Config, slot: string): Record<string, string> {
  if (!config.sharedKeys) return {};
  const out: Record<string, string> = {};
  for (const field of META_FIELDS) {
    const value = process.env[`${slot.toUpperCase().replace(/-/g, "_")}_${field.toUpperCase()}`]?.trim();
    if (value) out[field] = value;
  }
  return out;
}

/** The server's own key for a provider slot, or undefined (also when shared keys are switched off). */
export function sharedKey(config: Config, slot: string): string | undefined {
  if (!config.sharedKeys) return undefined;
  const field = SHARED_FIELDS[slot];
  if (field) return config[field] as string | undefined;
  // Providers that exist only as a tool file: HUBSPOT_API_KEY style variable.
  return process.env[`${slot.toUpperCase().replace(/-/g, "_")}_API_KEY`]?.trim() || undefined;
}

export type KeySource = "own" | "shared" | "none";

/** Extra connection fields a tool may need besides the key. Only these are ever read. */
const META_FIELDS = ["instance_url"] as const;

export interface ResolvedKeys {
  /** slot -> key, for the slots that have one. */
  keys: Record<string, string>;
  /** slot -> extra connection fields (e.g. a Salesforce instance_url). */
  meta: Record<string, Record<string, string>>;
  /** slot -> where it came from. */
  source: Record<string, KeySource>;
}

interface Cached {
  at: number;
  /** Slots already looked up, whether or not the user has a key for them. */
  checked: Set<string>;
  keys: Record<string, string>;
  meta: Record<string, Record<string, string>>;
}

const TTL_MS = 60_000;

/**
 * Finds the provider keys a given user should use.
 *
 * With NANGO_SECRET_KEY set, a user's own keys come from Nango (saved on the Connections page,
 * linked to the user by the `end_user_id` tag). The server's own keys in .env are only a fallback,
 * and only while OUTMATE_SHARED_KEYS is not "false". Without Nango, the .env keys are used for
 * everyone, as before.
 */
export class KeyResolver {
  private readonly cache = new Map<string, Cached>();

  constructor(
    private readonly config: Config,
    private readonly fetchImpl?: FetchLike,
    private readonly now: () => number = Date.now,
  ) {}

  nangoEnabled(): boolean {
    return Boolean(this.config.nangoSecretKey);
  }

  /** Forget a user's cached keys, e.g. right after they connect a provider. */
  invalidate(user: string): void {
    this.cache.delete(user);
  }

  private shared(slot: string): string | undefined {
    return sharedKey(this.config, slot);
  }

  private async nango<T>(path: string): Promise<T> {
    const res = await fetchWithRetry(
      `${this.config.nangoHost}${path}`,
      { headers: { Authorization: `Bearer ${this.config.nangoSecretKey}`, Accept: "application/json" } },
      { fetchImpl: this.fetchImpl, timeoutMs: 8000, maxRetries: 1 },
    );
    if (res.status === 404) throw new AppError("E_NOT_FOUND", "Nango connection not found");
    if (!res.ok) throw new AppError("E_PROVIDER", `Nango returned HTTP ${res.status}`);
    return (await readJsonBody(res, "Nango")) as T;
  }

  /** The user's own keys, one per slot they have connected in Nango. */
  private async own(user: string, slots: string[]): Promise<Pick<Cached, "keys" | "meta">> {
    const hit = this.cache.get(user);
    if (hit && this.now() - hit.at < TTL_MS && slots.every((s) => hit.checked.has(s))) return hit;

    const listed = await this.nango<{ connections?: unknown }>(
      `/connections?tags[end_user_id]=${encodeURIComponent(user)}`,
    );
    const connections = Array.isArray(listed.connections) ? listed.connections : [];
    const byIntegration = new Map<string, string>();
    for (const c of connections) {
      if (isRecord(c) && typeof c.connection_id === "string" && typeof c.provider_config_key === "string") {
        byIntegration.set(c.provider_config_key, c.connection_id);
      }
    }

    const keys: Record<string, string> = {};
    const meta: Record<string, Record<string, string>> = {};
    await Promise.all(
      slots.map(async (slot) => {
        const connectionId = byIntegration.get(slot);
        if (!connectionId) return;
        try {
          const conn = await this.nango<{ credentials?: unknown; connection_config?: unknown }>(
            `/connections/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(slot)}`,
          );
          const cred = isRecord(conn.credentials) ? conn.credentials : {};
          const key = cred.apiKey ?? cred.api_key ?? cred.access_token;
          if (typeof key === "string" && key) keys[slot] = key;
          const config = isRecord(conn.connection_config) ? conn.connection_config : {};
          const extra: Record<string, string> = {};
          for (const field of META_FIELDS) {
            const value = config[field];
            if (typeof value === "string" && value) extra[field] = value;
          }
          if (Object.keys(extra).length) meta[slot] = extra;
        } catch {
          // This provider's connection is unreadable: treat it as not connected.
        }
      }),
    );
    this.cache.set(user, { at: this.now(), checked: new Set(slots), keys, meta });
    return { keys, meta };
  }

  async forUser(user: string | null, slots: string[]): Promise<ResolvedKeys> {
    let own: Record<string, string> = {};
    let ownMeta: Record<string, Record<string, string>> = {};
    if (this.nangoEnabled() && user) {
      try {
        const found = await this.own(user, slots);
        own = found.keys;
        ownMeta = found.meta;
      } catch (err) {
        // Nango down: fall back to shared keys rather than failing every search.
        console.error(`nango lookup failed: ${err instanceof AppError ? err.code : "error"}`);
      }
    }
    const resolved: ResolvedKeys = { keys: {}, meta: {}, source: {} };
    for (const slot of slots) {
      const mine = own[slot];
      const shared = this.shared(slot);
      if (mine) {
        resolved.keys[slot] = mine;
        resolved.source[slot] = "own";
        if (ownMeta[slot]) resolved.meta[slot] = ownMeta[slot];
      } else if (shared) {
        resolved.keys[slot] = shared;
        resolved.source[slot] = "shared";
        const extra = sharedMeta(this.config, slot);
        if (Object.keys(extra).length) resolved.meta[slot] = extra;
      } else {
        resolved.source[slot] = "none";
      }
    }
    return resolved;
  }

  /** Start a Nango Connect session so this user can add one provider's key. */
  async createConnectSession(user: string, slot: string, email?: string): Promise<{ token: string; expires_at?: string }> {
    if (!this.nangoEnabled()) throw new AppError("E_CONFIG", "Nango is not configured on this server");
    const res = await fetchWithRetry(
      `${this.config.nangoHost}/connect/sessions`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.nangoSecretKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          tags: { end_user_id: user, ...(email ? { end_user_email: email } : {}) },
          allowed_integrations: [slot],
        }),
      },
      { fetchImpl: this.fetchImpl, timeoutMs: 8000, maxRetries: 0 },
    );
    if (!res.ok) throw new AppError("E_PROVIDER", `Nango could not start a connection (HTTP ${res.status})`);
    const body = await readJsonBody(res, "Nango");
    const data = isRecord(body) && isRecord(body.data) ? body.data : {};
    if (typeof data.token !== "string") throw new AppError("E_PROVIDER", "Nango returned no session token");
    return { token: data.token, expires_at: typeof data.expires_at === "string" ? data.expires_at : undefined };
  }
}
