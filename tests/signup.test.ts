import assert from "node:assert/strict";
import test from "node:test";
import { nameForEmail } from "../src/signup.js";
import { startServer } from "./harness.js";

const post = (base: string, fields: Record<string, string>) =>
  fetch(`${base}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  });

const tokenIn = (html: string): string | undefined => html.match(/gtm_[A-Za-z0-9_-]{43}/)?.[0];

test("nameForEmail maps emails to store-safe names and rejects junk", () => {
  assert.equal(nameForEmail("Jo.Smith@Acme.com"), "jo.smith_at_acme.com");
  assert.equal(nameForEmail("a+b@x.io"), "a-b_at_x.io");
  for (const bad of ["", "no-at-sign", "a@b", "<script>@x.com", `${"a".repeat(70)}@x.com`]) {
    assert.equal(nameForEmail(bad), null, bad);
  }
});

test("signup is closed unless SIGNUP_ENABLED", async () => {
  const srv = await startServer();
  try {
    assert.equal((await fetch(`${srv.base}/signup`)).status, 404);
    assert.equal((await post(srv.base, { email: "jo@acme.com" })).status, 404);
    assert.equal(srv.store.exists(), false, "no token file may be created");
  } finally {
    await srv.close();
  }
});

test("signup issues a working token once per email", async () => {
  const srv = await startServer({ config: { signupEnabled: true } });
  try {
    const form = await fetch(`${srv.base}/signup`);
    assert.equal(form.status, 200);
    assert.match(await form.text(), /<form method="post"/);

    const res = await post(srv.base, { email: "Jo@Acme.com" });
    assert.equal(res.status, 201);
    const html = await res.text();
    const token = tokenIn(html);
    assert.ok(token, "token must be on the page");
    assert.ok(html.includes(`set up gtm-router — ${srv.base}/llms.txt`));

    const who = await fetch(`${srv.base}/whoami`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(who.status, 200);
    assert.equal(((await who.json()) as { name: string }).name, "jo_at_acme.com");

    const again = await post(srv.base, { email: "jo@acme.com" });
    assert.equal(again.status, 409);
    assert.equal(tokenIn(await again.text()), undefined);

    assert.equal((await post(srv.base, { email: "not an email" })).status, 400);
  } finally {
    await srv.close();
  }
});

test("signup requires the invite code when one is set", async () => {
  const srv = await startServer({ config: { signupEnabled: true, signupCode: "launch-2026" } });
  try {
    assert.match(await (await fetch(`${srv.base}/signup`)).text(), /name="code"/);
    assert.equal((await post(srv.base, { email: "a@acme.com" })).status, 403);
    assert.equal((await post(srv.base, { email: "a@acme.com", code: "wrong" })).status, 403);
    assert.equal((await post(srv.base, { email: "a@acme.com", code: "launch-2026" })).status, 201);
  } finally {
    await srv.close();
  }
});

test("signup stops at the hourly cap", async () => {
  const srv = await startServer({ config: { signupEnabled: true, signupPerHour: 2 } });
  try {
    assert.equal((await post(srv.base, { email: "a@acme.com" })).status, 201);
    assert.equal((await post(srv.base, { email: "b@acme.com" })).status, 201);
    assert.equal((await post(srv.base, { email: "c@acme.com" })).status, 429);
  } finally {
    await srv.close();
  }
});
