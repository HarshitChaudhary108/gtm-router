import { randomBytes } from "node:crypto";

/**
 * A proposal is a set of changes the router has worked out but NOT sent. It sits here until the
 * user who asked for it approves it. What gets written is exactly what is stored, never something
 * the model re-plans at approval time.
 */

export type ChangeKind = "create" | "fill" | "skip";

export interface Change {
  kind: ChangeKind;
  /** Short text for the user, e.g. "Mike Curtis". */
  label: string;
  /** create: every property to set. fill: only the properties that are blank in HubSpot right now. */
  properties: Record<string, string>;
  /** fill: the HubSpot record to update. */
  recordId?: string;
  /** fill: properties HubSpot already has a value for, left alone. */
  kept?: Record<string, string>;
  /** skip: why nothing will happen. */
  reason?: string;
}

export interface Proposal {
  id: string;
  user: string;
  createdAt: number;
  expiresAt: number;
  changes: Change[];
  /** Where the data came from, written into the note on each record. */
  sources: string;
}

export type TakeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: "missing" | "expired" };

const TTL_MS = 15 * 60_000;
const MAX_LIVE_PER_USER = 20;
const ID_RE = /^p_[0-9a-f]{10}$/;

export const isProposalId = (id: string): boolean => ID_RE.test(id);

export class ProposalStore {
  private readonly items = new Map<string, Proposal>();

  constructor(
    private readonly ttlMs: number = TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  private purge(): void {
    const t = this.now();
    for (const [id, p] of this.items) if (p.expiresAt <= t) this.items.delete(id);
  }

  create(user: string, changes: Change[], sources: string): Proposal {
    this.purge();
    const mine = [...this.items.values()].filter((p) => p.user === user).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= MAX_LIVE_PER_USER) this.items.delete(mine.shift()!.id);
    const createdAt = this.now();
    const proposal: Proposal = {
      id: `p_${randomBytes(5).toString("hex")}`,
      user,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      changes,
      sources,
    };
    this.items.set(proposal.id, proposal);
    return proposal;
  }

  /**
   * Remove and return a proposal for its owner. One use only: an approved proposal cannot be applied
   * twice, and another user's proposal looks exactly like one that does not exist.
   */
  take(user: string, id: string): TakeResult {
    const found = this.items.get(id);
    if (!found || found.user !== user) return { ok: false, reason: "missing" };
    this.items.delete(id);
    if (found.expiresAt <= this.now()) return { ok: false, reason: "expired" };
    return { ok: true, proposal: found };
  }

  /** Put a proposal back, e.g. when applying failed before anything was sent. */
  restore(proposal: Proposal): void {
    this.items.set(proposal.id, proposal);
  }
}

const clean = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);

const FIELD_LABEL: Record<string, string> = {
  firstname: "first name",
  lastname: "last name",
  email: "email",
  jobtitle: "job title",
  company: "company",
  phone: "phone",
};

/**
 * The text the user approves. Written by the server from the stored changes, so it cannot be
 * reworded by the model, and it always says that nothing has been written yet.
 */
export function renderProposal(p: Proposal, nowMs: number = Date.now()): string {
  const minutes = Math.max(1, Math.round((p.expiresAt - nowMs) / 60_000));
  const lines = [
    `HubSpot changes proposed (id ${p.id}). NOTHING HAS BEEN WRITTEN YET.`,
  ];
  p.changes.forEach((c, i) => {
    const n = `${i + 1}.`;
    if (c.kind === "create") {
      const parts = Object.entries(c.properties).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: ${clean(v)}`);
      lines.push(`${n} CREATE contact ${clean(c.label)} — ${parts.join(" · ")}`);
    } else if (c.kind === "fill") {
      const parts = Object.entries(c.properties).map(([k, v]) => `${FIELD_LABEL[k] ?? k}: (empty) → ${clean(v)}`);
      const kept = Object.entries(c.kept ?? {}).map(([k, v]) => `keeps ${FIELD_LABEL[k] ?? k} "${clean(v)}"`);
      lines.push(`${n} FILL BLANKS on ${clean(c.label)} — ${[...parts, ...kept].join(" · ")}`);
    } else {
      const kept = Object.entries(c.kept ?? {}).map(([k, v]) => `keeps ${FIELD_LABEL[k] ?? k} "${clean(v)}"`);
      lines.push(`${n} SKIP ${clean(c.label)} — ${[clean(c.reason ?? "nothing to change"), ...kept].join(" · ")}`);
    }
  });
  const todo = p.changes.filter((c) => c.kind !== "skip").length;
  lines.push(
    todo === 0
      ? "Nothing to apply."
      : `To apply: ask the user to approve these exact changes, then call outmate_search with the query exactly: apply ${p.id}` +
          ` (valid for about ${minutes} minute${minutes === 1 ? "" : "s"}, one use). Existing values are never overwritten. A note is added to each record.`,
  );
  return lines.join("\n");
}
