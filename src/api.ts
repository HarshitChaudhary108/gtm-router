import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { llmConfigured, secretsOf, type Config } from "./config.js";
import { executeAction, type ActionResult, type EngineDeps } from "./engine.js";
import { AppError, httpStatusFor, redactSecrets, toAppError, type ErrorCode } from "./errors.js";
import type { LlmClient } from "./llm.js";
import { listActions } from "./registry.js";
import { route } from "./router.js";
import type {
  CompaniesData,
  ExecutionStep,
  NormalizedResponse,
  PageData,
  PeopleData,
  SearchData,
} from "./types.js";
import { isRecord, newRequestId } from "./util.js";

const MAX_BODY_BYTES = 64 * 1024;

export interface AppContext extends EngineDeps {
  config: Config;
  llm?: LlmClient;
}

let indexHtmlPromise: Promise<string | null> | null = null;

function indexHtml(): Promise<string | null> {
  indexHtmlPromise ??= readFile(new URL("./public/index.html", import.meta.url), "utf8").catch(() => null);
  return indexHtmlPromise;
}

function sendJson(res: ServerResponse, status: number, body: unknown, secrets: string[]): void {
  const payload = redactSecrets(JSON.stringify(body), secrets);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function errorEnvelope(
  requestId: string,
  error: AppError,
  execution: ExecutionStep[],
  durationMs: number,
  message = error.message,
): NormalizedResponse {
  return {
    request_id: requestId,
    status: "error",
    answer: null,
    data: { results: [], page: null, companies: [], people: [] },
    execution,
    error: { code: error.code, message, retryable: error.retryable },
    meta: { duration_ms: durationMs, tools_used: execution.length },
  };
}

function searchEnvelope(requestId: string, result: ActionResult, durationMs: number): NormalizedResponse {
  if (result.ok && isRecord(result.data) && Array.isArray(result.data.results)) {
    const data = result.data as unknown as SearchData;
    return {
      request_id: requestId,
      status: "success",
      answer:
        data.results.length > 0
          ? `Found ${data.results.length} result(s) for "${data.query}".`
          : `No search results found for "${data.query}".`,
      data: { results: data.results, page: null, companies: [], people: [] },
      execution: [result.record],
      meta: { duration_ms: durationMs, tools_used: 1 },
    };
  }
  return errorEnvelope(requestId, result.error ?? new AppError("E_PROVIDER", "Search failed"), [result.record], durationMs);
}

function readEnvelope(requestId: string, result: ActionResult, durationMs: number): NormalizedResponse {
  if (result.ok && isRecord(result.data) && typeof result.data.content === "string") {
    const page = result.data as unknown as PageData;
    return {
      request_id: requestId,
      status: "success",
      answer: `Read ${page.title ? `"${page.title}"` : page.url} (${page.content_length} characters).`,
      data: { results: [], page, companies: [], people: [] },
      execution: [result.record],
      meta: { duration_ms: durationMs, tools_used: 1 },
    };
  }
  return errorEnvelope(requestId, result.error ?? new AppError("E_PROVIDER", "Read failed"), [result.record], durationMs);
}

function companiesEnvelope(requestId: string, result: ActionResult, durationMs: number): NormalizedResponse {
  if (result.ok && isRecord(result.data) && Array.isArray(result.data.results)) {
    const data = result.data as unknown as CompaniesData;
    return {
      request_id: requestId,
      status: "success",
      answer: `Found ${data.results.length} of ${data.total} matching compan${data.total === 1 ? "y" : "ies"}.`,
      data: { results: [], page: null, companies: data.results, people: [] },
      execution: [result.record],
      meta: { duration_ms: durationMs, tools_used: 1 },
    };
  }
  return errorEnvelope(requestId, result.error ?? new AppError("E_PROVIDER", "Company search failed"), [result.record], durationMs);
}

function peopleEnvelope(requestId: string, result: ActionResult, durationMs: number): NormalizedResponse {
  if (result.ok && isRecord(result.data) && Array.isArray(result.data.results)) {
    const data = result.data as unknown as PeopleData;
    return {
      request_id: requestId,
      status: "success",
      answer: `Found ${data.results.length} of ${data.total} matching ${data.total === 1 ? "person" : "people"}.`,
      data: { results: [], page: null, companies: [], people: data.results },
      execution: [result.record],
      meta: { duration_ms: durationMs, tools_used: 1 },
    };
  }
  return errorEnvelope(requestId, result.error ?? new AppError("E_PROVIDER", "People search failed"), [result.record], durationMs);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new AppError("E_BODY_TOO_LARGE", "Request body must be 64 KB or smaller");
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("E_VALIDATION", "Request body must be valid JSON");
  }
}

function requirePost(req: IncomingMessage, method: string): void {
  if (req.method !== method) throw new AppError("E_METHOD", `Use ${method} for this endpoint`);
}

