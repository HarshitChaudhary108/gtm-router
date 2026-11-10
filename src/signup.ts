import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { TokenStore } from "./auth.js";
import type { Config } from "./config.js";
import { baseUrl } from "./setup.js";

/**
 * Self-serve sign-up: GET /signup shows a form, POST /signup creates a token for an email and
 * shows it once. Off unless SIGNUP_ENABLED=true. There is no email verification, so the guards
 * are: an optional invite code (SIGNUP_CODE), one token per email, and a global hourly cap.
 */

const MAX_BODY = 4 * 1024;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export interface SignupDeps {
  config: Pick<Config, "signupEnabled" | "signupCode" | "signupPerHour" | "publicUrl">;
  tokens?: TokenStore;
  now?: () => number;
}

/** Token name for an email: "jo@acme.com" -> "jo_at_acme.com". Fits the store's name rules. */
export function nameForEmail(email: string): string | null {
  const normalized = email.trim().toLowerCase();
  if (normalized.length > 254 || !EMAIL_RE.test(normalized)) return null;
  const name = normalized.replace("@", "_at_").replace(/[^a-z0-9._-]/g, "-");
  return name.length <= 64 ? name : null;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const STYLE = `
:root{--bg:#f7f7f5;--card:#fff;--text:#1a1a1a;--muted:#6b6b6b;--line:#e3e3df;--accent:#1a1a1a;--accent-text:#fff;--code:#f1f1ee;--err:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--text:#f0f0f0;--muted:#9a9a9a;--line:#2e2e2e;--accent:#f0f0f0;--accent-text:#121212;--code:#262626;--err:#ff8a7a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
main{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:32px;width:100%;max-width:460px}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 18px;color:var(--muted)}label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font-size:16px}
button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-text);font-size:16px;font-weight:600;cursor:pointer}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}pre{background:var(--code);border-radius:8px;padding:12px;white-space:pre-wrap;word-break:break-all;margin:0}
.err{color:var(--err);margin:12px 0 0}.step{margin:18px 0 6px;font-weight:600;font-size:14px}.note{font-size:13px;margin-top:18px}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function formPage(needsCode: boolean, error?: string, email = ""): string {
  return page(
    "gtm-router sign up",
    `<h1>Get your gtm-router token</h1>
<p>Company, people and web research for your coding agent. Provider keys stay on our server.</p>
<form method="post" action="/signup">
<label for="email">Work email</label>
<input id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(email)}">
${needsCode ? `<label for="code">Invite code</label><input id="code" name="code" required autocomplete="off">` : ""}
<button type="submit">Get token</button>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
</form>`,
  );
}

function tokenPage(token: string, host: string): string {
  const line = `set up gtm-router — ${host}/llms.txt`;
  return page(
    "Your gtm-router token",
    `<h1>You're in</h1>
<p>Copy your token now. It is shown only once.</p>
<div class="step">1. Your token</div>
<pre id="token">${escapeHtml(token)}</pre>
<button type="button" onclick="navigator.clipboard.writeText(document.getElementById('token').textContent);this.textContent='Copied'">Copy token</button>
<div class="step">2. Tell your agent (Claude Code, Cursor, Codex…)</div>
<pre>${escapeHtml(line)}</pre>
<p class="note">Paste the token when your agent asks for it.</p>`,
  );
}

function send(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'",
  });
  res.end(html);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

/** Returns a handler that serves /signup and returns false for any other path. */
export function createSignup(deps: SignupDeps) {
  const now = deps.now ?? Date.now;
  let recent: number[] = [];

  return async (req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> => {
    if (path !== "/signup") return false;
    const { config, tokens } = deps;

    if (!config.signupEnabled || !tokens) {
      send(res, 404, page("Not available", "<h1>Sign-up is closed</h1><p>Ask the team for an invite.</p>"));
      return true;
    }
    const needsCode = Boolean(config.signupCode);

    if (req.method === "GET") {
      send(res, 200, formPage(needsCode));
      return true;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      send(res, 405, page("Not allowed", "<h1>Use the form</h1>"));
      return true;
    }

    const form = await readForm(req);
    if (!form) {
      send(res, 413, formPage(needsCode, "Request too large."));
      return true;
    }
    const email = (form.get("email") ?? "").trim();
    const name = nameForEmail(email);
    if (!name) {
      send(res, 400, formPage(needsCode, "Enter a valid work email.", email));
      return true;
    }
    if (needsCode && !sameText(form.get("code") ?? "", config.signupCode!)) {
      send(res, 403, formPage(needsCode, "That invite code is not valid.", email));
      return true;
    }

    const hourAgo = now() - 60 * 60 * 1000;
    recent = recent.filter((t) => t > hourAgo);
    if (recent.length >= config.signupPerHour) {
      send(res, 429, formPage(needsCode, "Too many sign-ups right now. Try again in an hour.", email));
      return true;
    }

    const host = baseUrl(req, config);
    if (!host) {
      send(res, 500, formPage(needsCode, "The server's public URL is not set. Tell the team."));
      return true;
    }

    let token: string;
    try {
      token = tokens.create(name).token;
    } catch (err) {
      const exists = err instanceof Error && /already exists/.test(err.message);
      send(
        res,
        exists ? 409 : 500,
        formPage(needsCode, exists ? "This email already has a token. Ask the team to reset it." : "Could not create a token.", email),
      );
      return true;
    }
    recent.push(now());
    console.error(`signup: token created for "${name}"`);
    send(res, 201, tokenPage(token, host));
    return true;
  };
}
