import assert from "node:assert/strict";
import test from "node:test";
import { readUrl } from "../src/adapters/jina.js";
import { searchWeb } from "../src/adapters/tavily.js";
import { AppError } from "../src/errors.js";
import type { FetchLike } from "../src/http.js";

const TAVILY_BODY = {
  query: "acme pricing",
  results: [{ title: "Acme Pricing", url: "https://acme.com/pricing", content: "Plans from $10", score: 0.9 }],
};

const publicLookup = async () => [{ address: "93.184.216.34" }];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function expectAppError(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

test("searchWeb calls Tavily with bearer auth and a bounded body", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    captured = { url, init };
    return jsonResponse(TAVILY_BODY);
  };

  const data = await searchWeb(
    { query: "acme pricing", max_results: 5, search_depth: "basic" },
    { apiKey: "tv-test-key", fetchImpl, retryDelayMs: 1 },
  );

  assert.equal(captured?.url, "https://api.tavily.com/search");
  assert.equal(captured?.init?.method, "POST");
  assert.equal((captured?.init?.headers as Record<string, string>).Authorization, "Bearer tv-test-key");
  const body = JSON.parse(String(captured?.init?.body));
  assert.deepEqual(body, {
    query: "acme pricing",
    max_results: 5,
    search_depth: "basic",
    include_answer: false,
    include_raw_content: false,
  });
  assert.equal(data.results[0].url, "https://acme.com/pricing");
});

test("searchWeb fails clearly when the Tavily key is missing", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return jsonResponse(TAVILY_BODY);
  };
  await expectAppError(() => searchWeb({ query: "x", max_results: 5, search_depth: "basic" }, { fetchImpl }), "E_CONFIG");
  assert.equal(called, false);
});

test("searchWeb maps 401 without retrying", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return jsonResponse({ detail: "unauthorized" }, 401);
  };
  await expectAppError(
    () => searchWeb({ query: "x", max_results: 5, search_depth: "basic" }, { apiKey: "k", fetchImpl, retryDelayMs: 1 }),
    "E_PROVIDER_AUTH",
  );
  assert.equal(calls, 1);
});

test("searchWeb retries a 429 once and then succeeds", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return calls === 1 ? jsonResponse({ detail: "slow down" }, 429) : jsonResponse(TAVILY_BODY);
  };
  const data = await searchWeb(
    { query: "x", max_results: 5, search_depth: "basic" },
    { apiKey: "k", fetchImpl, retryDelayMs: 1 },
  );
  assert.equal(calls, 2);
  assert.equal(data.results.length, 1);
});

test("searchWeb returns E_PROVIDER after exhausting 5xx retries", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return jsonResponse({ detail: "boom" }, 503);
  };
  await expectAppError(
    () => searchWeb({ query: "x", max_results: 5, search_depth: "basic" }, { apiKey: "k", fetchImpl, retryDelayMs: 1 }),
    "E_PROVIDER",
  );
  assert.equal(calls, 2);
});

test("searchWeb maps timeouts to E_TIMEOUT", async () => {
  const fetchImpl: FetchLike = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
    });

  await expectAppError(
    () =>
      searchWeb(
        { query: "x", max_results: 5, search_depth: "basic" },
        { apiKey: "k", fetchImpl, timeoutMs: 20, retryDelayMs: 1 },
      ),
    "E_TIMEOUT",
  );
});

test("searchWeb rejects a non-JSON upstream body", async () => {
  const fetchImpl: FetchLike = async () => new Response("<html>oops</html>", { status: 200 });
  await expectAppError(
    () => searchWeb({ query: "x", max_results: 5, search_depth: "basic" }, { apiKey: "k", fetchImpl, retryDelayMs: 1 }),
    "E_PROVIDER",
  );
});

test("readUrl calls Jina Reader with JSON markdown output and bearer auth", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    captured = { url, init };
    return jsonResponse({
      code: 200,
      status: 20000,
      data: { title: "Example", url: "https://example.com/", content: "# Example\n\nHello" },
    });
  };

  const page = await readUrl(
    { url: "https://example.com/" },
    { apiKey: "jina-test-key", fetchImpl, lookup: publicLookup, retryDelayMs: 1 },
  );

  assert.equal(captured?.url, "https://r.jina.ai/https://example.com/");
  const headers = captured?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer jina-test-key");
  assert.equal(headers.Accept, "application/json");
  assert.equal(headers["X-Return-Format"], "markdown");
  assert.equal(page.title, "Example");
  assert.equal(page.content, "# Example\n\nHello");
});

test("readUrl works without a Jina key (keyless free tier) and sends no auth header", async () => {
  let headers: Record<string, string> = {};
  const fetchImpl: FetchLike = async (_url, init) => {
    headers = init?.headers as Record<string, string>;
    return jsonResponse({ code: 200, data: { content: "body" } });
  };
  const page = await readUrl(
    { url: "https://example.com/" },
    { fetchImpl, lookup: publicLookup, retryDelayMs: 1 },
  );
  assert.equal(headers.Authorization, undefined);
  assert.equal(page.content, "body");
});

test("readUrl rejects hostnames that resolve to private addresses before calling Jina", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return jsonResponse({ data: { content: "secret" } });
  };
  await expectAppError(
    () =>
      readUrl(
        { url: "https://rebind.example.com/" },
        { fetchImpl, lookup: async () => [{ address: "127.0.0.1" }], retryDelayMs: 1 },
      ),
    "E_BAD_URL",
  );
  assert.equal(called, false);
});

test("readUrl maps 403 to a credential error", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ code: 403, message: "forbidden" }, 403);
  await expectAppError(
    () => readUrl({ url: "https://example.com/" }, { apiKey: "k", fetchImpl, lookup: publicLookup, retryDelayMs: 1 }),
    "E_PROVIDER_AUTH",
  );
});

test("readUrl handles a plain-text Jina response", async () => {
  const fetchImpl: FetchLike = async () =>
    new Response("plain markdown body", { status: 200, headers: { "content-type": "text/plain" } });
  const page = await readUrl(
    { url: "https://example.com/" },
    { fetchImpl, lookup: publicLookup, retryDelayMs: 1 },
  );
  assert.equal(page.content, "plain markdown body");
});

test("readUrl maps a Jina error envelope on a 200 response", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ code: 422, message: "unprocessable page" });
  await expectAppError(
    () => readUrl({ url: "https://example.com/" }, { fetchImpl, lookup: publicLookup, retryDelayMs: 1 }),
    "E_PROVIDER",
  );
});
