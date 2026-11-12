import { AppError } from "./errors.js";
import { fetchWithRetry, readJsonBody, type FetchLike } from "./http.js";
import type { Change } from "./proposals.js";
import { isRecord } from "./util.js";

/**
 * Writing contacts to HubSpot, in two separate steps:
 *   buildChanges  reads HubSpot and works out what WOULD change (no writes)
 *   applyChanges  writes exactly that, after the user approved it
 * Both use the user's own HubSpot login. Existing values are never overwritten.
 */

const API = "https://api.hubapi.com";
export const CONTACT_FIELDS = ["firstname", "lastname", "email", "jobtitle", "company", "phone"] as const;
const MAX_CONTACTS = 10;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
// HubSpot's built-in association: note -> contact.
const NOTE_TO_CONTACT = 202;

export type ContactProps = Record<string, string>;

export interface HubspotDeps {
  token: string;
  fetchImpl?: FetchLike;
  timeoutMs: number;
  retryDelayMs?: number;
}

const blank = (v: unknown): boolean => v === undefined || v === null || String(v).trim() === "";
const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Check what the model wants to add. Only known fields, plain text, and enough to identify a person. */
export function normalizeContacts(raw: unknown): ContactProps[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new AppError("E_VALIDATION", "contacts must be a non-empty list");
  if (raw.length > MAX_CONTACTS) throw new AppError("E_VALIDATION", `at most ${MAX_CONTACTS} contacts per proposal`);
  const seen = new Set<string>();
  const out: ContactProps[] = [];
  raw.forEach((item, i) => {
    const at = `contacts[${i}]`;
    if (!isRecord(item)) throw new AppError("E_VALIDATION", `${at} must be an object`);
    const props: ContactProps = {};
    for (const [key, value] of Object.entries(item)) {
      if (!(CONTACT_FIELDS as readonly string[]).includes(key)) throw new AppError("E_VALIDATION", `${at}: unknown field "${key}"`);
      if (value === undefined || value === null || value === "") continue;
      if (typeof value !== "string") throw new AppError("E_VALIDATION", `${at}.${key} must be text`);
      const text = value.trim();
      if (/[\u0000-\u001f\u007f]/.test(text)) throw new AppError("E_VALIDATION", `${at}.${key} has control characters`);
      if (text.length > 200) throw new AppError("E_VALIDATION", `${at}.${key} is too long`);
      if (text) props[key] = key === "email" ? text.toLowerCase() : text;
    }
    if (props.email && !EMAIL_RE.test(props.email)) throw new AppError("E_VALIDATION", `${at}.email is not a valid address`);
    if (!props.email && !(props.firstname && props.lastname)) {
      throw new AppError("E_VALIDATION", `${at} needs an email, or both firstname and lastname`);
    }
    const id = props.email ?? `${props.firstname} ${props.lastname}`.toLowerCase();
    if (seen.has(id)) throw new AppError("E_VALIDATION", `${at} repeats an earlier contact`);
    seen.add(id);
    out.push(props);
  });
  return out;
}

const labelOf = (p: ContactProps): string => `${p.firstname ?? ""} ${p.lastname ?? ""}`.trim() || p.email || "contact";

function upstreamError(status: number, write: boolean): AppError {
  if (status === 401) return new AppError("E_PROVIDER_AUTH", "HubSpot rejected the login. Reconnect HubSpot on the Connections page.");
  if (status === 403) {
    return new AppError(
      "E_PROVIDER_AUTH",
      write
        ? "HubSpot refused the write: the connected login does not have write access to contacts."
        : "HubSpot refused the request: the connected login lacks read access to contacts.",
    );
  }
  if (status === 429) return new AppError("E_RATE_LIMIT", "HubSpot rate limit reached (HTTP 429)", { retryable: true });
  if (status >= 500) return new AppError("E_PROVIDER", `HubSpot is unavailable (HTTP ${status})`, { retryable: true });
  return new AppError("E_PROVIDER", `HubSpot request failed (HTTP ${status})`);
}

