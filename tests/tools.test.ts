import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import { KeyResolver } from "../src/keys.js";
import { ToolCatalog, capabilityLine, clearTokenCache, runHttpTool, type ToolFile } from "../src/tools.js";
import { coreCatalog } from "./core-tools.js";
import { startServer } from "./harness.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A copy of the real tools/ folder that a test can add files to. */
function toolsCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), "outmate-tools-"));
  cpSync(new URL("../tools/", import.meta.url), dir, { recursive: true });
  return dir;
}

const countTool: ToolFile = new ToolCatalog().byTool("hunter_email_count")!;

// ---- tool files -------------------------------------------------------------------------------

test("the tools folder holds the built-in tools in a fixed order, plus the http example", () => {
  const names = coreCatalog().list().map((t) => t.tool);
  assert.deepEqual(names, [
    "web_search",
    "read_url",
    "search_companies",
    "search_people",
    "apollo_companies",
    "apollo_people",
    "hunter_domain",
    "hunter_email",
    "hunter_email_count",
  ]);
});

test("a new tool file appears without restarting, and a broken one is skipped", () => {
  const dir = toolsCopy();
  const catalog = new ToolCatalog(dir);
  assert.equal(catalog.byTool("hubspot_contacts"), undefined);

  const base = JSON.parse(JSON.stringify(countTool)) as Record<string, unknown>;
  writeFileSync(
    join(dir, "hubspot_contacts.json"),
    JSON.stringify({ ...base, name: "custom.hubspot_contacts", tool: "hubspot_contacts", key: "hubspot", capability: "CRM contacts (HubSpot)" }),
  );
  writeFileSync(join(dir, "broken.json"), JSON.stringify({ name: "x" }));

  assert.equal(catalog.byTool("hubspot_contacts")?.key, "hubspot");
  assert.ok(catalog.keySlots().includes("hubspot"));
  assert.equal(catalog.issues().length, 1);
  assert.match(catalog.issues()[0]!, /broken\.json/);
});

test("an http tool may not template its host or use plain http", () => {
  const dir = toolsCopy();
  const base = JSON.parse(JSON.stringify(countTool)) as { request: { url: string } };
  for (const url of ["http://api.hunter.io/v2/x", "https://{domain}.evil.com/x"]) {
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ ...base, name: "custom.bad", tool: "bad", request: { ...base.request, url } }));
    const catalog = new ToolCatalog(dir);
    assert.equal(catalog.byTool("bad"), undefined, url);
    assert.equal(catalog.issues().length, 1, url);
  }
});

test("keyed tools are offered only to users who have the key", () => {
  const catalog = coreCatalog();
  const none = catalog.availableFor(() => false).map((t) => t.tool);
  assert.deepEqual(none, ["web_search", "read_url"]);
  const hunter = catalog.availableFor((slot) => slot === "hunter").map((t) => t.tool);
  assert.deepEqual(hunter, ["web_search", "read_url", "hunter_domain", "hunter_email", "hunter_email_count"]);
  assert.match(capabilityLine(catalog.availableFor((s) => s === "hunter")), /Hunter/);
  assert.equal(capabilityLine([]), "");
});

// ---- http tool runner -------------------------------------------------------------------------

test("an http tool calls its endpoint with the user's key in the header and returns result_path", async () => {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const data = await runHttpTool(countTool, { domain: "vercel.com" }, {
    apiKey: "user-key-123",
    timeoutMs: 1000,
    maxChars: 5000,
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init?.headers as Record<string, string> });
      return json({ data: { total: 42, personal_emails: 40 } });
    },
  });
  assert.deepEqual(data, { total: 42, personal_emails: 40 });
  assert.equal(seen[0]?.url, "https://api.hunter.io/v2/email-count?domain=vercel.com");
  assert.equal(seen[0]?.headers["X-API-KEY"], "user-key-123");
  assert.ok(!seen[0]?.url.includes("user-key-123"), "key must never be in the URL");
});

test("an http tool checks its input and needs a key", async () => {
  const deps = { apiKey: "k", timeoutMs: 1000, maxChars: 5000, fetchImpl: async () => json({}) };
  await assert.rejects(runHttpTool(countTool, {}, deps), { code: "E_VALIDATION" });
  await assert.rejects(runHttpTool(countTool, { domain: 5 }, deps), { code: "E_VALIDATION" });
  await assert.rejects(runHttpTool(countTool, { domain: "a.com", extra: 1 }, deps), { code: "E_VALIDATION" });
  await assert.rejects(runHttpTool(countTool, { domain: "a.com" }, { ...deps, apiKey: undefined }), { code: "E_CONFIG" });
});

