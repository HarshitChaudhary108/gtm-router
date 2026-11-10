import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { baseUrl } from "../src/setup.js";
import { startServer } from "./harness.js";

const reqWith = (headers: Record<string, string>): IncomingMessage => ({ headers }) as IncomingMessage;

test("baseUrl: PUBLIC_URL wins and must be http(s)", () => {
  assert.equal(baseUrl(reqWith({ host: "evil.test" }), { publicUrl: "https://gtm.example.com/some/path" }), "https://gtm.example.com");
  assert.equal(baseUrl(reqWith({ host: "evil.test" }), { publicUrl: "ftp://x.test" }), null);
  assert.equal(baseUrl(reqWith({ host: "evil.test" }), { publicUrl: "not a url" }), null);
});

test("baseUrl: uses forwarded headers, rejects anything that is not host[:port]", () => {
  const none = { publicUrl: undefined };
  assert.equal(baseUrl(reqWith({ host: "127.0.0.1:3333" }), none), "http://127.0.0.1:3333");
  assert.equal(
    baseUrl(reqWith({ host: "127.0.0.1:3333", "x-forwarded-host": "abc.ngrok-free.app", "x-forwarded-proto": "https" }), none),
    "https://abc.ngrok-free.app",
  );
  for (const bad of ['evil.com"; rm -rf /; "', "a b", "evil.com/path", "$(whoami).test", "evil.com\nx", ""]) {
    assert.equal(baseUrl(reqWith({ host: bad }), none), null, `must reject ${JSON.stringify(bad)}`);
  }
  assert.equal(baseUrl(reqWith({}), none), null);
});

test("setup files are public, filled with the host, and well formed", async () => {
  const srv = await startServer();
  try {
    srv.store.create("alice"); // auth is now on; setup files must stay readable
    for (const path of ["/llms.txt", "/skill.md", "/install.sh", "/gtm.mjs"]) {
      const res = await fetch(`${srv.base}${path}`);
      const text = await res.text();
      assert.equal(res.status, 200, path);
      assert.ok(!text.includes("{{HOST}}"), `${path} has an unreplaced placeholder`);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    }
    const llms = await (await fetch(`${srv.base}/llms.txt`)).text();
    assert.ok(llms.includes(`${srv.base}/install.sh`));
    assert.ok(llms.includes(`npm i -g outmate`));
    assert.ok(llms.includes(`gtm login --url ${srv.base} --token`));
    assert.ok(llms.includes(`${srv.base}/skill.md`));

    const script = join(srv.dir, "install.sh");
    writeFileSync(script, await (await fetch(`${srv.base}/install.sh`)).text());
    execFileSync("sh", ["-n", script]); // syntax check
    const gtm = join(srv.dir, "gtm.mjs");
    writeFileSync(gtm, await (await fetch(`${srv.base}/gtm.mjs`)).text());
    execFileSync(process.execPath, ["--check", gtm]);

    const post = await fetch(`${srv.base}/llms.txt`, { method: "POST" });
    assert.equal(post.status, 405);
  } finally {
    await srv.close();
  }
});

test("setup files refuse to render when no safe host can be built", async () => {
  const srv = await startServer({ config: { publicUrl: "ftp://x.test" } });
  try {
    assert.equal((await fetch(`${srv.base}/install.sh`)).status, 400);
  } finally {
    await srv.close();
  }
});

test("/whoami needs a valid token and never leaks provider keys", async () => {
  const srv = await startServer();
  try {
    const { token } = srv.store.create("alice");
    assert.equal((await fetch(`${srv.base}/whoami`)).status, 401);
    assert.equal((await fetch(`${srv.base}/whoami`, { headers: { Authorization: "Bearer gtm_bad" } })).status, 401);

    const res = await fetch(`${srv.base}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await res.text();
    assert.equal(res.status, 200);
    const body = JSON.parse(text) as { name: string; providers: Record<string, boolean> };
    assert.equal(body.name, "alice");
    assert.equal(body.providers.tavily, true);
    assert.equal(body.providers.hunter, false);
    assert.ok(!text.includes("tvly_secret_key_123456"));
  } finally {
    await srv.close();
  }
});

test("/mcp accepts a store token, rejects a missing or revoked one", async () => {
  const srv = await startServer();
  try {
    const { token } = srv.store.create("alice");
    const connect = async (headers?: Record<string, string>) => {
      const client = new Client({ name: "t", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers } }));
      return client;
    };

    const ok = await connect({ Authorization: `Bearer ${token}` });
    assert.deepEqual((await ok.listTools()).tools.map((t) => t.name), ["gtm_search"]);
    await ok.close();

    await assert.rejects(connect(), /401|Unauthorized/);
    srv.store.revoke("alice");
    await assert.rejects(connect({ Authorization: `Bearer ${token}` }), /401|Unauthorized/);

    const health = (await (await fetch(`${srv.base}/health`)).json()) as { auth: boolean };
    assert.equal(health.auth, true, "an empty token file keeps auth on");
  } finally {
    await srv.close();
  }
});
