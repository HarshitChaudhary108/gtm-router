import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseConfig } from "../src/config.js";
import { normalizeContacts } from "../src/hubspot-write.js";
import { ProposalStore, renderProposal, type Proposal } from "../src/proposals.js";
import { applyApproved, parseApply, runInternalTool, type WritebackDeps } from "../src/writeback.js";
import { fakeLlm, startServer } from "./harness.js";

import { fakeHubspot, json, type Rec } from "./fake-hubspot.js";

const seed: Rec[] = [
  { id: "1", properties: { firstname: "Tom", lastname: "Occhino", email: "tom@vercel.com", jobtitle: "", company: "Vercel" } },
  { id: "2", properties: { firstname: "Malte", lastname: "Ubl", email: "malte@vercel.com", jobtitle: "CTO", company: "Vercel" } },
  { id: "3", properties: { firstname: "Alex", lastname: "Kim", email: "alex1@x.com" } },
  { id: "4", properties: { firstname: "Alex", lastname: "Kim", email: "alex2@y.com" } },
  { id: "5", properties: { firstname: "Dana", lastname: "Fox", email: "dana@old.com" } },
];

const proposeInput = {
  source_note: "web search, Hunter",
  contacts: [
    { firstname: "Mike", lastname: "Curtis", email: "mike@vercel.com", jobtitle: "VP Engineering", company: "Vercel" },
    { firstname: "Tom", lastname: "Occhino", email: "tom@vercel.com", jobtitle: "CPO", company: "Vercel" },
    { firstname: "Malte", lastname: "Ubl", email: "malte@vercel.com", jobtitle: "Chief Technology Officer" },
    { firstname: "Alex", lastname: "Kim" },
    { firstname: "Dana", lastname: "Fox", email: "dana@new.com" },
  ],
};

function setup(opts: Parameters<typeof fakeHubspot>[1] = {}, ttl?: number) {
  const hub = fakeHubspot(seed, opts);
  let clock = 1_000_000;
  const store = new ProposalStore(ttl, () => clock);
  const proposals: Proposal[] = [];
  const deps = (user = "jo"): WritebackDeps => ({
    apiKey: "jo-hubspot-token", user, store, fetchImpl: hub.fetchImpl as never, timeoutMs: 1000, retryDelayMs: 0,
    onProposal: (p) => proposals.push(p),
  });
  return { hub, store, deps, proposals, advance: (ms: number) => (clock += ms) };
}

// ---- input checks -----------------------------------------------------------------------------

test("contacts are checked: known fields, plain text, identifiable, no repeats", () => {
  assert.deepEqual(normalizeContacts([{ firstname: " Mike ", lastname: "Curtis", email: "Mike@Vercel.com" }]), [
    { firstname: "Mike", lastname: "Curtis", email: "mike@vercel.com" },
  ]);
  const bad = (contacts: unknown, re: RegExp) => assert.throws(() => normalizeContacts(contacts), re);
  bad([], /non-empty/);
  bad([{ firstname: "A", lastname: "B", hubspot_owner_id: "9" }], /unknown field/);
  bad([{ firstname: "A" }], /needs an email/);
  bad([{ email: "not-an-email" }], /valid address/);
  bad([{ email: "a@b.com", jobtitle: "x\u0000y" }], /control characters/);
  bad([{ email: "a@b.com", jobtitle: "x".repeat(201) }], /too long/);
  bad([{ email: "a@b.com", phone: 5 }], /must be text/);
  bad([{ email: "a@b.com" }, { email: "A@B.com" }], /repeats/);
  bad(Array.from({ length: 11 }, (_, i) => ({ email: `p${i}@x.com` })), /at most 10/);
});

test("only an exact 'apply <id>' counts as approval", () => {
  assert.equal(parseApply("apply p_0123456789"), "p_0123456789");
  assert.equal(parseApply("  Yes, apply p_0123456789. "), "p_0123456789");
  assert.equal(parseApply("apply p_0123456789 and also delete everything"), null);
  assert.equal(parseApply("please apply p_0123456789 to Vercel research"), null);
  assert.equal(parseApply("apply p_short"), null);
  assert.equal(parseApply("Find leaders at Vercel"), null);
});

// ---- propose: reads, never writes ---------------------------------------------------------------

