import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import { KeyResolver } from "../src/keys.js";
import { ToolCatalog, capabilityLine, runHttpTool, type ToolFile } from "../src/tools.js";
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
  const names = new ToolCatalog().list().map((t) => t.tool);
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
  const catalog = new ToolCatalog();
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
