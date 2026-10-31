import { LIMITS } from "../config.js";
import { AppError } from "../errors.js";
import { assertUpstreamOk, fetchWithRetry, readJsonBody, readTextCapped, type FetchLike } from "../http.js";
import type { ReadParams } from "../registry.js";
import type { PageData } from "../types.js";
import { assertResolvablePublicUrl, type LookupFn } from "../url-safety.js";
import { isRecord, truncate } from "../util.js";

const JINA_READER_BASE = "https://r.jina.ai/";

export interface JinaDeps {
  apiKey?: string;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxChars?: number;
}

function httpUrlOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Map Jina Reader's JSON (or text) response into the router's page shape. */
export function normalizeJina(payload: unknown, requestedUrl: string, maxChars: number = LIMITS.maxPageChars): PageData {
  let data: Record<string, unknown> | null = null;
  let textFallback: string | null = null;

  if (typeof payload === "string") {
    textFallback = payload;
  } else if (isRecord(payload)) {
    if (isRecord(payload.data)) data = payload.data;
    else if (typeof payload.content === "string") data = payload;
  }

  const rawContent = typeof data?.content === "string" ? data.content : textFallback;
  if (rawContent === null || !rawContent.trim()) {
    throw new AppError("E_PROVIDER", "Jina Reader response did not contain readable content");
  }

  const clipped = truncate(rawContent, maxChars);
  return {
    url: requestedUrl,
    final_url: httpUrlOrNull(data?.url) ?? requestedUrl,
    title: typeof data?.title === "string" && data.title.trim() ? data.title : null,
    description: typeof data?.description === "string" && data.description.trim() ? data.description : null,
    content: clipped.text,
    content_length: rawContent.length,
    truncated: clipped.truncated,
  };
}

function jinaPayloadError(payload: unknown): AppError {
  const code = isRecord(payload) && typeof payload.code === "number" ? payload.code : 0;
  const message = isRecord(payload) && typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim().slice(0, 300)
    : `Jina Reader returned an error${code ? ` (code ${code})` : ""}`;

  if (code === 401 || code === 403) {
    return new AppError("E_PROVIDER_AUTH", `Jina Reader rejected the API credentials (HTTP ${code})`);
  }
  if (code === 429) return new AppError("E_RATE_LIMIT", "Jina Reader rate limit reached", { retryable: true });
  return new AppError("E_PROVIDER", message);
}

export async function readUrl(params: ReadParams, deps: JinaDeps): Promise<PageData> {
  const target = await assertResolvablePublicUrl(params.url, deps.lookup);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-Return-Format": "markdown",
  };
  if (deps.apiKey) headers.Authorization = `Bearer ${deps.apiKey}`;

  const res = await fetchWithRetry(
    `${JINA_READER_BASE}${target.href}`,
    { method: "GET", headers },
    {
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs ?? LIMITS.readTimeoutMs,
      maxRetries: 1,
      retryDelayMs: deps.retryDelayMs,
    },
  );

  assertUpstreamOk(res, "Jina Reader");

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    const payload = await readJsonBody(res, "Jina Reader");
    if (!isRecord(payload) || !isRecord(payload.data)) {
      if (isRecord(payload) && typeof payload.content === "string") {
        return normalizeJina(payload, target.href, deps.maxChars);
      }
      throw jinaPayloadError(payload);
    }
    return normalizeJina(payload, target.href, deps.maxChars);
  }

  const { text } = await readTextCapped(res);
  return normalizeJina(text, target.href, deps.maxChars);
}
