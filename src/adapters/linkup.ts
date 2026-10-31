import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { isRecord } from "../util.js";
import { toSearchResult } from "./common.js";

const LINKUP_SEARCH_URL = "https://api.linkup.so/v1/search";

export interface LinkupDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

/** Map Linkup's search response into the router's search shape. Never invents fields. */
export function normalizeLinkup(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new AppError("E_PROVIDER", "Linkup response did not contain a results array");
  }

  const results: SearchResult[] = [];
  for (const item of payload.results.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item)) continue;
    const result = toSearchResult({ title: item.name ?? item.title, url: item.url, content: item.content }, maxResultChars);
    if (result) results.push(result);
  }

  return { query: fallbackQuery, results };
}

export async function searchLinkup(params: SearchParams, deps: LinkupDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "LINKUP_API_KEY is not configured; Linkup search is unavailable");
  }

  const res = await fetchWithRetry(
    LINKUP_SEARCH_URL,
    {
      method: "POST",
      headers: {
        "x-api-key": deps.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        q: params.query,
        depth: params.search_depth === "advanced" ? "standard" : "fast",
        outputType: "searchResults",
        maxResults: Math.min(params.max_results, LIMITS.maxResultsCap),
      }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  if (res.status === 402) throw new AppError("E_QUOTA", "Linkup quota exhausted (HTTP 402)");
  assertUpstreamOk(res, "Linkup");
  return normalizeLinkup(await readJsonBody(res, "Linkup"), params.query, deps.maxResultChars);
}
