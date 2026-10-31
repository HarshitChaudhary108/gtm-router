import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, type FetchLike } from "../http.js";
import type { SearchParams } from "../registry.js";
import type { SearchData, SearchResult } from "../types.js";
import { assertPublicHttpUrl } from "../url-safety.js";
import { isRecord, truncate } from "../util.js";

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const SNIPPET_CHARS = 300;

export interface TavilyDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxResultChars?: number;
}

/** Map Tavily's native response into the router's search shape. Never invents fields. */
export function normalizeTavily(payload: unknown, fallbackQuery: string, maxResultChars: number = LIMITS.maxResultChars): SearchData {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    throw new AppError("E_PROVIDER", "Tavily response did not contain a results array");
  }

  const results: SearchResult[] = [];
  for (const item of payload.results.slice(0, LIMITS.maxResultsCap)) {
    if (!isRecord(item) || typeof item.url !== "string") continue;

    let url: string;
    try {
      url = assertPublicHttpUrl(item.url).href;
    } catch {
      continue; // Drop non-public or malformed URLs instead of surfacing them.
    }

    const content = typeof item.content === "string" && item.content.trim() ? item.content.trim() : null;
    const snippet = content ? truncate(content, SNIPPET_CHARS) : null;
    const clipped = content ? truncate(content, maxResultChars) : null;

    results.push({
      title: typeof item.title === "string" && item.title.trim() ? item.title : null,
      url,
      snippet: snippet ? (snippet.truncated ? `${snippet.text}…` : snippet.text) : null,
      content: clipped?.text ?? null,
      content_truncated: clipped?.truncated ?? false,
      score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : null,
    });
  }

  const query = typeof payload.query === "string" && payload.query.trim() ? payload.query : fallbackQuery;
  return { query, results };
}

export async function searchWeb(params: SearchParams, deps: TavilyDeps): Promise<SearchData> {
  if (!deps.apiKey) {
    throw new AppError("E_CONFIG", "TAVILY_API_KEY is not configured; web.search is unavailable");
  }

  const res = await fetchWithRetry(
    TAVILY_SEARCH_URL,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${deps.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: params.query,
        max_results: Math.min(params.max_results, LIMITS.maxResultsCap),
        search_depth: params.search_depth,
        include_answer: false,
        include_raw_content: false,
      }),
    },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.searchTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  assertUpstreamOk(res, "Tavily");
  const payload = await readJsonBody(res, "Tavily");
  return normalizeTavily(payload, params.query, deps.maxResultChars);
}
