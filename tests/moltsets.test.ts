import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCompanies, normalizePeople, searchCompanies, searchPeople } from "../src/adapters/moltsets.js";
import { AppError } from "../src/errors.js";
import type { FetchLike } from "../src/http.js";

const COMPANY_PAYLOAD = {
  status: "success",
  results: {
    total: 1,
    results: [
      {
        name: "Acme Corp",
        domain: "acme.com",
        industry: "Information Technology",
        employee_range: "51-200",
        employee_count: 120,
        revenue_range: "$10M - $20M",
        linkedin_url: "https://www.linkedin.com/company/acme",
        city: "San Francisco",
        state: "CA",
        country: "United States",
        naics_codes: ["541511"],
        naics_titles: ["Custom Computer Programming Services"],
        linkedin_industry: ["Software Development"],
        _score: 0.9,
      },
    ],
  },
};

const PEOPLE_PAYLOAD = {
  status: "success",
  results: {
    total: 1,
    results: [
      {
        full_name: "Jane Doe",
        title: "VP Engineering",
        seniority: "VP",
        headline: "VP Engineering at Acme",
        city: "San Francisco",
        state: "CA",
        country: "United States",
        functional_area: ["Engineering"],
        linkedin_url: "https://www.linkedin.com/in/janedoe",
        business_email: "jane@acme.com",
        business_email_risk_score: "low",
        business_email_validated_at: "2026-01-01",
        company: { name: "Acme Corp", domain: "https://acme.com", industry: "Information Technology" },
        _score: 0.7,
      },
    ],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function expectAppError(fn: () => Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

const companyParams = { domain: "acme.com", limit: 10, offset: 0 };

test("searchCompanies posts to the tools endpoint with bearer auth and a User-Agent", async () => {
  let captured: { url: string; init?: RequestInit } | undefined;
  const fetchImpl: FetchLike = async (url, init) => {
    captured = { url, init };
    return jsonResponse(COMPANY_PAYLOAD);
  };

  const data = await searchCompanies(companyParams, { apiKey: "ms-test-key", fetchImpl, retryDelayMs: 1 });

  assert.equal(captured?.url, "https://api.moltsets.com/api/v1/tools/search_companies");
  assert.equal(captured?.init?.method, "POST");
  const headers = captured?.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ms-test-key");
  assert.ok(headers["User-Agent"], "MoltSets rejects requests without a User-Agent");
  assert.equal(JSON.parse(String(captured?.init?.body)).domain, "acme.com");
  assert.equal(data.total, 1);
  assert.equal(data.results[0]?.domain, "acme.com");
  assert.equal(data.results[0]?.employee_count, "120");
  assert.deepEqual(data.results[0]?.naics_codes, ["541511"]);
});

test("searchPeople normalizes the nested company and contact fields", async () => {
  const data = await searchPeople(
    { company_domain: "acme.com", limit: 10, offset: 0 },
    { apiKey: "k", fetchImpl: async () => jsonResponse(PEOPLE_PAYLOAD), retryDelayMs: 1 },
  );

  assert.equal(data.results[0]?.name, "Jane Doe");
  assert.equal(data.results[0]?.business_email, "jane@acme.com");
  assert.equal(data.results[0]?.company_name, "Acme Corp");
  assert.equal(data.results[0]?.company_domain, "acme.com");
  assert.equal(data.results[0]?.linkedin_url, "https://www.linkedin.com/in/janedoe");
});

test("normalizers cap results and tolerate an empty miss", () => {
  const many = { results: { total: 50, results: Array.from({ length: 5 }, () => ({})) } };
  assert.equal(normalizeCompanies(many, 2).results.length, 2);

  const miss = { status: "not_found", results: { total: 0, results: [] } };
  assert.deepEqual(normalizeCompanies(miss), { results: [], total: 0 });
  assert.deepEqual(normalizePeople(miss), { results: [], total: 0 });
});

test("normalizers reject a payload without a results array", async () => {
  await expectAppError(
    () => searchCompanies(companyParams, { apiKey: "k", fetchImpl: async () => jsonResponse({ status: "success" }) }),
    "E_PROVIDER",
  );
});

test("MoltSets fails clearly without a key and never calls the network", async () => {
  let called = false;
  const fetchImpl: FetchLike = async () => {
    called = true;
    return jsonResponse(COMPANY_PAYLOAD);
  };
  await expectAppError(() => searchCompanies(companyParams, { fetchImpl }), "E_CONFIG");
  assert.equal(called, false);
});

test("HTTP 402 maps to E_QUOTA", async () => {
  await expectAppError(
    () => searchCompanies(companyParams, { apiKey: "k", fetchImpl: async () => jsonResponse({}, 402) }),
    "E_QUOTA",
  );
});

test("HTTP 401 and 403 map to a credential error", async () => {
  for (const status of [401, 403]) {
    await expectAppError(
      () => searchPeople({ company_domain: "acme.com", limit: 10, offset: 0 }, {
        apiKey: "k",
        fetchImpl: async () => jsonResponse({}, status),
      }),
      "E_PROVIDER_AUTH",
    );
  }
});

test("MoltSets 429 is surfaced without automatic retries", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls++;
    return jsonResponse({ detail: "slow down" }, 429);
  };
  await expectAppError(() => searchCompanies(companyParams, { apiKey: "k", fetchImpl, retryDelayMs: 1 }), "E_RATE_LIMIT");
  assert.equal(calls, 1);
});

test("MoltSets 422 is a provider error", async () => {
  await expectAppError(
    () => searchCompanies(companyParams, { apiKey: "k", fetchImpl: async () => jsonResponse({ detail: "bad filter" }, 422) }),
    "E_PROVIDER",
  );
});