/** Resolve the provider deps once, reusing injected fetch/dns so tests can mock them. */
export function buildEngineDeps(ctx: AppContext): EngineDeps {
  return {
    tavilyKey: ctx.config.tavilyKey,
    jinaKey: ctx.config.jinaKey,
    moltsetsKey: ctx.config.moltsetsKey,
    parallelKey: ctx.config.parallelKey,
    youKey: ctx.config.youKey,
    linkupKey: ctx.config.linkupKey,
    firecrawlKey: ctx.config.firecrawlKey,
    serperKey: ctx.config.serperKey,
    apifyKey: ctx.config.apifyKey,
    browserbaseKey: ctx.config.browserbaseKey,
    apolloKey: ctx.config.apolloKey,
    hunterKey: ctx.config.hunterKey,
    fetchImpl: ctx.fetchImpl,
    lookup: ctx.lookup,
    retryDelayMs: ctx.retryDelayMs,
    maxResultChars: ctx.maxResultChars,
    maxPageChars: ctx.maxPageChars,
    maxMoltResults: ctx.config.maxMoltResults,
    searchTimeoutMs: ctx.searchTimeoutMs,
    readTimeoutMs: ctx.readTimeoutMs,
    moltsetsTimeoutMs: ctx.config.moltsetsTimeoutMs,
    apifyTimeoutMs: ctx.config.apifyTimeoutMs,
  };
}

/** Build the HTTP request handler. External calls are injected so tests can mock them. */
export function createHandler(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const secrets = secretsOf(ctx.config);
  const engineDeps = buildEngineDeps(ctx);

  return async (req, res) => {
    const requestId = newRequestId();
    const started = Date.now();
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    res.setHeader("X-Request-Id", requestId);

    try {
      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        const html = await indexHtml();
        if (html === null) throw new AppError("E_NOT_FOUND", "Demo UI is not available");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(html);
        return;
      }

      if (path === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (path === "/api/health") {
        requirePost(req, "GET");
        sendJson(
          res,
          200,
          {
            status: "ok",
            service: "gtm-router",
            version: "0.1.0",
            uptime_s: Math.round(process.uptime()),
            config: {
              tavily: Boolean(ctx.config.tavilyKey),
              jina: Boolean(ctx.config.jinaKey),
              moltsets: Boolean(ctx.config.moltsetsKey),
              parallel: Boolean(ctx.config.parallelKey),
              you: Boolean(ctx.config.youKey),
              linkup: Boolean(ctx.config.linkupKey),
              firecrawl: Boolean(ctx.config.firecrawlKey),
              serper: Boolean(ctx.config.serperKey),
              apify: Boolean(ctx.config.apifyKey),
              browserbase: Boolean(ctx.config.browserbaseKey),
              apollo: Boolean(ctx.config.apolloKey),
              hunter: Boolean(ctx.config.hunterKey),
              llm: llmConfigured(ctx.config),
              llm_model: ctx.config.llmModel || null,
            },
          },
          secrets,
        );
        return;
      }

      if (path === "/api/v1/tools") {
        requirePost(req, "GET");
        sendJson(res, 200, { actions: listActions() }, secrets);
        return;
      }

      if (path === "/api/v1/actions/search") {
        requirePost(req, "POST");
        const body = await readBody(req);
        const result = await executeAction("web.search", body, engineDeps);
        const envelope = searchEnvelope(requestId, result, Date.now() - started);
        const status = result.ok ? 200 : (result.error?.status ?? 502);
        sendJson(res, status, envelope, secrets);
        return;
      }

      if (path === "/api/v1/actions/read-url") {
        requirePost(req, "POST");
        const body = await readBody(req);
        const result = await executeAction("web.read_url", body, engineDeps);
        const envelope = readEnvelope(requestId, result, Date.now() - started);
        const status = result.ok ? 200 : (result.error?.status ?? 502);
        sendJson(res, status, envelope, secrets);
        return;
      }

      if (path === "/api/v1/actions/search-companies" || path === "/api/v1/actions/search-people") {
        requirePost(req, "POST");
        const body = await readBody(req);
        const isCompanies = path.endsWith("search-companies");
        const result = await executeAction(isCompanies ? "gtm.search_companies" : "gtm.search_people", body, engineDeps);
        const envelope = isCompanies
          ? companiesEnvelope(requestId, result, Date.now() - started)
          : peopleEnvelope(requestId, result, Date.now() - started);
        const status = result.ok ? 200 : (result.error?.status ?? 502);
        sendJson(res, status, envelope, secrets);
        return;
      }

      if (path === "/api/v1/route") {
        requirePost(req, "POST");
        const body = await readBody(req);
        const input = isRecord(body) ? body.input : undefined;
        const result = await route(input, {
          config: ctx.config,
          requestId,
          llm: ctx.llm,
          execute: (name, actionInput) => executeAction(name, actionInput, engineDeps),
        });
        const status =
          result.status === "error" && result.error ? httpStatusFor(result.error.code as ErrorCode) : 200;
        sendJson(res, status, result, secrets);
        return;
      }

      if (path.startsWith("/api/")) throw new AppError("E_NOT_FOUND", "Unknown API route");
      throw new AppError("E_NOT_FOUND", "Not found");
    } catch (err) {
      const appError = toAppError(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      const envelope = errorEnvelope(
        requestId,
        appError,
        appError.execution ?? [],
        Date.now() - started,
        redactSecrets(appError.message, secrets),
      );
      sendJson(res, appError.status, envelope, secrets);
    }
  };
}
