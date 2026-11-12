# Founder demo: outmate in Claude Code

What the video shows: a user starts with nothing, types one line into Claude Code, signs in with a
token, and a few seconds later asks a research question and gets real people back.

Length: about 3 minutes. One take, with an optional cut while the session restarts.

---

## 0. Before you record (blocking)

Today a search fails. Every provider key in `.env` is empty, not only the LLM ones.

1. Fill `.env` with at least:
   - `LLM_API_KEY`, `LLM_MODEL` (and `LLM_BASE_URL` if you're not on DeepSeek): needed to route plain-English questions
   - one people/company source such as `APOLLO_API_KEY`
   - one web source such as `TAVILY_API_KEY` or `JINA_API_KEY`
   - `HUNTER_API_KEY` if you want an email lookup in the video
2. Restart the server: `npm run mcp`
3. Keep the tunnel up: `ngrok http 3333 --host-header=rewrite`. If the ngrok URL changed, put the
   new one in `PUBLIC_URL` and restart again.
4. Dry run without recording:
   ```bash
   npx -y outmate search "Find engineering leaders at vercel.com"
   ```
   Don't record until this returns names.

## 1. Reset to a clean machine (so "from start" is real)

```bash
claude mcp remove outmate -s user
```
```bash
rm -rf ~/.outmate "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/outmate"
```
```bash
npm rm -g outmate
```

Turn on self-serve sign-up in `.env` and restart the server:

```
SIGNUP_ENABLED=true
SIGNUP_CODE=founders        # optional; shows an invite-code field
```

If you've signed up with the same email before, remove that token first, because each email gets one
token: `npm run token -- revoke gautam_at_outmate.ai`

Screen setup: a clean terminal, a large font (18pt+), a dark theme, notifications off, and
`cd` into an empty folder such as `~/demo` so no project files show.

## 2. The recording

### Scene 1: the problem (10s, voiceover)
> "Normally, getting your agent to research companies and people means a pile of API keys, an MCP
> config file, and docs. Here's what it looks like with outmate."

### Scene 2: one line (30s)
Run `claude`, then type:

```
set up outmate — https://<your-host>/llms.txt
```

Claude reads the page and asks for a token, pointing to `https://<host>/signup`. Open that link in
the browser, enter your work email (and invite code), click **Get token**, then **Copy token**.
Paste it back into Claude.
> Voiceover: "Sign up with your work email, get one token. That's all the user handles. The provider
> keys stay on our server."

### Scene 3: Claude does the setup (45s)
Claude runs these in order. Approve the `npm` / `outmate` permission prompts when they appear:

```
npm i -g outmate
outmate login --url https://<host> --token ****
outmate connect      → "Claude Code: added (user scope), skill installed"
outmate              → shows signed in + configured providers
```

It finishes with a one-line summary and three suggested questions (the `llms.txt` asks it to).
> Voiceover: "It installed the CLI, signed in, and registered itself with Claude Code, plus Cursor,
> Codex and the rest if they're installed."

### Scene 4: first search, right away (30s)
In the same session (the MCP tool loads next session, but the CLI works now):

```
search for engineering leaders at vercel.com
```

Claude runs `outmate search "..."` and lists names, titles and source links.

### Scene 5: the native tool (45s)
Type `/exit`, then run `claude` again. Optionally run `/mcp` and show `outmate ✔ connected`.
Then ask 2–3 short questions. Claude now calls the `outmate_search` tool directly:

```
How many employees does Linear have, and where are they based?
```
```
Who leads engineering at Notion?
```
(Email questions need `HUNTER_API_KEY`; leave them out until it's set.)
```
What does https://vercel.com/pricing say about the Pro plan?
```

### Scene 6: close (10s, voiceover)
> "One line, one token, and every coding agent on the machine can do GTM research. No keys on the
> laptop."

## 3. Tips

- Current demo config: Gemini `gemini-3.5-flash` with `LLM_REASONING_EFFORT=low`, plus Tavily +
  Jina. (`gemini-2.5-flash` is closed to new users; `gemini-3.8-flash` was returning 503.) A search
  takes about 15–25 seconds.
- Without a people database (MoltSets/Apollo), people come from web search, so results vary between
  runs. Run the Vercel question twice before recording; if one take returns weak names, retake.

- Approve permission prompts for each command (don't choose "always allow" before recording) so
  viewers see what's being run, or pre-allow `Bash(npm:*)` and `Bash(outmate:*)` for a smoother take.
- The token is masked in Claude's output, but blur the paste moment in editing to be safe.
- Each search spends provider credits. Run the dry run once, not ten times.
- Backup take: `sh demo/run-demo.sh` runs the same flow as a script, and
  `sh demo/claude-session.sh` proves a fresh Claude Code session calls `outmate_search`.
- After recording: `npm run token -- revoke <name>` (for example `gautam_at_outmate.ai`), and set
  `SIGNUP_ENABLED=` back to empty if you don't want sign-up open.
