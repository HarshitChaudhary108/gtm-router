import assert from "node:assert/strict";
import test from "node:test";
import { normalizeJina } from "../src/adapters/jina.js";
import { normalizeTavily } from "../src/adapters/tavily.js";
import { AppError } from "../src/errors.js";

test("normalizeTavily maps title, url, snippet, content and score", () => {
  const data = normalizeTavily(
    {
      query: "acme pricing",
      results: [
        { title: "Acme Pricing", url: "https://acme.com/pricing", content: "Plans start at $10.", score: 0.92 },
        { title: null, url: "https://acme.com/about" },
      ],
    },
    "fallback",
  );

  assert.equal(data.query, "acme pricing");
  assert.equal(data.results.length, 2);
  assert.deepEqual(data.results[0], {
    title: "Acme Pricing",
    url: "https://acme.com/pricing",
    snippet: "Plans start at $10.",
    content: "Plans start at $10.",
    content_truncated: false,
    score: 0.92,
  });
  assert.equal(data.results[1].title, null);
  assert.equal(data.results[1].snippet, null);
  assert.equal(data.results[1].content, null);
  assert.equal(data.results[1].score, null);
});

test("normalizeTavily drops malformed and non-public results", () => {
  const data = normalizeTavily(
    {
      results: [
        { url: "javascript:alert(1)", title: "bad" },
        { url: "http://127.0.0.1/secret", title: "local" },
        { title: "no url" },
        { url: "https://ok.example.com", title: "ok" },
      ],
    },
    "q",
  );
  assert.deepEqual(data.results.map((r) => r.url), ["https://ok.example.com/"]);
  assert.equal(data.query, "q");
});

test("normalizeTavily truncates long content and snippets", () => {
  const content = "a".repeat(5000);
  const [result] = normalizeTavily({ results: [{ url: "https://acme.com", title: "t", content }] }, "q").results;
  assert.equal(result.content?.length, 4000);
  assert.equal(result.content_truncated, true);
  assert.equal(result.snippet?.length, 301); // 300 chars plus an ellipsis
  assert.ok(result.snippet?.endsWith("…"));
});

test("normalizeTavily treats an empty result list as a valid search", () => {
  const data = normalizeTavily({ query: "nothing", results: [] }, "nothing");
  assert.deepEqual(data, { query: "nothing", results: [] });
});

test("normalizeTavily rejects a response without a results array", () => {
  assert.throws(
    () => normalizeTavily({ ok: true }, "q"),
    (err: unknown) => err instanceof AppError && err.code === "E_PROVIDER",
  );
});

test("normalizeJina maps its JSON envelope", () => {
  const page = normalizeJina(
    {
      code: 200,
      status: 20000,
      data: {
        title: "Example",
        description: "A description",
        url: "https://example.com/final",
        content: "# Heading\n\nBody text",
      },
    },
    "https://example.com/start",
  );

  assert.equal(page.url, "https://example.com/start");
  assert.equal(page.final_url, "https://example.com/final");
  assert.equal(page.title, "Example");
  assert.equal(page.description, "A description");
  assert.equal(page.content, "# Heading\n\nBody text");
  assert.equal(page.content_length, 20);
  assert.equal(page.truncated, false);
});

test("normalizeJina accepts plain-text fallback content", () => {
  const page = normalizeJina("plain markdown body", "https://example.com");
  assert.equal(page.content, "plain markdown body");
  assert.equal(page.title, null);
  assert.equal(page.final_url, "https://example.com");
});

test("normalizeJina bounds content size", () => {
  const page = normalizeJina({ data: { content: "x".repeat(50) } }, "https://example.com", 10);
  assert.equal(page.content.length, 10);
  assert.equal(page.content_length, 50);
  assert.equal(page.truncated, true);
});

test("normalizeJina ignores invalid final URLs and rejects empty content", () => {
  const page = normalizeJina({ data: { url: "ftp://example.com", content: "body" } }, "https://example.com");
  assert.equal(page.final_url, "https://example.com");

  assert.throws(
    () => normalizeJina({ code: 200, data: {} }, "https://example.com"),
    (err: unknown) => err instanceof AppError && err.code === "E_PROVIDER",
  );
  assert.throws(
    () => normalizeJina("   ", "https://example.com"),
    (err: unknown) => err instanceof AppError && err.code === "E_PROVIDER",
  );
});
