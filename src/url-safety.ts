import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AppError } from "./errors.js";

export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".test", ".invalid", ".onion"];

function privateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function privateIPv6(ip: string): boolean {
  const h = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
  if (h.startsWith("::ffff:")) return privateIPv4(h.slice(7));
  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return privateIPv4(address);
  if (family === 6) return privateIPv6(address);
  return true;
}

/**
 * Synchronous gate: scheme, credentials, local/private literals, obvious internal hostnames.
 * DNS is checked separately because Jina resolves the URL server-side.
 */
export function assertPublicHttpUrl(raw: unknown): URL {
  if (typeof raw !== "string") throw new AppError("E_BAD_URL", "url must be a string");
  const candidate = raw.trim();
  if (candidate.length === 0) throw new AppError("E_BAD_URL", "url must not be empty");
  if (candidate.length > 2048) throw new AppError("E_BAD_URL", "url must be 2048 characters or fewer");

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new AppError("E_BAD_URL", "url must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("E_BAD_URL", "Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw new AppError("E_BAD_URL", "URLs with embedded credentials are not supported");
  }

  // URL.hostname keeps the brackets on IPv6 literals; strip them for net.isIP.
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) throw new AppError("E_BAD_URL", "url must include a hostname");

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new AppError("E_BAD_URL", "Private, loopback and link-local addresses are not allowed");
    return url;
  }

  if (host === "localhost" || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new AppError("E_BAD_URL", "Local and internal hostnames are not allowed");
  }
  if (!host.includes(".")) {
    throw new AppError("E_BAD_URL", "url must point to a public domain");
  }
  return url;
}

const defaultLookup: LookupFn = async (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Full gate used before calling Jina: also rejects hostnames that resolve to private addresses. */
export async function assertResolvablePublicUrl(raw: unknown, lookup: LookupFn = defaultLookup): Promise<URL> {
  const url = assertPublicHttpUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return url;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host);
  } catch {
    throw new AppError("E_BAD_URL", `Could not resolve hostname "${host}"`);
  }
  if (addresses.length === 0) throw new AppError("E_BAD_URL", `Could not resolve hostname "${host}"`);
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new AppError("E_BAD_URL", "Hostname resolves to a private or loopback address");
  }
  return url;
}
