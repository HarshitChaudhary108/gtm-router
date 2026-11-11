import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export interface Config {
  port: number;
  mcpPort: number;
  mcpHost: string;
  mcpAuthToken?: string;
  /** Public base URL written into the setup files. Falls back to request headers when unset. */
  publicUrl?: string;
  /** Token store file. Its existence turns per-user token auth on. */
  tokensFile: string;
  tavilyKey?: string;
  jinaKey?: string;
  llmKey?: string;
  moltsetsKey?: string;
  parallelKey?: string;
  youKey?: string;
  linkupKey?: string;
  firecrawlKey?: string;
  serperKey?: string;
  apifyKey?: string;
  browserbaseKey?: string;
  apolloKey?: string;
  hunterKey?: string;
  /** Nango secret key. When set, each user's provider keys live in Nango (see src/keys.ts). */
  nangoSecretKey?: string;
  nangoHost: string;
  /** Fall back to the server's own provider keys when a user has none. Default on. */
  sharedKeys: boolean;
  llmBaseUrl: string;
  llmModel: string;
  /** Optional reasoning_effort sent to the LLM (e.g. "low" for Gemini 3 / OpenAI reasoning models). */
  llmReasoningEffort?: string;
  /** Self-serve /signup page. Off unless SIGNUP_ENABLED=true. */
  signupEnabled: boolean;
  /** Invite code required on /signup when set. */
  signupCode?: string;
  /** Most tokens /signup may create per hour, across all users. */
  signupPerHour: number;
  maxResultsCap: number;
  maxMoltResults: number;
  maxResultChars: number;
  maxPageChars: number;
  llmContentChars: number;
  maxRequestChars: number;
  searchTimeoutMs: number;
  readTimeoutMs: number;
  llmTimeoutMs: number;
  moltsetsTimeoutMs: number;
  apifyTimeoutMs: number;
}

export const LIMITS = {
  maxResultsCap: 10,
  maxMoltResults: 10,
  maxResultChars: 4000,
  maxPageChars: 20000,
  llmContentChars: 20000,
  maxRequestChars: 2000,
  searchTimeoutMs: 20_000,
  readTimeoutMs: 45_000,
  llmTimeoutMs: 60_000,
  moltsetsTimeoutMs: 20_000,
  apifyTimeoutMs: 120_000,
} as const;

/** Load .env if present. Does not fail when the file is missing. */
export function loadEnv(path = ".env"): void {
  try {
    if (existsSync(path)) loadEnvFile(path);
  } catch {
    // Keep any values already present in the process environment.
  }
}

export function parseConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const str = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };
  const validPort = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : undefined;
  };
  return {
    port: validPort(env.PORT) ?? 3000,
    mcpPort: validPort(env.MCP_PORT) ?? 3333,
    mcpHost: str(env.MCP_HOST) ?? "127.0.0.1",
    mcpAuthToken: str(env.MCP_AUTH_TOKEN),
    publicUrl: str(env.PUBLIC_URL),
    tokensFile: str(env.OUTMATE_TOKENS_FILE) ?? "data/tokens.json",
    tavilyKey: str(env.TAVILY_API_KEY),
    jinaKey: str(env.JINA_API_KEY),
    llmKey: str(env.LLM_API_KEY),
    moltsetsKey: str(env.MOLTSETS_API_KEY),
    parallelKey: str(env.PARALLEL_API_KEY),
    youKey: str(env.YOU_API_KEY),
    linkupKey: str(env.LINKUP_API_KEY),
    firecrawlKey: str(env.FIRECRAWL_API_KEY),
    serperKey: str(env.SERPER_API_KEY),
    apifyKey: str(env.APIFY_API_KEY),
    browserbaseKey: str(env.BROWSERBASE_API_KEY),
    apolloKey: str(env.APOLLO_API_KEY),
    hunterKey: str(env.HUNTER_API_KEY),
    nangoSecretKey: str(env.NANGO_SECRET_KEY),
    nangoHost: (str(env.NANGO_HOST) ?? "https://api.nango.dev").replace(/\/+$/, ""),
    sharedKeys: str(env.OUTMATE_SHARED_KEYS)?.toLowerCase() !== "false",
    llmBaseUrl: str(env.LLM_BASE_URL) ?? "https://api.deepseek.com/v1",
    llmModel: str(env.LLM_MODEL) ?? "",
    llmReasoningEffort: str(env.LLM_REASONING_EFFORT),
    signupEnabled: str(env.SIGNUP_ENABLED)?.toLowerCase() === "true",
    signupCode: str(env.SIGNUP_CODE),
    signupPerHour: Number.isInteger(Number(env.SIGNUP_PER_HOUR)) && Number(env.SIGNUP_PER_HOUR) > 0 ? Number(env.SIGNUP_PER_HOUR) : 20,
    ...LIMITS,
  };
}

export function llmConfigured(config: Config): boolean {
  return Boolean(config.llmKey && config.llmModel);
}

/** Which providers have a key. Booleans only, never the keys. */
export function providerStatus(config: Config): Record<string, boolean> {
  return {
    tavily: Boolean(config.tavilyKey),
    jina: Boolean(config.jinaKey),
    moltsets: Boolean(config.moltsetsKey),
    parallel: Boolean(config.parallelKey),
    you: Boolean(config.youKey),
    linkup: Boolean(config.linkupKey),
    firecrawl: Boolean(config.firecrawlKey),
    serper: Boolean(config.serperKey),
    apify: Boolean(config.apifyKey),
    browserbase: Boolean(config.browserbaseKey),
    apollo: Boolean(config.apolloKey),
    hunter: Boolean(config.hunterKey),
    llm: llmConfigured(config),
    nango: Boolean(config.nangoSecretKey),
  };
}

/** Values that must never appear in logs or responses. */
export function secretsOf(config: Config): string[] {
  return [
    config.tavilyKey,
    config.jinaKey,
    config.llmKey,
    config.moltsetsKey,
    config.parallelKey,
    config.youKey,
    config.linkupKey,
    config.firecrawlKey,
    config.serperKey,
    config.apifyKey,
    config.browserbaseKey,
    config.apolloKey,
    config.hunterKey,
    config.mcpAuthToken,
    config.nangoSecretKey,
  ].filter((s): s is string => Boolean(s));
}
