import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export interface Config {
  port: number;
  mcpPort: number;
  mcpHost: string;
  mcpAuthToken?: string;
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
  llmBaseUrl: string;
  llmModel: string;
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
    llmBaseUrl: str(env.LLM_BASE_URL) ?? "https://api.deepseek.com/v1",
    llmModel: str(env.LLM_MODEL) ?? "",
    ...LIMITS,
  };
}

export function llmConfigured(config: Config): boolean {
  return Boolean(config.llmKey && config.llmModel);
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
  ].filter((s): s is string => Boolean(s));
}
