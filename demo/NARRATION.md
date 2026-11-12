# Narration: Outmate one-line setup demo

Video: `Outmate_one_line_setup.mov` (4:23, recorded in the Claude desktop app, Code tab).
Each scene below is timed to the video. The narrated copy is `Outmate_one_line_setup_narrated.mov`.

| # | Time | On screen |
|---|------|-----------|
| 1 | 0:00 | Setup card on the left, Claude on the right. The setup line is sent. |
| 2 | 0:13 | Claude reads `llms.txt` and checks the npm package against the repo. |
| 3 | 0:44 | Claude asks how to provide the token. "Paste it in chat" is picked. |
| 4 | 1:07 | Token revealed and copied from the card. Global npm install fails, Claude switches to `npx`. |
| 5 | 1:27 | `gtm login` succeeds as `founder-demo`. `gtm connect` adds five agents. |
| 6 | 1:58 | Provider status, first test search hits a 429 rate limit, Claude waits and retries once. |
| 7 | 2:35 | Retry succeeds: three Vercel engineering leaders with LinkedIn sources. |
| 8 | 3:15 | Claude's summary of the setup. |
| 9 | 3:52 | One LinkedIn source opened to check the result by hand. |

## Script

**1 · 0:00.** This is the one-line setup for gtm-router, shown in the Claude desktop app's Code tab. On the left is the setup card. I copy one line and send it to Claude.

**2 · 0:13.** Claude now reads llms.txt from our server. That file is the instruction sheet for agents. It says to install the gtm command-line tool from npm, ask the user for a token, sign in, and connect. Before running anything, Claude checks that the outmate package on npm matches the source code in our repo, and that it has no install scripts. So nothing unexpected runs on the user's machine.

**3 · 0:44.** Now Claude needs a gtm-router token. This is not a provider key. The keys for Gemini, Tavily and Jina stay on our server. Claude offers three ways to give the token: run the login yourself, paste it in chat, or get one from the signup page. For this demo, I paste it in chat.

**4 · 1:07.** I copy the token from the setup card. On this Mac, the global npm install failed with a permissions error, so Claude falls back to npx, which runs the same tool without a global install.

**5 · 1:27.** Claude runs gtm login. The tool sends the token to our server's whoami endpoint. The server hashes the token, compares it with the stored hash, and answers: signed in as founder-demo. Next, gtm connect registers our server with every agent it finds: Claude Code, Cursor, Codex, VS Code and Gemini CLI. For Claude Code and Codex, it also installs a skill file that explains when to use the tool.

**6 · 1:58.** The status shows which providers are live on the server: Tavily for web search, Jina for reading pages, and Gemini as the model that plans each search. Then Claude runs a test search: find engineering leaders at vercel.com. The first try hits a rate limit, error 429, because this demo uses Gemini's free tier. Claude waits thirty seconds and tries once more. The setup rules tell it not to retry in a loop.

**7 · 2:35.** The retry works. On our server, Gemini read the question and chose a web search, and Tavily returned public profiles in about three seconds. The answer lists Mike Curtis, VP of Engineering for Cloud, Paul Wright, Engineering Director for CDN, and Gary Tyr, Head of Growth Engineering, each with a LinkedIn source. The execution line shows which provider answered each step.

**8 · 3:15.** Claude then sums up the setup. I'm signed in as founder-demo, and five agents are connected. Only Tavily, Jina and the language model are configured right now, so people and email lookups come from the web until we add Apollo or Hunter. Claude also points out that the token is now in this chat, so it should be rotated if the chat is shared.

**9 · 3:52.** Finally, I open one of the LinkedIn sources to check the result by hand. Paul Wright, engineering leader at Vercel. It matches. That's the whole flow: one line, one token, and the agent can research companies and people, while the provider keys never leave our server.

## What this video does not show yet

- The same flow in the Claude Code CLI in a terminal.
- The same flow in the Claude Code extension in VS Code.
- The native `gtm_search` MCP tool. It loads in the next session; this video's search ran through the `gtm` CLI.
