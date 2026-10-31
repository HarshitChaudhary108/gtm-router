import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApify, searchApify } from "../src/adapters/apify.js";
import { normalizeApolloCompanies, normalizeApolloPeople, searchApolloPeople } from "../src/adapters/apollo.js";
import { normalizeBrowserbase, readBrowserbase } from "../src/adapters/browserbase.js";
import { normalizeFirecrawlPage, normalizeFirecrawlSearch, searchFirecrawl } from "../src/adapters/firecrawl.js";
import { normalizeHunterDomain, normalizeHunterFinder, normalizeHunterVerifier, searchHunterDomain } from "../src/adapters/hunter.js";
import { normalizeLinkup, searchLinkup } from "../src/adapters/linkup.js";
import { normalizeParallel, searchParallel } from "../src/adapters/parallel.js";
import { normalizeSerper, searchSerper } from "../src/adapters/serper.js";
import { normalizeYou, searchYou } from "../src/adapters/you.js";
import { AppError } from "../src/errors.js";
import type { FetchLike } from "../src/http.js";
import type { SearchParams } from "../src/registry.js";

const params: SearchParams = { query: "acme pricing", max_results: 2, search_depth: "basic" };

interface Captured {
  url: string;
  init?: RequestInit;
}

function capture(body: unknown, status = 200): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  };
}

function bodyOf(call: Captured): Record<string, unknown> {
  return JSON.parse(String(call.init?.body)) as Record<string, unknown>;
}

function headersOf(call: Captured): Record<string, string> {
  return (call.init?.headers ?? {}) as Record<string, string>;
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return;
  }
  assert.fail(`expected ${code}`);
}

test("parallel: request shape, auth header and normalization", async () => {
  const { fetchImpl, calls } = capture({
    search_queries: ["acme pricing"],
    results: [{ title: "Acme", url: "https://acme.com/pricing", excerpts: [{ text: "Plans from $10" }] }],
  });
  const data = await searchParallel(params, { apiKey: "pk", fetchImpl });
  assert.equal(calls[0]?.url, "https://api.parallel.ai/v1/search");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(headersOf(calls[0]!)["x-api-key"], "pk");
  assert.equal(bodyOf(calls[0]!).mode, "fast");
  assert.equal(data.results[0]?.url, "https://acme.com/pricing");
  assert.match(data.results[0]?.content ?? "", /Plans from \$10/);
});

test("parallel: missing key and auth failure map to router errors", async () => {
  await expectCode(searchParallel(params, {}), "E_CONFIG");
  const { fetchImpl } = capture({ error: "unauthorized" }, 401);
  await expectCode(searchParallel(params, { apiKey: "pk", fetchImpl }), "E_PROVIDER_AUTH");
});

test("parallel normalization drops private or malformed URLs", () => {
  const data = normalizeParallel(
    {
      results: [
        { title: "Bad", url: "http://127.0.0.1/secret", excerpts: [{ text: "x" }] },
        { title: "Good", url: "https://ok.example.com/", excerpts: [{ text: "y" }] },
      ],
    },
    "q",
  );
  assert.deepEqual(data.results.map((result) => result.url), ["https://ok.example.com/"]);
});

test("you.com: request shape and web results", async () => {
  const { fetchImpl, calls } = capture({
    results: { web: [{ title: "Acme", url: "https://acme.com", snippets: ["Snippet one", "Snippet two"] }] },
  });
  const data = await searchYou(params, { apiKey: "yk", fetchImpl });
  assert.equal(calls[0]?.url, "https://ydc-index.io/v1/search");
  assert.equal(headersOf(calls[0]!)["X-API-Key"], "yk");
  assert.equal(bodyOf(calls[0]!).count, 2);
  assert.match(data.results[0]?.content ?? "", /Snippet one/);
});

test("you.com: rejects a response without results.web", () => {
  assert.throws(() => normalizeYou({ results: {} }, "q"), /results\.web/);
});

test("linkup: bearer auth, depth mapping and results", async () => {
  const { fetchImpl, calls } = capture({
    results: [{ name: "Acme", url: "https://acme.com", content: "Plans from $10" }],
  });
  const data = await searchLinkup({ ...params, search_depth: "advanced" }, { apiKey: "lk", fetchImpl });
  assert.equal(calls[0]?.url, "https://api.linkup.so/v1/search");
  assert.equal(headersOf(calls[0]!)["x-api-key"], "lk");
  assert.equal(bodyOf(calls[0]!).depth, "standard");
  assert.equal(bodyOf(calls[0]!).outputType, "searchResults");
  assert.equal(data.results[0]?.title, "Acme");
});

test("firecrawl: search request and scrape normalization", async () => {
  const search = capture({
    success: true,
    data: { web: [{ title: "Acme", url: "https://acme.com", markdown: "# Acme\nPlans" }] },
  });
  const data = await searchFirecrawl(params, { apiKey: "fk", fetchImpl: search.fetchImpl });
  assert.equal(search.calls[0]?.url, "https://api.firecrawl.dev/v2/search");
  assert.equal(headersOf(search.calls[0]!).Authorization, "Bearer fk");
  assert.match(data.results[0]?.content ?? "", /Plans/);

  const page = normalizeFirecrawlPage(
    {
      success: true,
      data: { markdown: "# Hello", metadata: { title: "Hello", url: "https://example.com/final" } },
    },
    "https://example.com",
  );
  assert.equal(page.title, "Hello");
  assert.equal(page.final_url, "https://example.com/final");
  assert.equal(page.content, "# Hello");
});

