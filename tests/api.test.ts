import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test, { after, before } from "node:test";
import { createHandler, type AppContext } from "../src/api.js";
import { parseConfig } from "../src/config.js";
import type { FetchLike } from "../src/http.js";
import type { LlmClient } from "../src/llm.js";

const publicLookup = async () => [{ address: "93.184.216.34" }];
const fetchCalls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const fetchImpl: FetchLike = async (url) => {
  fetchCalls.push(url);
  if (url.startsWith("https://api.tavily.com/search")) {
    return json({
      query: "acme",
      results: [{ title: "Acme", url: "https://acme.com", content: "Acme official site", score: 0.8 }],
    });
  }
  if (url.startsWith("https://r.jina.ai/")) {
    return json({ code: 200, data: { title: "Example", url: "https://example.com/", content: "page content" } });
  }
  if (url === "https://api.moltsets.com/api/v1/tools/search_companies") {
    return json({
      status: "success",
      results: {
        total: 1,
        results: [{ name: "Acme Corp", domain: "acme.com", industry: "Information Technology", employee_range: "51-200" }],
      },
    });
  }
  if (url === "https://api.moltsets.com/api/v1/tools/search_people") {
    return json({
      status: "success",
      results: {
        total: 1,
        results: [
          {
            full_name: "Jane Doe",
            title: "VP Engineering",
            linkedin_url: "https://www.linkedin.com/in/janedoe",
            business_email: "jane@acme.com",
            company: { name: "Acme Corp", domain: "acme.com" },
          },
        ],
      },
    });
  }
  throw new Error(`Unexpected fetch in test: ${url}`);
};

const defaultLlm: LlmClient = {
  async complete() {
    return { content: "Routing answer.", toolCalls: [], finishReason: "stop" };
  },
};

const config = parseConfig({
  TAVILY_API_KEY: "tv-secret-value",
  JINA_API_KEY: "jina-secret-value",
  MOLTSETS_API_KEY: "moltsets-secret-value",
  LLM_API_KEY: "llm-secret-value",
  LLM_MODEL: "test-model",
});
const ctx: AppContext = { config, llm: defaultLlm, fetchImpl, lookup: publicLookup };

let server: Server;
let base = "";

async function startServer(context: AppContext): Promise<{ server: Server; base: string }> {
  const instance = createServer(createHandler(context));
  await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
  const address = instance.address();
  if (typeof address !== "object" || address === null) throw new Error("Server did not bind");
  return { server: instance, base: `http://127.0.0.1:${address.port}` };
}

before(async () => {
  ({ server, base } = await startServer(ctx));
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The response envelope is a JSON object; tests index into it freely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bodyOf(res: Response): Promise<any> {
  return res.json();
}

test("health reports configuration presence without values", async () => {
  const res = await fetch(`${base}/api/health`);
  assert.equal(res.status, 200);
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(body.status, "ok");
  assert.deepEqual(body.config, {
    tavily: true,
    jina: true,
    moltsets: true,
    parallel: false,
    you: false,
    linkup: false,
    firecrawl: false,
    serper: false,
    apify: false,
    browserbase: false,
    apollo: false,
    hunter: false,
    llm: true,
    llm_model: "test-model",
  });
  for (const secret of ["tv-secret-value", "jina-secret-value", "moltsets-secret-value", "llm-secret-value"]) {
    assert.ok(!text.includes(secret), "health response must not include secrets");
  }
});

test("tools lists every registered action with schemas", async () => {
  const res = await fetch(`${base}/api/v1/tools`);
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.deepEqual(body.actions.map((a: { name: string }) => a.name), [
    "web.search",
    "web.read_url",
    "outmate.search_companies",
    "outmate.search_people",
    "outmate.apollo_companies",
    "outmate.apollo_people",
    "outmate.hunter_domain",
    "outmate.hunter_email",
  ]);
  for (const action of body.actions) {
    assert.equal(action.parameters.type, "object");
    assert.ok(Array.isArray(action.parameters.required));
    assert.equal(action.parameters.additionalProperties, false);
  }
});

test("direct search endpoint executes web.search without an LLM", async () => {
  const res = await post("/api/v1/actions/search", { query: "acme", max_results: 3 });
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.results[0].url, "https://acme.com/");
  assert.equal(body.execution[0].action, "web.search");
  assert.equal(body.execution[0].provider, "tavily");
  assert.match(body.request_id, /^req_/);
});

test("direct search endpoint validates input", async () => {
  const res = await post("/api/v1/actions/search", { query: "" });
  const body = await bodyOf(res);
  assert.equal(res.status, 400);
  assert.equal(body.status, "error");
  assert.equal(body.error.code, "E_VALIDATION");
  assert.ok(body.request_id);
});

test("direct read endpoint executes web.read_url", async () => {
  const res = await post("/api/v1/actions/read-url", { url: "https://example.com/" });
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.page.content, "page content");
  assert.equal(body.data.page.url, "https://example.com/");
  assert.equal(body.execution[0].provider, "jina");
});

