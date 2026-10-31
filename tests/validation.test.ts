import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../src/errors.js";
import { ACTIONS } from "../src/registry.js";
import { assertPublicHttpUrl, assertResolvablePublicUrl } from "../src/url-safety.js";

function expectAppError(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail("expected the call to throw");
}

test("web.search applies defaults and trims the query", () => {
  assert.deepEqual(ACTIONS["web.search"].parse({ query: "  acme pricing  " }), {
    query: "acme pricing",
    max_results: 5,
    search_depth: "basic",
    provider: "tavily",
  });
});

test("web.search accepts explicit bounds", () => {
  assert.deepEqual(ACTIONS["web.search"].parse({ query: "x", max_results: 10, search_depth: "advanced" }), {
    query: "x",
    max_results: 10,
    search_depth: "advanced",
    provider: "tavily",
  });
});

test("web.search accepts every search provider and rejects unknown ones", () => {
  for (const provider of ["tavily", "parallel", "you", "linkup", "firecrawl", "serper", "apify"]) {
    assert.equal(ACTIONS["web.search"].parse({ query: "x", provider }).provider, provider);
  }
  expectAppError(() => ACTIONS["web.search"].parse({ query: "x", provider: "bing" }), "E_VALIDATION");
});

test("web.read_url accepts read providers and defaults to jina", () => {
  assert.equal(ACTIONS["web.read_url"].parse({ url: "https://example.com" }).provider, "jina");
  for (const provider of ["jina", "firecrawl", "browserbase"]) {
    assert.equal(ACTIONS["web.read_url"].parse({ url: "https://example.com", provider }).provider, provider);
  }
  expectAppError(() => ACTIONS["web.read_url"].parse({ url: "https://example.com", provider: "curl" }), "E_VALIDATION");
});

