import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { authenticate, authRequired, TokenStore } from "../src/auth.js";

const newStore = (): { store: TokenStore; file: string } => {
  const file = join(mkdtempSync(join(tmpdir(), "outmate-auth-")), "data", "tokens.json");
  return { store: new TokenStore(file), file };
};
const reqWith = (authorization?: string): IncomingMessage => ({ headers: authorization ? { authorization } : {} }) as IncomingMessage;

test("create stores only a hash, with a private file mode", () => {
  const { store, file } = newStore();
  const { token } = store.create("alice");
  assert.match(token, /^outmate_[A-Za-z0-9_-]{43}$/);
  assert.ok(!readFileSync(file, "utf8").includes(token), "plaintext token must not be on disk");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.verify(token), { name: "alice" });
  assert.equal(store.verify(`${token}x`), undefined);
  assert.equal(store.verify("outmate_wrong"), undefined);
});

test("rejects bad and duplicate names", () => {
  const { store } = newStore();
  store.create("alice");
  assert.throws(() => store.create("alice"), /already exists/);
  assert.throws(() => store.create("../etc"), /Name must be/);
  assert.throws(() => store.create(""), /Name must be/);
});

test("revoke removes access, and an empty store still denies everyone", () => {
  const { store } = newStore();
  const { token } = store.create("alice");
  assert.equal(store.revoke("alice"), true);
  assert.equal(store.revoke("alice"), false);
  assert.equal(store.verify(token), undefined);
  assert.equal(authRequired({ store }), true, "file exists, so auth stays on");
  assert.equal(authenticate(reqWith(`Bearer ${token}`), { store }), null);
});

test("a corrupt token file fails closed", () => {
  const { store, file } = newStore();
  const { token } = store.create("alice");
  writeFileSync(file, "{not json");
  assert.equal(store.verify(token), undefined);
  assert.equal(authenticate(reqWith(`Bearer ${token}`), { store }), null);
});

test("authenticate: open, legacy token and store token", () => {
  const { store } = newStore();
  assert.deepEqual(authenticate(reqWith(), { store }), { name: "open" }, "no file, no legacy token: open");

  const { token } = store.create("alice");
  assert.equal(authenticate(reqWith(), { store }), null);
  assert.equal(authenticate(reqWith("Basic abc"), { store }), null);
  assert.deepEqual(authenticate(reqWith(`Bearer ${token}`), { store }), { name: "alice" });

  assert.deepEqual(authenticate(reqWith("Bearer legacy-secret"), { legacyToken: "legacy-secret", store }), { name: "legacy" });
  assert.equal(authenticate(reqWith("Bearer nope"), { legacyToken: "legacy-secret", store }), null);
});
