import assert from "node:assert/strict";
import test from "node:test";
import { executeAction } from "../src/engine.js";
import { redactSecrets } from "../src/errors.js";
import type { FetchLike } from "../src/http.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("dispatch routes web.search to Tavily", async () => {
  let url = "";
  const fetchImpl: FetchLike = async (requested) => {
    url = requested;
    return jsonResponse({ results: [{ title: "Acme", url: "https://acme.com", content: "text" }] });
  };

  const result = await executeAction("web.search", { query: "acme" }, { tavilyKey: "k", fetchImpl, retryDelayMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.record.action, "web.search");
  assert.equal(result.record.provider, "tavily");
  assert.equal(result.record.status, "success");
  assert.equal(url, "https://api.tavily.com/search");
});

test("dispatch routes web.read_url to Jina", async () => {
  let url = "";
  const fetchImpl: FetchLike = async (requested) => {
    url = requested;
    return jsonResponse({ code: 200, data: { content: "page body", title: "Page" } });
  };

  const result = await executeAction(
    "web.read_url",
    { url: "https://example.com/" },
    { jinaKey: "k", fetchImpl, lookup: publicLookup, retryDelayMs: 1 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.record.provider, "jina");
  assert.equal(url, "https://r.jina.ai/https://example.com/");
});

test("validation failures are recorded without any HTTP call", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return jsonResponse({});
  };

  const result = await executeAction("web.search", { query: "" }, { tavilyKey: "k", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "E_VALIDATION");
  assert.equal(result.record.status, "error");
  assert.equal(result.record.error_code, "E_VALIDATION");
  assert.equal(called, false);
});

test("missing Tavily credentials surface as a configuration error", async () => {
  const result = await executeAction("web.search", { query: "acme" }, {});
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "E_CONFIG");
});

test("provider failures are recorded in the execution trace", async () => {
  const fetchImpl: FetchLike = async () => jsonResponse({ detail: "nope" }, 403);
  const result = await executeAction("web.search", { query: "acme" }, { tavilyKey: "k", fetchImpl, retryDelayMs: 1 });
  assert.equal(result.ok, false);
  assert.equal(result.record.status, "error");
  assert.equal(result.record.error_code, "E_PROVIDER_AUTH");
});

test("redactSecrets removes credential values from text", () => {
  const text = "upstream said: tv-123456789 and jina_abcdefgh are invalid";
  const redacted = redactSecrets(text, ["tv-123456789", "jina_abcdefgh"]);
  assert.equal(redacted, "upstream said: [REDACTED] and [REDACTED] are invalid");
  assert.ok(!redacted.includes("tv-123456789"));
});