test("apollo and hunter actions validate their filters", () => {
  expectAppError(() => ACTIONS["gtm.apollo_companies"].parse({}), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.apollo_people"].parse({}), "E_VALIDATION");
  assert.equal(ACTIONS["gtm.apollo_people"].parse({ company_domain: "vercel.com", limit: 5 }).limit, 5);

  assert.equal(ACTIONS["gtm.hunter_domain"].parse({ domain: "https://www.vercel.com/pricing" }).domain, "www.vercel.com");
  expectAppError(() => ACTIONS["gtm.hunter_domain"].parse({}), "E_VALIDATION");

  assert.equal(ACTIONS["gtm.hunter_email"].parse({ email: "a@b.com" }).email, "a@b.com");
  assert.deepEqual(ACTIONS["gtm.hunter_email"].parse({ domain: "vercel.com", first_name: "A", last_name: "B" }), {
    domain: "vercel.com",
    first_name: "A",
    last_name: "B",
    linkedin_url: undefined,
  });
  expectAppError(() => ACTIONS["gtm.hunter_email"].parse({}), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.hunter_email"].parse({ domain: "vercel.com" }), "E_VALIDATION");
});

test("web.search rejects invalid queries", () => {
  expectAppError(() => ACTIONS["web.search"].parse({}), "E_VALIDATION");
  expectAppError(() => ACTIONS["web.search"].parse({ query: "   " }), "E_VALIDATION");
  expectAppError(() => ACTIONS["web.search"].parse({ query: 42 }), "E_VALIDATION");
  expectAppError(() => ACTIONS["web.search"].parse(null), "E_VALIDATION");
  expectAppError(() => ACTIONS["web.search"].parse({ query: "x".repeat(501) }), "E_VALIDATION");
});

test("web.search rejects out-of-range max_results and bad depth", () => {
  for (const value of [0, 11, 1.5, "5", null]) {
    expectAppError(() => ACTIONS["web.search"].parse({ query: "x", max_results: value }), "E_VALIDATION");
  }
  expectAppError(() => ACTIONS["web.search"].parse({ query: "x", search_depth: "deep" }), "E_VALIDATION");
});

test("web.read_url normalizes a public URL", () => {
  const parsed = ACTIONS["web.read_url"].parse({ url: "  https://Example.com/Pricing  " });
  assert.equal(parsed.url, "https://example.com/Pricing");
});

test("web.read_url rejects unsupported schemes", () => {
  for (const url of ["ftp://example.com", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "example.com"]) {
    expectAppError(() => ACTIONS["web.read_url"].parse({ url }), "E_BAD_URL");
  }
});

test("web.read_url rejects local and private destinations", () => {
  const urls = [
    "http://localhost:3000",
    "http://foo.localhost",
    "http://intranet",
    "http://127.0.0.1",
    "http://10.1.2.3",
    "http://172.20.0.1",
    "http://192.168.1.10",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1",
    "http://[::1]/",
    "http://[fe80::1]/",
    "https://user:pass@example.com",
  ];
  for (const url of urls) {
    expectAppError(() => ACTIONS["web.read_url"].parse({ url }), "E_BAD_URL");
  }
});

test("web.read_url rejects non-string input", () => {
  expectAppError(() => ACTIONS["web.read_url"].parse({ url: 123 }), "E_BAD_URL");
  expectAppError(() => ACTIONS["web.read_url"].parse({}), "E_BAD_URL");
});

test("assertResolvablePublicUrl rejects hostnames resolving to private addresses", async () => {
  await assert.rejects(
    () => assertResolvablePublicUrl("https://evil.example.com", async () => [{ address: "10.0.0.5" }]),
    (err: unknown) => err instanceof AppError && err.code === "E_BAD_URL",
  );
});

test("assertResolvablePublicUrl accepts public DNS answers and rejects lookup failures", async () => {
  const url = await assertResolvablePublicUrl("https://example.com/page", async () => [{ address: "93.184.216.34" }]);
  assert.equal(url.href, "https://example.com/page");

  await assert.rejects(
    () => assertResolvablePublicUrl("https://missing.example.com", async () => {
      throw new Error("ENOTFOUND");
    }),
    (err: unknown) => err instanceof AppError && err.code === "E_BAD_URL",
  );
});

test("assertPublicHttpUrl accepts public IP literals", () => {
  assert.equal(assertPublicHttpUrl("http://93.184.216.34/").hostname, "93.184.216.34");
});

test("search_companies applies paging defaults and trims filters", () => {
  assert.deepEqual(ACTIONS["gtm.search_companies"].parse({ domain: "  Acme.com ", country: ["United States"] }), {
    query: undefined,
    domain: "Acme.com",
    industry: undefined,
    employee_range: undefined,
    revenue_range: undefined,
    naics_code: undefined,
    linkedin_industry: undefined,
    country: ["United States"],
    state: undefined,
    exclude_domain: undefined,
    exclude_industry: undefined,
    exclude_employee_range: undefined,
    exclude_revenue_range: undefined,
    limit: 10,
    offset: 0,
  });
});

test("search_companies requires at least one positive filter", () => {
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({}), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ exclude_domain: ["acme.com"] }), "E_VALIDATION");
});

test("search_companies rejects out-of-range paging and unknown enum values", () => {
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ domain: "a.com", limit: 11 }), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ domain: "a.com", offset: -1 }), "E_VALIDATION");
  expectAppError(
    () => ACTIONS["gtm.search_companies"].parse({ domain: "a.com", offset: 9995, limit: 10 }),
    "E_VALIDATION",
  );
  expectAppError(
    () => ACTIONS["gtm.search_companies"].parse({ industry: "Not An Industry" }),
    "E_VALIDATION",
  );
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ employee_range: "51-1000" }), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ naics_code: "abc" }), "E_VALIDATION");
});

test("search_people rejects department combined with functional_area", () => {
  expectAppError(
    () => ACTIONS["gtm.search_people"].parse({ company_domain: "acme.com", department: "Sales", functional_area: "GTM" }),
    "E_VALIDATION",
  );
  expectAppError(() => ACTIONS["gtm.search_people"].parse({}), "E_VALIDATION");
});

test("search_people accepts arrays and maps them through", () => {
  const parsed = ACTIONS["gtm.search_people"].parse({
    company_domain: ["acme.com", "example.com"],
    seniority: "VP",
    limit: 5,
  });
  assert.deepEqual(parsed.company_domain, ["acme.com", "example.com"]);
  assert.equal(parsed.seniority, "VP");
  assert.equal(parsed.limit, 5);
  assert.equal(parsed.offset, 0);
});

test("MoltSets filter arrays are bounded", () => {
  const tooMany = Array.from({ length: 26 }, (_, i) => `c${i}.com`);
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ domain: tooMany }), "E_VALIDATION");
  expectAppError(() => ACTIONS["gtm.search_companies"].parse({ domain: [] }), "E_VALIDATION");
});