// ---- per-user keys through Nango --------------------------------------------------------------

/** Fake Nango: user "alice" has a Hunter key, nobody else has anything. */
function fakeNango(log: string[] = []) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    log.push(`${init?.method ?? "GET"} ${url}`);
    assert.equal((init?.headers as Record<string, string>)?.Authorization, "Bearer nango-secret");
    const u = new URL(url);
    if (u.pathname === "/connections" && u.searchParams.get("tags[end_user_id]") === "alice") {
      return json({ connections: [{ connection_id: "conn-1", provider_config_key: "hunter" }] });
    }
    if (u.pathname === "/connections") return json({ connections: [] });
    if (u.pathname === "/connections/conn-1") return json({ credentials: { type: "API_KEY", apiKey: "alice-hunter-key" } });
    if (u.pathname === "/connect/sessions") {
      const body = JSON.parse(String(init?.body)) as { tags: Record<string, string>; allowed_integrations: string[] };
      return json({ data: { token: `session-${body.tags.end_user_id}-${body.allowed_integrations[0]}`, expires_at: "soon" } });
    }
    return json({ error: "no" }, 404);
  };
}

const slots = ["tavily", "moltsets", "hunter"];

test("a user's own Nango key wins over the shared key", async () => {
  const config = parseConfig({ NANGO_SECRET_KEY: "nango-secret", HUNTER_API_KEY: "shared-hunter", MOLTSETS_API_KEY: "shared-molt" });
  const keys = new KeyResolver(config, fakeNango() as never);
  const alice = await keys.forUser("alice", slots);
  assert.equal(alice.keys.hunter, "alice-hunter-key");
  assert.equal(alice.source.hunter, "own");
  assert.equal(alice.keys.moltsets, "shared-molt");
  assert.equal(alice.source.moltsets, "shared");
  assert.equal(alice.source.tavily, "none");

  const bob = await keys.forUser("bob", slots);
  assert.equal(bob.keys.hunter, "shared-hunter");
  assert.equal(bob.source.hunter, "shared");
});

test("with shared keys switched off a user without keys gets none", async () => {
  const config = parseConfig({ NANGO_SECRET_KEY: "nango-secret", HUNTER_API_KEY: "shared-hunter", OUTMATE_SHARED_KEYS: "false" });
  const keys = new KeyResolver(config, fakeNango() as never);
  assert.equal((await keys.forUser("bob", slots)).source.hunter, "none");
  assert.equal((await keys.forUser("alice", slots)).source.hunter, "own");
});

test("when Nango is down, shared keys still work", async () => {
  const config = parseConfig({ NANGO_SECRET_KEY: "nango-secret", HUNTER_API_KEY: "shared-hunter" });
  const keys = new KeyResolver(config, (async () => new Response("down", { status: 500 })) as never);
  const r = await keys.forUser("alice", slots);
  assert.equal(r.keys.hunter, "shared-hunter");
});

test("Nango lookups are cached, and invalidate forgets them", async () => {
  const log: string[] = [];
  const config = parseConfig({ NANGO_SECRET_KEY: "nango-secret" });
  const keys = new KeyResolver(config, fakeNango(log) as never);
  await keys.forUser("alice", slots);
  const after = log.length;
  await keys.forUser("alice", slots);
  assert.equal(log.length, after, "second call must hit the cache");
  keys.invalidate("alice");
  await keys.forUser("alice", slots);
  assert.ok(log.length > after);
});

test("without Nango the shared keys are used for everyone", async () => {
  const keys = new KeyResolver(parseConfig({ HUNTER_API_KEY: "shared-hunter" }));
  assert.equal(keys.nangoEnabled(), false);
  assert.equal((await keys.forUser("anyone", slots)).keys.hunter, "shared-hunter");
  await assert.rejects(keys.createConnectSession("anyone", "hunter"), { code: "E_CONFIG" });
});

test("a connect session is created for one provider, tagged with the user", async () => {
  const keys = new KeyResolver(parseConfig({ NANGO_SECRET_KEY: "nango-secret" }), fakeNango() as never);
  assert.equal((await keys.createConnectSession("alice", "hunter")).token, "session-alice-hunter");
});

