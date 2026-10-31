import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { isRecord } from "../util.js";
import { toSearchResult } from "./common.js";

const SERPER_SEARCH_URL = "https://google.serper.dev/search";

export interface SerperDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

/** Map Serper's Google results into the router's search shape. Never invents fields. */
export function normalizeSerper(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  if (!isRecord(payload) || !Array.isArray(payload.organic)) {
    throw new AppError("E_PROVIDER", "Serper response did not contain an organic array");
  }

  const results: SearchResult[] = [];
  for (const item of payload.organic.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item)) continue;
    const result = toSearchResult({ title: item.title, url: item.link, content: item.snippet }, maxResultChars);
    if (result) results.push(result);
  }

  return { query: fallbackQuery, results };
}

export async function searchSerper(params: SearchParams, deps: SerperDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "SERPER_API_KEY is not configured; Serper search is unavailable");
  }

  const res = await fetchWithRetry(
    SERPER_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "X-API-KEY": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ q: params.query, num: Math.min(params.max_results, LIMITS.maxResultsCap) }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  assertUpstreamOk(res, "Serper");
  return normalizeSerper(await readJsonBody(res, "Serper"), params.query, deps.maxResultChars);
}