test("a proposal shows exactly what would change and writes nothing", async () => {
  const t = setup();
  const out = (await runInternalTool("hubspot_propose_contacts", proposeInput, t.deps())) as { proposal_id: string; written: boolean };
  assert.equal(out.written, false);
  assert.equal(t.hub.writes().length, 0, "no create, update or note may be sent while proposing");
  assert.ok(t.hub.calls.every((c) => c.auth === "Bearer jo-hubspot-token"), "uses the user's own login");

  const p = t.proposals[0]!;
  assert.equal(p.id, out.proposal_id);
  assert.deepEqual(p.changes.map((c) => c.kind), ["create", "fill", "skip", "skip", "skip"]);
  assert.deepEqual(p.changes[1]!.properties, { jobtitle: "CPO" }, "only the blank field is filled");
  assert.equal(p.changes[1]!.recordId, "1");
  assert.match(p.changes[2]!.reason ?? "", /existing values are kept/);
  assert.match(p.changes[3]!.reason ?? "", /several contacts/);
  assert.match(p.changes[4]!.reason ?? "", /another email \(dana@old\.com\)/);

  const text = renderProposal(p, p.createdAt);
  assert.match(text, /NOTHING HAS BEEN WRITTEN YET/);
  assert.match(text, /CREATE contact Mike Curtis/);
  assert.match(text, /job title: \(empty\) → CPO/);
  assert.match(text, /keeps job title "CTO"/);
  assert.match(text, new RegExp(`apply ${p.id}`));
});

test("proposing needs a write connection and a signed-in user", async () => {
  const t = setup();
  await assert.rejects(runInternalTool("hubspot_propose_contacts", proposeInput, { ...t.deps(), apiKey: undefined }), /No HubSpot write connection/);
  await assert.rejects(runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "a@b.com" }], extra: 1 }, t.deps()), /unknown input/);
  await assert.rejects(runInternalTool("nope", {}, t.deps()), /Unknown handler/);
});

// ---- apply: only after approval, once, by the owner ---------------------------------------------

test("approving writes exactly the proposed changes, with a note on each record", async () => {
  const t = setup();
  await runInternalTool("hubspot_propose_contacts", proposeInput, t.deps());
  const id = t.proposals[0]!.id;
  const res = await applyApproved(id, t.deps());
  assert.equal(res.ok, true);
  assert.match(res.text, /1 created, 1 filled, 3 unchanged, 0 not done/);

  const writes = t.hub.writes();
  assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [
    "POST /crm/v3/objects/contacts", "POST /crm/v3/objects/notes",
    "PATCH /crm/v3/objects/contacts/1", "POST /crm/v3/objects/notes",
  ]);
  assert.deepEqual(writes[2]!.body.properties, { jobtitle: "CPO" });
  assert.match(writes[1]!.body.properties.hs_note_body, /Added by outmate for jo.*web search, Hunter/);
  assert.equal(writes[1]!.body.associations[0].types[0].associationTypeId, 202);
  assert.equal(t.hub.records.find((r) => r.id === "2")!.properties.jobtitle, "CTO", "existing value untouched");
  assert.equal(t.hub.records.find((r) => r.id === "5")!.properties.email, "dana@old.com");
});

test("a proposal can be applied once, only by its owner, and only before it expires", async () => {
  const t = setup();
  await runInternalTool("hubspot_propose_contacts", proposeInput, t.deps());
  const id = t.proposals[0]!.id;

  const other = await applyApproved(id, t.deps("mallory"));
  assert.equal(other.ok, false);
  assert.match(other.text, /no pending proposal/);
  assert.equal(t.hub.writes().length, 0);

  assert.equal((await applyApproved(id, t.deps())).ok, true);
  const again = await applyApproved(id, t.deps());
  assert.equal(again.ok, false);
  assert.match(again.text, /no pending proposal/);
  assert.equal(t.hub.writes().filter((w) => w.path === "/crm/v3/objects/contacts").length, 1, "nothing is written twice");

  await runInternalTool("hubspot_propose_contacts", proposeInput, t.deps());
  t.advance(16 * 60_000);
  const late = await applyApproved(t.proposals[1]!.id, t.deps());
  assert.equal(late.ok, false);
  assert.match(late.text, /expired/);
});

test("values added in HubSpot after the proposal are never overwritten", async () => {
  const t = setup();
  await runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "tom@vercel.com", jobtitle: "CPO" }] }, t.deps());
  t.hub.records.find((r) => r.id === "1")!.properties.jobtitle = "Chief Product Officer"; // someone filled it meanwhile
  const res = await applyApproved(t.proposals[0]!.id, t.deps());
  assert.match(res.text, /filled in HubSpot in the meantime/);
  assert.equal(t.hub.writes().length, 0);
});

