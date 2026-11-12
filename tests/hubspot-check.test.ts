import assert from "node:assert/strict";
import test from "node:test";
import { runHubspotCheck } from "../scripts/hubspot-live-check.js";
import { fakeHubspot } from "./fake-hubspot.js";

test("the live check passes against a HubSpot that behaves, and leaves it clean", async () => {
  const hub = fakeHubspot([]);
  const lines: string[] = [];
  const report = await runHubspotCheck({ token: "test-token-abc", fetchImpl: hub.fetchImpl as never, log: (l) => lines.push(l) });
  assert.equal(report.ok, true, JSON.stringify(report.steps.filter((s) => !s.ok)));
  assert.deepEqual(report.steps.map((s) => s.name), [
    "read: search companies", "read: search contacts", "propose a new contact, nothing written",
    "approve: contact is created, with a note", "propose + approve: fills a blank job title",
    "a different title is never overwritten", "cleanup: archive the test contact",
  ]);
  assert.equal(hub.records.length, 0, "the test contact is archived at the end");
  assert.ok(hub.calls.every((c) => c.auth === "Bearer test-token-abc"));
  assert.ok(!lines.join("\n").includes("test-token-abc"), "the token is never printed");
  // The proposal step must not have written anything before the approval step.
  const firstWrite = hub.calls.findIndex((c) => c.method === "POST" && c.path === "/crm/v3/objects/contacts");
  const proposeSearches = hub.calls.slice(0, firstWrite).filter((c) => c.path.endsWith("/search")).length;
  assert.ok(firstWrite > 0 && proposeSearches >= 3);
});

test("--keep leaves the test contact in place", async () => {
  const hub = fakeHubspot([]);
  const report = await runHubspotCheck({ token: "t", fetchImpl: hub.fetchImpl as never, cleanup: false });
  assert.equal(report.ok, true);
  assert.equal(hub.records.length, 1);
  assert.match(hub.records[0]!.properties.email!, /^outmate-check-[0-9a-f]+@example\.com$/);
  assert.equal(hub.records[0]!.properties.jobtitle, "Head of Checks");
});

test("a token without write access fails clearly and does not run the later steps", async () => {
  const hub = fakeHubspot([], { forbidWrites: true });
  const report = await runHubspotCheck({ token: "t", fetchImpl: hub.fetchImpl as never });
  assert.equal(report.ok, false);
  const failed = report.steps.find((s) => !s.ok)!;
  assert.equal(failed.name, "approve: contact is created, with a note");
  assert.match(failed.detail, /does not have write access/);
  assert.match(failed.detail, /HubSpot says: forbidden/, "HubSpot's own message is kept");
  assert.equal(report.steps.length, 4, "stops after the failed approval");
  assert.equal(hub.records.length, 0);
});
