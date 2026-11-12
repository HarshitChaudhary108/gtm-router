import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

export interface TokenRecord {
  name: string;
  hash: string;
  created_at: string;
}

export interface Identity {
  name: string;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * File-backed bearer tokens. Only SHA-256 hashes are stored, so the file alone cannot be used to
 * call the API. The file's existence turns authentication on: an empty or unreadable file denies
 * everyone instead of opening the server.
 */
export class TokenStore {
  constructor(private readonly file: string) {}

  exists(): boolean {
    return existsSync(this.file);
  }

  list(): TokenRecord[] {
    if (!this.exists()) return [];
    const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
    const tokens = (parsed as { tokens?: unknown }).tokens;
    if (!Array.isArray(tokens)) throw new Error(`${this.file} is not a valid token file`);
    return tokens.filter(
      (t): t is TokenRecord =>
        typeof t?.name === "string" && typeof t?.hash === "string" && typeof t?.created_at === "string",
    );
  }

  /** Returns the plaintext token once. It cannot be recovered later. */
  create(name: string): { token: string; record: TokenRecord } {
    if (!NAME_RE.test(name)) throw new Error("Name must be 1-64 chars: letters, digits, dot, dash, underscore");
    const records = this.list();
    if (records.some((r) => r.name === name)) throw new Error(`Token "${name}" already exists`);
    const token = `outmate_${randomBytes(32).toString("base64url")}`;
    const record: TokenRecord = { name, hash: sha256(token), created_at: new Date().toISOString() };
    this.save([...records, record]);
    return { token, record };
  }

  revoke(name: string): boolean {
    const records = this.list();
    const kept = records.filter((r) => r.name !== name);
    if (kept.length === records.length) return false;
    this.save(kept);
    return true;
  }

  /** Fail closed: any read or parse problem means "no match". */
  verify(token: string): Identity | undefined {
    let records: TokenRecord[];
    try {
      records = this.list();
    } catch {
      return undefined;
    }
    const hash = sha256(token);
    let found: Identity | undefined;
    for (const record of records) {
      if (safeEqual(record.hash, hash)) found = { name: record.name };
    }
    return found;
  }

  private save(records: TokenRecord[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ tokens: records }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

export function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  return header.slice(7).trim() || undefined;
}

export interface AuthOptions {
  /** Single shared token from MCP_AUTH_TOKEN (kept for backward compatibility). */
  legacyToken?: string;
  store?: TokenStore;
}

export function authRequired(options: AuthOptions): boolean {
  return Boolean(options.legacyToken) || Boolean(options.store?.exists());
}

/** Returns the caller identity, or null when a token is required and missing or wrong. */
export function authenticate(req: IncomingMessage, options: AuthOptions): Identity | null {
  if (!authRequired(options)) return { name: "open" };
  const token = bearerOf(req);
  if (!token) return null;
  if (options.legacyToken && safeEqual(token, options.legacyToken)) return { name: "legacy" };
  return options.store?.verify(token) ?? null;
}