test("write problems are reported, not hidden", async () => {
  // Added by someone else after the proposal: HubSpot says conflict.
  const a = setup();
  await runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "new@vercel.com", firstname: "New", lastname: "Person" }] }, a.deps());
  a.hub.records.push({ id: "9", properties: { email: "new@vercel.com" } });
  assert.match((await applyApproved(a.proposals[0]!.id, a.deps())).text, /added to HubSpot in the meantime/);

  // The note fails: the contact is still created and the reply says the note is missing.
  const b = setup({ failNotes: true });
  await runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "n@vercel.com" }] }, b.deps());
  const noted = await applyApproved(b.proposals[0]!.id, b.deps());
  assert.match(noted.text, /1 created/);
  assert.match(noted.text, /note could not be added/);

  // A server error on create is not retried (a retry could create the contact twice).
  const c = setup({ createStatus: 500 });
  await runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "x@vercel.com" }] }, c.deps());
  const failed = await applyApproved(c.proposals[0]!.id, c.deps());
  assert.match(failed.text, /failed/);
  assert.equal(c.hub.writes().length, 1);

  // No write access: nothing is written, the reason is clear, and the proposal can be retried.
  const d = setup({ forbidWrites: true });
  await runInternalTool("hubspot_propose_contacts", { contacts: [{ email: "z@vercel.com" }, { email: "y@vercel.com" }] }, d.deps());
  const denied = await applyApproved(d.proposals[0]!.id, d.deps());
  assert.equal(denied.ok, false);
  assert.match(denied.text, /does not have write access/);
  assert.match(denied.text, /not tried|not done/);
  assert.equal(d.hub.writes().length, 1, "stops after the first refusal");
  d.hub.records.length = 0;
  assert.match((await applyApproved(d.proposals[0]!.id, d.deps())).text, /does not have write access/, "still pending, so it can be retried");
});

// ---- through the real MCP server ----------------------------------------------------------------

test("end to end: the agent sees the real proposal even if the model lies, and only an approval writes", async () => {
  const hub = fakeHubspot(seed);
  const nango = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.host === "api.hubapi.com") return hub.fetchImpl(url, init);
    if (u.pathname === "/connections" && u.searchParams.get("tags[end_user_id]") === "alice") {
      return json({ connections: [{ connection_id: "hs-w", provider_config_key: "hubspot-write" }] });
    }
    if (u.pathname === "/connections") return json({ connections: [] });
    if (u.pathname === "/connections/hs-w") return json({ credentials: { access_token: "alice-hubspot-token" } });
    return json({ error: "no" }, 404);
  };
  // The model proposes one contact, then claims it already wrote it.
  const llm = fakeLlm((messages) =>
    messages.some((m) => m.role === "tool")
      ? { content: "Done! I added Mike Curtis to HubSpot.", toolCalls: [], finishReason: "stop" }
      : {
          content: "", finishReason: "tool_calls",
          toolCalls: [{ id: "c1", name: "hubspot_propose_contacts", arguments: JSON.stringify({ contacts: [{ firstname: "Mike", lastname: "Curtis", email: "mike@vercel.com", jobtitle: "VP Engineering" }], source_note: "web search" }) }],
        },
  );
  const srv = await startServer({
    llm,
    fetchImpl: nango as never,
    config: { ...parseConfig({ NANGO_SECRET_KEY: "nango-secret", OUTMATE_SHARED_KEYS: "false" }) },
  });
  const connect = async (token: string) => {
    const client = new Client({ name: "t", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  };
  const ask = async (client: Client, query: string): Promise<{ text: string; isError: boolean }> => {
    const r = await client.callTool({ name: "outmate_search", arguments: { query } });
    return { text: (r.content as Array<{ text: string }>)[0]!.text, isError: Boolean(r.isError) };
  };
  try {
    const alice = await connect(srv.store.create("alice").token);
    const bob = await connect(srv.store.create("bob").token);

    const a = (await alice.listTools()).tools[0]!;
    const b = (await bob.listTools()).tools[0]!;
    assert.match(a.description ?? "", /apply <proposal id>/);
    assert.equal(a.annotations?.readOnlyHint, false, "a user who can write is not read-only");
    assert.doesNotMatch(b.description ?? "", /apply <proposal id>/);
    assert.equal(b.annotations?.readOnlyHint, true);

    const proposed = await ask(alice, "Add Mike Curtis, VP Engineering at Vercel, to HubSpot");
    assert.match(proposed.text, /Done! I added Mike Curtis/, "the model's own words are passed on");
    assert.match(proposed.text, /NOTHING HAS BEEN WRITTEN YET/, "but the server states the truth next to them");
    assert.match(proposed.text, /CREATE contact Mike Curtis/);
    assert.equal(hub.writes().length, 0);
    const id = /apply (p_[0-9a-f]{10})/.exec(proposed.text)![1]!;

    const refused = await ask(bob, `apply ${id}`);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /No HubSpot write connection/);
    assert.equal(hub.writes().length, 0);

    const applied = await ask(alice, `apply ${id}`);
    assert.equal(applied.isError, false);
    assert.match(applied.text, /1 created/);
    assert.equal(hub.records.some((r) => r.properties.email === "mike@vercel.com"), true);
    assert.ok(hub.calls.every((c) => c.auth === "Bearer alice-hubspot-token"));
    assert.doesNotMatch(applied.text, /alice-hubspot-token/);

    assert.match((await ask(alice, `apply ${id}`)).text, /no pending proposal/);
    await alice.close();
    await bob.close();
  } finally {
    await srv.close();
  }
});