test("direct read endpoint rejects private destinations before any provider call", async () => {
  const before = fetchCalls.length;
  const res = await post("/api/v1/actions/read-url", { url: "http://127.0.0.1:8080/admin" });
  const body = await bodyOf(res);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "E_BAD_URL");
  assert.equal(fetchCalls.length, before);
});

test("direct company search endpoint executes outmate.search_companies", async () => {
  const res = await post("/api/v1/actions/search-companies", { domain: "acme.com" });
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.answer, "Found 1 of 1 matching company.");
  assert.equal(body.data.companies[0].name, "Acme Corp");
  assert.equal(body.data.companies[0].domain, "acme.com");
  assert.equal(body.execution[0].action, "outmate.search_companies");
  assert.equal(body.execution[0].provider, "moltsets");
});

test("direct people search endpoint executes outmate.search_people", async () => {
  const res = await post("/api/v1/actions/search-people", { company_domain: "acme.com", seniority: "VP" });
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.data.people[0].name, "Jane Doe");
  assert.equal(body.data.people[0].business_email, "jane@acme.com");
  assert.equal(body.data.people[0].company_name, "Acme Corp");
  assert.equal(body.execution[0].action, "outmate.search_people");
});

test("company search endpoint validates filters", async () => {
  const res = await post("/api/v1/actions/search-companies", {});
  const body = await bodyOf(res);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "E_VALIDATION");
});

test("MoltSets actions report E_CONFIG when the key is absent", async () => {
  const keyless = await startServer({ ...ctx, config: parseConfig({ TAVILY_API_KEY: "tv-secret-value" }) });
  try {
    const res = await fetch(`${keyless.base}/api/v1/actions/search-companies`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "acme.com" }),
    });
    const body = await bodyOf(res);
    assert.equal(res.status, 503);
    assert.equal(body.error.code, "E_CONFIG");
  } finally {
    await new Promise<void>((resolve, reject) =>
      keyless.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("route endpoint runs the LLM with no tool calls and returns a normalized envelope", async () => {
  const res = await post("/api/v1/route", { input: "Say hello." });
  const body = await bodyOf(res);
  assert.equal(res.status, 200);
  assert.equal(body.status, "success");
  assert.equal(body.answer, "Routing answer.");
  assert.deepEqual(body.data, { results: [], page: null, companies: [], people: [] });
  assert.equal(body.meta.tools_used, 0);
});

test("route endpoint validates the input field", async () => {
  const res = await post("/api/v1/route", {});
  const body = await bodyOf(res);
  assert.equal(res.status, 400);
  assert.equal(body.error.code, "E_VALIDATION");
});

test("route endpoint rejects the wrong method", async () => {
  const res = await fetch(`${base}/api/v1/route`);
  const body = await bodyOf(res);
  assert.equal(res.status, 405);
  assert.equal(body.error.code, "E_METHOD");
});

test("unknown API routes return a structured 404", async () => {
  const res = await fetch(`${base}/api/nope`);
  const body = await bodyOf(res);
  assert.equal(res.status, 404);
  assert.equal(body.error.code, "E_NOT_FOUND");
});

test("the demo UI is served at the root", async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("GTM"));
  assert.ok(html.includes("/api/v1/route"));
});

test("responses redact configured secrets even if a provider echoes them", async () => {
  const echoingLlm: LlmClient = {
    async complete() {
      return {
        content: "leaked tv-secret-value and llm-secret-value",
        toolCalls: [],
        finishReason: "stop",
      };
    },
  };
  const isolated = await startServer({ ...ctx, llm: echoingLlm, config });
  try {
    const res = await fetch(`${isolated.base}/api/v1/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "echo the secrets" }),
    });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok(!text.includes("tv-secret-value"));
    assert.ok(!text.includes("llm-secret-value"));
    assert.ok(text.includes("[REDACTED]"));
  } finally {
    await new Promise<void>((resolve, reject) =>
      isolated.server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