test("serper: organic results map link to url", async () => {
  const { fetchImpl, calls } = capture({
    organic: [{ title: "Acme", link: "https://acme.com", snippet: "Plans from $10" }],
  });
  const data = await searchSerper(params, { apiKey: "sk", fetchImpl });
  assert.equal(calls[0]?.url, "https://google.serper.dev/search");
  assert.equal(headersOf(calls[0]!)["X-API-KEY"], "sk");
  assert.equal(bodyOf(calls[0]!).num, 2);
  assert.equal(data.results[0]?.url, "https://acme.com/");
});

test("apify: uses only the allowlisted actor and flattens dataset items", async () => {
  const { fetchImpl, calls } = capture([
    { organicResults: [{ title: "Acme", url: "https://acme.com", description: "Official site" }] },
  ]);
  const data = await searchApify(params, { apiKey: "ak", fetchImpl });
  assert.equal(
    calls[0]?.url,
    "https://api.apify.com/v2/acts/apify~google-search-scraper/run-sync-get-dataset-items",
  );
  assert.equal(data.results[0]?.url, "https://acme.com/");
  assert.equal(normalizeApify([], "q").results.length, 0);

  const quota = capture({ error: "no credits" }, 402);
  await expectCode(searchApify(params, { apiKey: "ak", fetchImpl: quota.fetchImpl }), "E_QUOTA");
});

test("browserbase: SSRF gate runs before the provider call", async () => {
  const { fetchImpl, calls } = capture({ content: "should not be used" });
  await expectCode(
    readBrowserbase(
      { url: "https://internal.example.com/" },
      { apiKey: "bk", fetchImpl, lookup: async () => [{ address: "10.0.0.5" }] },
    ),
    "E_BAD_URL",
  );
  assert.equal(calls.length, 0);

  const page = normalizeBrowserbase(
    { content: "# Page", metadata: { title: "T", url: "https://example.com/final" } },
    "https://example.com",
  );
  assert.equal(page.title, "T");
  assert.equal(page.final_url, "https://example.com/final");
});

test("apollo: people search never returns an email address", () => {
  const data = normalizeApolloPeople({
    people: [
      {
        name: "Jane Doe",
        title: "VP Engineering",
        has_email: true,
        email: "leaked@acme.com",
        organization: { name: "Acme", primary_domain: "acme.com" },
      },
    ],
    pagination: { total_entries: 42 },
  });
  assert.equal(data.total, 42);
  assert.equal(data.results[0]?.business_email, null);
  assert.equal(data.results[0]?.business_email_status, "available_via_enrichment");
});

test("apollo: company normalization and 403 mapping", async () => {
  const normalized = normalizeApolloCompanies({
    organizations: [{ name: "Acme", primary_domain: "acme.com", estimated_num_employees: 120 }],
  });
  assert.equal(normalized.results[0]?.employee_count, "120");

  const { fetchImpl, calls } = capture({ error: "forbidden" }, 403);
  await expectCode(searchApolloPeople({ company_domain: "acme.com", limit: 1, page: 1 }, { apiKey: "ap", fetchImpl }), "E_PROVIDER_AUTH");
  assert.equal(calls[0]?.url, "https://api.apollo.io/api/v1/mixed_people/search");
});

test("hunter: domain search exposes verification status and confidence", async () => {
  const data = normalizeHunterDomain({
    data: {
      domain: "acme.com",
      organization: "Acme",
      emails: [
        {
          value: "jane@acme.com",
          first_name: "Jane",
          last_name: "Doe",
          position: "VP Engineering",
          confidence: 95,
          verification: { status: "valid" },
        },
      ],
    },
    meta: { results: 7 },
  });
  assert.equal(data.total, 7);
  assert.equal(data.results[0]?.business_email, "jane@acme.com");
  assert.equal(data.results[0]?.business_email_status, "valid");
  assert.equal(data.results[0]?.business_email_score, 95);
  assert.equal(data.results[0]?.company_domain, "acme.com");
});

test("hunter: finder and verifier normalization", () => {
  const found = normalizeHunterFinder({ data: { email: "jane@acme.com", score: 88, first_name: "Jane", last_name: "Doe" } });
  assert.equal(found.total, 1);
  assert.equal(found.results[0]?.business_email_score, 88);

  const empty = normalizeHunterFinder({ data: { email: null } });
  assert.deepEqual(empty, { results: [], total: 0 });

  const verified = normalizeHunterVerifier({ data: { email: "jane@acme.com", status: "valid", score: 100 } });
  assert.equal(verified.results[0]?.business_email_status, "valid");
});

test("hunter: sends the api key as a header, never in the URL", async () => {
  const { fetchImpl, calls } = capture({ data: { emails: [] }, meta: { results: 0 } });
  await searchHunterDomain({ domain: "acme.com", limit: 2 }, { apiKey: "hk", fetchImpl });
  assert.ok(calls[0]?.url.startsWith("https://api.hunter.io/v2/domain-search?"));
  assert.ok(!calls[0]?.url.includes("hk"));
  assert.equal(headersOf(calls[0]!)["X-API-KEY"], "hk");
});