// ---- Connections page and MCP description -----------------------------------------------------

test("the Connections page and API need a token and report each provider's source", async () => {
  const srv = await startServer({
    fetchImpl: fakeNango() as never,
    config: { ...parseConfig({ NANGO_SECRET_KEY: "nango-secret", MOLTSETS_API_KEY: "shared-molt" }) },
  });
  try {
    const alice = srv.store.create("alice").token;
    const page = await fetch(`${srv.base}/connections`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.doesNotMatch(await page.text(), /nango-secret/);

    assert.equal((await fetch(`${srv.base}/connections/api/state`)).status, 401);
    const state = (await (await fetch(`${srv.base}/connections/api/state`, { headers: { Authorization: `Bearer ${alice}` } })).json()) as {
      user: string;
      nango: boolean;
      providers: Array<{ id: string; source: string }>;
    };
    assert.equal(state.user, "alice");
    assert.equal(state.nango, true);
    const source = (id: string) => state.providers.find((p) => p.id === id)?.source;
    assert.equal(source("hunter"), "own");
    assert.equal(source("moltsets"), "shared");
    assert.equal(source("apollo"), "none");

    const session = await fetch(`${srv.base}/connections/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "apollo" }),
    });
    assert.equal(((await session.json()) as { token: string }).token, "session-alice-apollo");

    const bad = await fetch(`${srv.base}/connections/api/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice}`, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "../etc" }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await srv.close();
  }
});

test("outmate_search describes what this user can use, and updates when their keys change", async () => {
  const srv = await startServer({
    fetchImpl: fakeNango() as never,
    config: { ...parseConfig({ NANGO_SECRET_KEY: "nango-secret", OUTMATE_SHARED_KEYS: "false" }) },
  });
  const describeFor = async (token: string): Promise<string> => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
    );
    const tools = await client.listTools();
    await client.close();
    assert.equal(tools.tools.length, 1, "agents see exactly one tool");
    assert.equal(tools.tools[0]?.name, "outmate_search");
    return tools.tools[0]?.description ?? "";
  };
  try {
    const alice = srv.store.create("alice").token;
    const bob = srv.store.create("bob").token;
    assert.match(await describeFor(alice), /Can currently use: .*Hunter/);
    const bobs = await describeFor(bob);
    assert.match(bobs, /Can currently use: web search/);
    assert.doesNotMatch(bobs, /Hunter/);
  } finally {
    await srv.close();
  }
});

// ---- provider catalog ---------------------------------------------------------------------------

const specTool = (request: Record<string, unknown>, extra: Record<string, unknown> = {}): ToolFile =>
  ({
    name: "custom.t", tool: "t", kind: "http", key: "acme", needs_key: true, capability: "x", description: "a test tool",
    parameters: { type: "object", properties: { q: { type: "string" }, n: { type: "integer" } }, required: ["q"], additionalProperties: false },
    request, ...extra,
  }) as unknown as ToolFile;

async function sent(tool: ToolFile, input: unknown, reply: Response = json({ ok: true })) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const data = await runHttpTool(tool, input, {
    apiKey: "SECRETKEY", timeoutMs: 1000, maxChars: 5000,
    fetchImpl: async (url, init) => (seen.push({ url, init: init ?? {} }), reply),
  });
  return { seen: seen[0]!, data };
}

test("auth styles: basic, header prefix and bearer", async () => {
  const basicKeyAsUser = await sent(specTool({ method: "GET", url: "https://x.test/a", auth: { in: "basic" } }), { q: "a" });
  assert.equal((basicKeyAsUser.seen.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("SECRETKEY:").toString("base64")}`);
  const basicFixedUser = await sent(specTool({ method: "GET", url: "https://x.test/a", auth: { in: "basic", user: "api" } }), { q: "a" });
  assert.equal((basicFixedUser.seen.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from("api:SECRETKEY").toString("base64")}`);
  const emptyUser = await sent(specTool({ method: "GET", url: "https://x.test/a", auth: { in: "basic", user: "" } }), { q: "a" });
  assert.equal((emptyUser.seen.init.headers as Record<string, string>).Authorization, `Basic ${Buffer.from(":SECRETKEY").toString("base64")}`);
  const prefixed = await sent(specTool({ method: "GET", url: "https://x.test/a", auth: { in: "header", name: "Authorization", prefix: "Token " } }), { q: "a" });
  assert.equal((prefixed.seen.init.headers as Record<string, string>).Authorization, "Token SECRETKEY");
});

test("nested JSON bodies fill placeholders, keep types and drop missing inputs", async () => {
  const tool = specTool({
    method: "POST", url: "https://x.test/search", auth: { in: "bearer" },
    body: { query: "{q}", size: "{n}", filter: { domains: ["{q}"] }, optional: ["{missing}"], fixed: { a: 1 }, text: "find {q} now" },
  });
  const { seen } = await sent(tool, { q: "acme", n: 5 });
  assert.deepEqual(JSON.parse(String(seen.init.body)), { query: "acme", size: 5, filter: { domains: ["acme"] }, fixed: { a: 1 }, text: "find acme now" });
  const { seen: noN } = await sent(tool, { q: "acme" });
  assert.equal("size" in JSON.parse(String(noN.init.body)), false);
});

test("public tools need no key; text responses and array result paths work", async () => {
  const pub = specTool({ method: "GET", url: "https://x.test/jobs", headers: { "User-Agent": "outmate-test" }, result_path: "items.0" }, { key: "", needs_key: false });
  const out = await runHttpTool(pub, { q: "a" }, { timeoutMs: 1000, maxChars: 5000, fetchImpl: async (_u, init) => {
    assert.equal((init?.headers as Record<string, string>)["User-Agent"], "outmate-test");
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    return json({ items: [{ id: 1 }, { id: 2 }] });
  } });
  assert.deepEqual(out, { id: 1 });
  const text = await sent(specTool({ method: "GET", url: "https://x.test/page", auth: { in: "query", name: "k" }, response: "text" }), { q: "a" }, new Response("# Hello", { status: 200 }));
  assert.deepEqual(text.data, { text: "# Hello" });
  assert.match(text.seen.url, /k=SECRETKEY/);
});

test("a placeholder that is not a declared input is rejected when the file loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "outmate-tools-"));
  const bad = specTool({ method: "GET", url: "https://x.test/{nope}", auth: { in: "bearer" } });
  writeFileSync(join(dir, "typo.json"), JSON.stringify(bad));
  const catalog = new ToolCatalog(dir);
  assert.equal(catalog.list().length, 0);
  assert.match(catalog.issues()[0] ?? "", /\{nope\}/);
});

test("every shipped provider tool loads, stays on its own https host and never puts a header key in the URL", async () => {
  const catalog = new ToolCatalog();
  assert.deepEqual(catalog.issues(), []);
  const http = catalog.list().filter((t) => t.kind === "http");
  assert.ok(http.length >= 20, "the provider tools should be shipped");
  for (const tool of http) {
    clearTokenCache();
    const req = tool.request!;
    const input: Record<string, unknown> = {};
    for (const [k, schema] of Object.entries(tool.parameters.properties as Record<string, { type?: string; pattern?: string }>)) {
      if (!tool.parameters.required.includes(k)) continue;
      input[k] = schema.type === "integer" ? 3 : k === "uuid" ? "123e4567-e89b-12d3-a456-426614174000" : "sample";
    }
    const seen: string[] = [];
    await runHttpTool(tool, input, {
      apiKey: tool.key ? "SECRETKEY:SECONDHALF" : undefined,
      meta: { instance_url: "https://acme.my.salesforce.com" },
      timeoutMs: 1000, maxChars: 5000,
      fetchImpl: async (url) => (seen.push(url), url.includes("/oauth/token") ? json({ access_token: "EXCHANGED", expires_in: 3600 }) : json({})),
    }).catch(() => undefined);
    const main = seen[seen.length - 1]!;
    assert.ok(main, `${tool.tool} sent a request`);
    const url = new URL(main);
    const expectedHost = req.base_from ? "acme.my.salesforce.com" : new URL(req.url.replace(/\{[a-z0-9_]+\}/g, "x")).host;
    assert.equal(url.host, expectedHost, `${tool.tool} host`);
    assert.equal(url.protocol, "https:");
    const parts = req.auth === undefined ? [] : Array.isArray(req.auth) ? req.auth : [req.auth];
    if (!parts.some((a) => a.in === "query")) {
      for (const secret of ["SECRETKEY", "SECONDHALF", "EXCHANGED"]) assert.ok(!seen.join(" ").includes(secret), `${tool.tool} must not put ${secret} in a URL`);
    }
    if (!req.auth) assert.equal(tool.needs_key, false, `${tool.tool} is public`);
  }
});

test("input patterns are enforced", async () => {
  const tool = specTool(
    { method: "GET", url: "https://x.test/{id}", auth: { in: "bearer" } },
    { parameters: { type: "object", properties: { id: { type: "string", pattern: "^[0-9]{10}$" } }, required: ["id"], additionalProperties: false } },
  );
  const deps = { apiKey: "k", timeoutMs: 1000, maxChars: 100, fetchImpl: async () => json({}) };
  await assert.rejects(runHttpTool(tool, { id: "../../etc" }, deps), /wrong format/);
  assert.deepEqual(await runHttpTool(tool, { id: "0001318605" }, deps), {});
});

// ---- providers that need more than one credential ----------------------------------------------

test("a two-part key (first:second) fills two headers, and a missing half says how to fix it", async () => {
  const tool = specTool({
    method: "GET", url: "https://x.test/a",
    auth: [{ in: "header", name: "X-Api-Key", part: 0 }, { in: "header", name: "X-Api-Token", part: 1 }],
  });
  const got: Record<string, string>[] = [];
  await runHttpTool(tool, { q: "a" }, {
    apiKey: "the-key:the:token", timeoutMs: 1000, maxChars: 100,
    fetchImpl: async (_u, init) => (got.push(init?.headers as Record<string, string>), json({})),
  });
  assert.equal(got[0]!["X-Api-Key"], "the-key");
  assert.equal(got[0]!["X-Api-Token"], "the:token", "split at the first colon only");
  await assert.rejects(
    runHttpTool(tool, { q: "a" }, { apiKey: "only-one-value", timeoutMs: 1000, maxChars: 100, fetchImpl: async () => json({}) }),
    /joined by a colon/,
  );
});

test("a token exchange trades the key for a bearer token once, then reuses it", async () => {
  clearTokenCache();
  const tool = specTool({
    method: "GET", url: "https://api.x.test/data",
    token_exchange: { url: "https://auth.x.test/token", body: { grant_type: "client_credentials", client_id: "{key.0}", client_secret: "{key.1}" } },
    auth: [{ in: "bearer", from: "exchange" }, { in: "header", name: "X-Client-Id", part: 0 }],
  });
  const calls: Array<{ url: string; headers: Record<string, string>; body?: any }> = [];
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, headers: init?.headers as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return url.startsWith("https://auth.x.test") ? json({ access_token: "tok-1", expires_in: 3600 }) : json({ ok: true });
  };
  const deps = { apiKey: "cid:csecret", timeoutMs: 1000, maxChars: 100, fetchImpl };
  await runHttpTool(tool, { q: "a" }, deps);
  await runHttpTool(tool, { q: "b" }, deps);
  const exchanges = calls.filter((c) => c.url.startsWith("https://auth.x.test"));
  assert.equal(exchanges.length, 1, "the token is cached");
  assert.deepEqual(exchanges[0]!.body, { grant_type: "client_credentials", client_id: "cid", client_secret: "csecret" });
  const api = calls.filter((c) => c.url.startsWith("https://api.x.test"));
  assert.equal(api.length, 2);
  assert.equal(api[0]!.headers.Authorization, "Bearer tok-1");
  assert.equal(api[0]!.headers["X-Client-Id"], "cid");
  assert.ok(!JSON.stringify(api).includes("csecret"), "the secret is only sent to the token endpoint");

  clearTokenCache();
  await assert.rejects(
    runHttpTool(tool, { q: "a" }, { ...deps, fetchImpl: async () => json({ error: "access_denied" }, 401) }),
    /sign-in rejected the API credentials/,
  );
});

test("a host taken from the connection must be an allowed https host", async () => {
  const tool = specTool({ method: "GET", url: "/services/data/query", base_from: { field: "instance_url", suffixes: [".salesforce.com", ".force.com"] }, auth: { in: "bearer" } });
  const run = (instance?: string) => {
    const urls: string[] = [];
    return runHttpTool(tool, { q: "a" }, {
      apiKey: "tok", meta: instance ? { instance_url: instance } : undefined, timeoutMs: 1000, maxChars: 100,
      fetchImpl: async (url) => (urls.push(url), json({})),
    }).then(() => urls[0]);
  };
  assert.match((await run("https://acme.my.salesforce.com"))!, /^https:\/\/acme\.my\.salesforce\.com\/services\/data\/query/);
  assert.match((await run("https://acme.my.salesforce.com/"))!, /^https:\/\/acme\.my\.salesforce\.com\//);
  assert.match((await run("https://acme.lightning.force.com"))!, /force\.com/);
  for (const bad of [
    "http://acme.my.salesforce.com", "https://evil.com", "https://salesforce.com.evil.com", "https://evilsalesforce.com",
    "https://user:pw@acme.my.salesforce.com", "https://acme.my.salesforce.com:8443", "not a url",
  ]) {
    await assert.rejects(run(bad), /may not call|not a valid URL/, bad);
  }
  await assert.rejects(run(undefined), /has no instance_url/);
});

test("tool files that misuse base_from, exchange or part are skipped when loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "outmate-tools-"));
  const cases: Record<string, Record<string, unknown>> = {
    a: { method: "GET", url: "https://x.test/a", base_from: { field: "instance_url", suffixes: [".salesforce.com"] } }, // not a path
    b: { method: "GET", url: "/a", base_from: { field: "instance_url", suffixes: ["salesforce.com"] } }, // no leading dot
    c: { method: "GET", url: "https://x.test/a", auth: { in: "bearer", from: "exchange" } }, // no token_exchange
    d: { method: "GET", url: "https://x.test/a", auth: { in: "header", name: "X", part: 2 } },
    e: { method: "GET", url: "https://x.test/a", token_exchange: { url: "http://x.test/t", body: {} }, auth: { in: "bearer" } },
  };
  for (const [name, request] of Object.entries(cases)) {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(specTool(request, { name: `custom.${name}`, tool: `t_${name}`, key: "k", needs_key: true })));
  }
  const catalog = new ToolCatalog(dir);
  assert.equal(catalog.list().length, 0);
  assert.equal(catalog.issues().length, 5);
});

test("search terms for Salesforce cannot break out of the query", async () => {
  const tool = new ToolCatalog().byTool("salesforce_search_accounts")!;
  const deps = { apiKey: "tok", meta: { instance_url: "https://acme.my.salesforce.com" }, timeoutMs: 1000, maxChars: 500, fetchImpl: async () => json({ records: [] }) };
  for (const bad of ["x' OR Name != '", "a%", "a_b", "x\\", "a;b"]) await assert.rejects(runHttpTool(tool, { name: bad }, deps), /wrong format/, bad);
  assert.deepEqual(await runHttpTool(tool, { name: "Acme & Sons, Inc." }, deps), []);
});

test("the resolver reads a Salesforce instance_url from the connection, and from the environment", async () => {
  const nango = async (url: string): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === "/connections" && u.searchParams.get("tags[end_user_id]") === "alice") {
      return json({ connections: [{ connection_id: "sf-1", provider_config_key: "salesforce" }] });
    }
    if (u.pathname === "/connections") return json({ connections: [] });
    if (u.pathname === "/connections/sf-1") {
      return json({ credentials: { access_token: "alice-sf-token" }, connection_config: { instance_url: "https://acme.my.salesforce.com", ignored: "x" } });
    }
    return json({}, 404);
  };
  const config = parseConfig({ NANGO_SECRET_KEY: "nango-secret", OUTMATE_SHARED_KEYS: "false" });
  const alice = await new KeyResolver(config, nango as never).forUser("alice", ["salesforce"]);
  assert.equal(alice.keys.salesforce, "alice-sf-token");
  assert.deepEqual(alice.meta.salesforce, { instance_url: "https://acme.my.salesforce.com" });

  process.env.SALESFORCE_API_KEY = "shared-sf-token";
  process.env.SALESFORCE_INSTANCE_URL = "https://shared.my.salesforce.com";
  try {
    const shared = await new KeyResolver(parseConfig({})).forUser("bob", ["salesforce"]);
    assert.equal(shared.keys.salesforce, "shared-sf-token");
    assert.deepEqual(shared.meta.salesforce, { instance_url: "https://shared.my.salesforce.com" });
  } finally {
    delete process.env.SALESFORCE_API_KEY;
    delete process.env.SALESFORCE_INSTANCE_URL;
  }
});
