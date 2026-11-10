# One-line agent setup

Users tell their agent `set up gtm-router — https://<host>/llms.txt`. The agent reads that file,
installs the `gtm` CLI, signs in with a token and connects to the MCP server. The MCP server and
router are unchanged; this adds the front door.

## Operator steps (once)

1. Fill `.env` with provider keys (see `.env.example`).
2. Start the server: `npm run mcp`
3. Expose it over HTTPS, keeping the loopback Host header:
   `ngrok http 3333 --host-header=rewrite`
4. Put the ngrok URL in `.env` as `PUBLIC_URL=https://<id>.ngrok-free.app` and restart.
   (ngrok URLs change on restart; update `PUBLIC_URL` each time.)
5. Let users get tokens, either way:
   - Self-serve: set `SIGNUP_ENABLED=true` and users get a token at `https://<host>/signup`.
     Optional `SIGNUP_CODE` requires an invite code; `SIGNUP_PER_HOUR` (default 20) caps sign-ups.
     There is no email check, so keep an invite code on if the URL is public.
   - By hand: `npm run token -- create alice`. It prints once.
   `npm run token -- list` and `npm run token -- revoke <name>` manage both kinds (sign-up names
   look like `jo_at_acme.com`).

Once `data/tokens.json` exists, `/mcp` and `/whoami` require a token. Revoking every token keeps
auth on (nobody gets in). Delete the file only to turn auth off.

## User steps

The user gets a token at `https://<host>/signup` (or from you), then tells their agent:

```
set up gtm-router — https://<host>/llms.txt
```

Manual equivalent:

```bash
npm i -g outmate                     # or prefix each line with: npx -y outmate
gtm login --url https://<host> --token <token>
gtm connect                          # Claude Code, Cursor, Codex, VS Code, Gemini CLI, opencode, Windsurf
gtm                                  # status
gtm search "Find engineering leaders at vercel.com"
```

Without npm, `curl -fsSL https://<host>/install.sh | sh` installs the same CLI into `~/.gtm/bin`.

`gtm connect` writes config only for agents it finds (`--agent <name>` picks one), keeps the
other entries in each file, and leaves token-bearing files readable only by the user. For Claude
Code and Codex it also installs `/skill.md` as a skill.

## The npm package

The CLI is published as [`outmate`](https://www.npmjs.com/package/outmate) from `packages/cli/`.
It ships one file, `gtm.mjs`, copied from `src/public/setup/gtm.mjs` at pack time, so the npm
CLI and the served CLI are always the same code. No dependencies, Node 18+.

```bash
cd packages/cli
npm publish --dry-run      # lists exactly what ships
npm publish                # needs `npm login` with 2FA on the publishing machine
```

Bump `version` in `packages/cli/package.json` and `VERSION` in `gtm.mjs` together.

## Routes

| Route | Auth | Purpose |
|---|---|---|
| `GET /llms.txt` | none | Setup instructions for agents |
| `GET /skill.md` | none | How to use `gtm_search` |
| `GET /install.sh` | none | Installs the CLI into `~/.gtm/bin` |
| `GET /gtm.mjs` | none | The CLI (single file) |
| `GET/POST /signup` | none | Self-serve token page (only when `SIGNUP_ENABLED=true`) |
| `GET /whoami` | token | Checks a token, lists configured providers |
| `POST /mcp` | token | The MCP server |

The four setup files are templates; `{{HOST}}` is replaced per request. `PUBLIC_URL` wins. Without
it the host is taken from `X-Forwarded-Host` or `Host` and must be a plain `host[:port]`.

## Test without providers

```bash
npm test                          # unit + synthetic end-to-end (fake LLM, fake provider, fake claude)
npx tsx --test tests/gtm-cli.test.ts   # only the install -> login -> connect -> search workflow
```
