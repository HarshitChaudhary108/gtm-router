import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authenticate, type TokenStore } from "./auth.js";
import { providerStatus, type Config } from "./config.js";

/** Public setup assets. They contain `{{HOST}}`, replaced per request with the public base URL. */
const ASSETS: Record<string, { file: string; type: string }> = {
  "/llms.txt": { file: "setup/llms.txt", type: "text/plain" },
  "/skill.md": { file: "setup/skill.md", type: "text/markdown" },
  "/install.sh": { file: "setup/install.sh", type: "text/x-shellscript" },
  "/outmate.mjs": { file: "setup/outmate.mjs", type: "text/javascript" },
};

// Strict on purpose: the host is written into a shell script, so only host[:port] is accepted.
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim() || undefined;

/**
 * Public base URL used in the setup files. PUBLIC_URL wins. Otherwise it is built from the
 * forwarded or Host header and validated. Returns null when nothing safe can be built.
 */
export function baseUrl(req: IncomingMessage, config: Pick<Config, "publicUrl">): string | null {
  if (config.publicUrl) {
    try {
      const url = new URL(config.publicUrl);
      return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
      return null;
    }
  }
  const host = firstValue(req.headers["x-forwarded-host"]) ?? firstValue(req.headers.host);
  if (!host || !HOST_RE.test(host)) return null;
  const proto = firstValue(req.headers["x-forwarded-proto"]) === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

export interface SetupDeps {
  config: Config;
  tokens?: TokenStore;
}

/** Serves the setup files and /whoami. Returns false when the path is not one of ours. */
export async function serveSetup(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  deps: SetupDeps,
): Promise<boolean> {
  const isWhoami = path === "/whoami";
  const asset = ASSETS[path];
  if (!isWhoami && !asset) return false;

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    send(res, 405, "text/plain", "Use GET\n");
    return true;
  }

  if (isWhoami) {
    const identity = authenticate(req, { legacyToken: deps.config.mcpAuthToken, store: deps.tokens });
    if (!identity) {
      send(res, 401, "application/json", JSON.stringify({ status: "error", error: "Unauthorized" }));
      return true;
    }
    send(
      res,
      200,
      "application/json",
      JSON.stringify({ status: "ok", name: identity.name, endpoint: "/mcp", providers: providerStatus(deps.config) }),
    );
    return true;
  }

  const base = baseUrl(req, deps.config);
  if (!base) {
    send(res, 400, "text/plain", "Cannot work out a safe public URL. Set PUBLIC_URL on the server.\n");
    return true;
  }
  try {
    const template = await readFile(new URL(`./public/${asset!.file}`, import.meta.url), "utf8");
    send(res, 200, asset!.type, template.replaceAll("{{HOST}}", base));
  } catch {
    send(res, 404, "text/plain", "Not found\n");
  }
  return true;
}
