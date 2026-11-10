# outmate

The `gtm` command connects your coding agent to a gtm-router server, which gives the agent one
MCP tool, `gtm_search`, for company, people, business email and web research. Provider keys stay
on the server; you only hold a gtm-router token from your admin.

## Quick start

Tell your agent:

```
set up gtm-router — https://<your-server>/llms.txt
```

Or by hand:

```bash
npm i -g outmate
gtm login --url https://<your-server> --token <token>
gtm connect
gtm
gtm search "Find engineering leaders at vercel.com"
```

No global install? Use `npx -y outmate` in place of `gtm`.

## Commands

| Command | What it does |
|---|---|
| `gtm login --url <server> --token <token>` | Checks the token against the server and saves it (readable only by you) |
| `gtm connect [--agent <name>]` | Adds the MCP server to every agent it finds, and the skill for Claude Code and Codex |
| `gtm` | Shows who is signed in and which providers are on |
| `gtm search "<question>"` | Runs `gtm_search` from the terminal |
| `gtm logout` | Deletes the saved token |

Agents: `claude`, `cursor`, `codex`, `vscode`, `gemini`, `opencode`, `windsurf`.

Node.js 18 or newer. One file, no dependencies. Update with `npm update -g outmate`.