/** The error for a failed response. For 401 and 403 it adds HubSpot's own message, which names the missing scope. */
async function failure(res: Response, write: boolean): Promise<AppError> {
  const base = upstreamError(res.status, write);
  if (res.status !== 401 && res.status !== 403) return base;
  try {
    const body: unknown = JSON.parse(await res.text());
    if (isRecord(body) && typeof body.message === "string") {
      return new AppError(base.code, `${base.message} HubSpot says: ${body.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200)}`);
    }
  } catch {
    // No readable body: the plain message is enough.
  }
  return base;
}

async function hs(path: string, init: RequestInit, deps: HubspotDeps, write: boolean): Promise<Response> {
  return fetchWithRetry(
    `${API}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${deps.token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    },
    // A write is never retried: a retry after a timeout could create the same contact twice.
    { fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, retryDelayMs: deps.retryDelayMs, maxRetries: write ? 0 : 1 },
  );
}

async function hsJson<T>(path: string, init: RequestInit, deps: HubspotDeps, write = false): Promise<T> {
  const res = await hs(path, init, deps, write);
  if (!res.ok) throw await failure(res, write);
  return (await readJsonBody(res, "HubSpot")) as T;
}

interface Found {
  id: string;
  props: Record<string, unknown>;
}

async function search(body: Record<string, unknown>, deps: HubspotDeps): Promise<Found[]> {
  const data = await hsJson<{ results?: unknown }>(
    "/crm/v3/objects/contacts/search",
    { method: "POST", body: JSON.stringify({ properties: [...CONTACT_FIELDS], limit: 10, ...body }) },
    deps,
  );
  const out: Found[] = [];
  for (const r of Array.isArray(data.results) ? data.results : []) {
    if (isRecord(r) && typeof r.id === "string") out.push({ id: r.id, props: isRecord(r.properties) ? r.properties : {} });
  }
  return out;
}

type Existing = { kind: "none" } | { kind: "one"; found: Found; byEmail: boolean } | { kind: "other-email"; found: Found } | { kind: "many" };

async function findExisting(want: ContactProps, deps: HubspotDeps): Promise<Existing> {
  if (want.email) {
    const byEmail = await search(
      { filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: want.email }] }], limit: 2 },
      deps,
    );
    if (byEmail[0]) return { kind: "one", found: byEmail[0], byEmail: true };
  }
  if (!want.firstname || !want.lastname) return { kind: "none" };
  const candidates = (await search({ query: `${want.firstname} ${want.lastname}` }, deps)).filter(
    (f) =>
      same(String(f.props.firstname ?? ""), want.firstname!) &&
      same(String(f.props.lastname ?? ""), want.lastname!) &&
      (!want.company || blank(f.props.company) || same(String(f.props.company), want.company)),
  );
  if (candidates.length > 1) return { kind: "many" };
  const only = candidates[0];
  if (!only) return { kind: "none" };
  // Same name but a different email on file: probably the same person, so do not add a second one.
  if (want.email && !blank(only.props.email) && !same(String(only.props.email), want.email)) return { kind: "other-email", found: only };
  return { kind: "one", found: only, byEmail: false };
}

/** Read HubSpot and work out what would change. Writes nothing. */
export async function buildChanges(contacts: ContactProps[], deps: HubspotDeps): Promise<Change[]> {
  const changes: Change[] = [];
  for (const want of contacts) {
    const label = labelOf(want);
    const existing = await findExisting(want, deps);

    if (existing.kind === "none") {
      changes.push({ kind: "create", label, properties: want });
    } else if (existing.kind === "many") {
      changes.push({ kind: "skip", label, properties: {}, reason: "several contacts in HubSpot match this name; check by hand" });
    } else if (existing.kind === "other-email") {
      changes.push({
        kind: "skip", label, properties: {},
        reason: `HubSpot already has this name with another email (${String(existing.found.props.email)}); check by hand`,
      });
    } else {
      const { found } = existing;
      const fills: ContactProps = {};
      const kept: ContactProps = {};
      for (const [key, value] of Object.entries(want)) {
        const have = found.props[key];
        if (blank(have)) fills[key] = value;
        else if (!same(String(have), value)) kept[key] = String(have);
      }
      if (Object.keys(fills).length === 0) {
        changes.push({
          kind: "skip", label, properties: {}, recordId: found.id, kept,
          reason: Object.keys(kept).length ? "already in HubSpot; existing values are kept" : "already in HubSpot and complete",
        });
      } else {
        changes.push({ kind: "fill", label, recordId: found.id, properties: fills, kept });
      }
    }
  }
  return changes;
}

export interface ApplyResult {
  label: string;
  outcome: "created" | "filled" | "unchanged" | "failed" | "not tried";
  detail?: string;
  note?: boolean;
}

async function addNote(recordId: string, text: string, deps: HubspotDeps): Promise<boolean> {
  try {
    await hsJson(
      "/crm/v3/objects/notes",
      {
        method: "POST",
        body: JSON.stringify({
          properties: { hs_timestamp: new Date().toISOString(), hs_note_body: text.slice(0, 1000) },
          associations: [{ to: { id: recordId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: NOTE_TO_CONTACT }] }],
        }),
      },
      deps,
      true,
    );
    return true;
  } catch {
    return false; // The note is a courtesy: a failure must not undo or hide the real change.
  }
}

/** Write the approved changes. Fills re-check HubSpot first, so a value added since is never overwritten. */
export async function applyChanges(
  changes: Change[],
  meta: { user: string; sources: string },
  deps: HubspotDeps,
): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const noteText = `Added by outmate for ${meta.user} on ${new Date().toISOString().slice(0, 10)}. Sources: ${meta.sources || "not given"}.`;
  let stop: AppError | null = null;

  for (const change of changes) {
    if (change.kind === "skip") {
      results.push({ label: change.label, outcome: "unchanged", detail: change.reason });
      continue;
    }
    if (stop) {
      results.push({ label: change.label, outcome: "not tried", detail: stop.message });
      continue;
    }
    try {
      if (change.kind === "create") {
        const res = await hs("/crm/v3/objects/contacts", { method: "POST", body: JSON.stringify({ properties: change.properties }) }, deps, true);
        if (res.status === 409) {
          results.push({ label: change.label, outcome: "unchanged", detail: "it was added to HubSpot in the meantime" });
          continue;
        }
        if (!res.ok) throw await failure(res, true);
        const body = await readJsonBody(res, "HubSpot");
        const id = isRecord(body) && typeof body.id === "string" ? body.id : "";
        results.push({ label: change.label, outcome: "created", note: id ? await addNote(id, noteText, deps) : false });
      } else {
        const id = change.recordId!;
        const now = await hsJson<{ properties?: unknown }>(
          `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${CONTACT_FIELDS.join(",")}`,
          { method: "GET" },
          deps,
        );
        const have = isRecord(now.properties) ? now.properties : {};
        const stillBlank = Object.fromEntries(Object.entries(change.properties).filter(([k]) => blank(have[k])));
        if (Object.keys(stillBlank).length === 0) {
          results.push({ label: change.label, outcome: "unchanged", detail: "the fields were filled in HubSpot in the meantime" });
          continue;
        }
        await hsJson(`/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ properties: stillBlank }) }, deps, true);
        results.push({ label: change.label, outcome: "filled", detail: Object.keys(stillBlank).join(", "), note: await addNote(id, noteText, deps) });
      }
    } catch (err) {
      const error = err instanceof AppError ? err : new AppError("E_PROVIDER", "HubSpot write failed");
      results.push({ label: change.label, outcome: "failed", detail: error.message });
      if (error.code === "E_PROVIDER_AUTH") stop = error; // every other write would fail the same way
    }
  }
  return results;
}

export function summarize(results: ApplyResult[]): string {
  const n = (o: ApplyResult["outcome"]): number => results.filter((r) => r.outcome === o).length;
  return `${n("created")} created, ${n("filled")} filled, ${n("unchanged")} unchanged, ${n("failed") + n("not tried")} not done`;
}
