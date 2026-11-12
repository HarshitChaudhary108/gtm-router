import { AppError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { applyChanges, buildChanges, normalizeContacts, summarize } from "./hubspot-write.js";
import { ProposalStore, renderProposal, type Proposal } from "./proposals.js";
import { isRecord } from "./util.js";

/**
 * Write-back to a user's CRM, always in two steps:
 *   1. the router calls a "propose" tool: the server reads the CRM, stores what WOULD change, writes nothing
 *   2. the user approves, and the agent sends `apply <id>`: the server writes exactly the stored changes
 * The second step never goes through the model.
 */

export interface WritebackDeps {
  /** The user's HubSpot login (the `hubspot-write` slot). */
  apiKey?: string;
  /** Who is asking. Proposals belong to one user. */
  user?: string;
  store?: ProposalStore;
  /** Told about every proposal made during this request, so the server can show it verbatim. */
  onProposal?: (p: Proposal) => void;
  fetchImpl?: FetchLike;
  timeoutMs: number;
  retryDelayMs?: number;
}

function ready(deps: WritebackDeps): { token: string; user: string; store: ProposalStore } {
  if (!deps.apiKey) throw new AppError("E_CONFIG", "No HubSpot write connection for this user. Add it on the Connections page.");
  if (!deps.user || !deps.store) throw new AppError("E_INTERNAL", "Proposals are not available on this server");
  return { token: deps.apiKey, user: deps.user, store: deps.store };
}

/** Run a tool whose logic lives in code (kind "internal"). */
export async function runInternalTool(handler: string, rawInput: unknown, deps: WritebackDeps): Promise<unknown> {
  if (handler !== "hubspot_propose_contacts") throw new AppError("E_ROUTING", `Unknown handler "${handler}"`);
  const { token, user, store } = ready(deps);
  if (!isRecord(rawInput)) throw new AppError("E_VALIDATION", "input must be an object");
  for (const key of Object.keys(rawInput)) {
    if (key !== "contacts" && key !== "source_note") throw new AppError("E_VALIDATION", `unknown input "${key}"`);
  }
  const contacts = normalizeContacts(rawInput.contacts);
  const sources =
    typeof rawInput.source_note === "string" ? rawInput.source_note.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 300) : "";

  const changes = await buildChanges(contacts, { token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, retryDelayMs: deps.retryDelayMs });
  const proposal = store.create(user, changes, sources);
  deps.onProposal?.(proposal);
  return {
    status: "proposed",
    written: false,
    proposal_id: proposal.id,
    changes: renderProposal(proposal),
    next: "Nothing has been written. The user sees these exact changes and must approve them before anything is sent.",
  };
}

const APPLY_RE = /^\s*(?:yes[\s,.!:;-]*)?apply\s+(p_[0-9a-f]{10})\s*[.!]?\s*$/i;

/** `apply p_xxxxxxxxxx` (optionally prefixed with "yes"), and nothing else, is an approval. */
export function parseApply(query: string): string | null {
  const m = APPLY_RE.exec(query);
  return m ? m[1]!.toLowerCase() : null;
}

/** Write a stored proposal. Only its owner can apply it, once, before it expires. */
export async function applyApproved(id: string, deps: WritebackDeps): Promise<{ ok: boolean; text: string }> {
  const { token, user, store } = ready(deps);
  const taken = store.take(user, id);
  if (!taken.ok) {
    return {
      ok: false,
      text:
        taken.reason === "expired"
          ? `Proposal ${id} has expired, so nothing was written. Ask for the changes again.`
          : `There is no pending proposal ${id} for you (it may have been applied already). Nothing was written.`,
    };
  }
  const { proposal } = taken;
  const results = await applyChanges(proposal.changes, { user, sources: proposal.sources }, {
    token, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs, retryDelayMs: deps.retryDelayMs,
  });

  const wrote = results.some((r) => r.outcome === "created" || r.outcome === "filled");
  const failed = results.some((r) => r.outcome === "failed" || r.outcome === "not tried");
  // Nothing went out (for example the login lacked write access): keep the proposal so it can be retried.
  if (!wrote && failed) store.restore(proposal);

  const lines = [`Applied ${proposal.id}: ${summarize(results)}.`];
  for (const r of results) {
    const extra = [r.detail, r.note === false ? "note could not be added" : ""].filter(Boolean).join("; ");
    lines.push(`- ${r.label}: ${r.outcome}${extra ? ` (${extra})` : ""}`);
  }
  if (!wrote && failed) lines.push("Nothing was written. The proposal is still valid, so you can fix the problem and approve it again.");
  return { ok: wrote || !failed, text: lines.join("\n") };
}
