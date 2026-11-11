# Tools and per-user keys

`outmate_search` is the only tool an agent sees. Behind it, the router picks from a folder of tool
files and calls the providers with the **user's own keys**.

## Tool files (`tools/*.json`)

One file per tool. The server reloads the folder whenever a file is added, edited or removed, so
**adding a tool needs no restart and no code**. A broken file is skipped and logged.

| Field | Meaning |
|---|---|
| `name` | Unique action name, e.g. `custom.hunter_email_count` |
| `tool` | The name the router's model sees (snake_case) |
| `kind` | `builtin` (backed by code in `src/registry.ts`) or `http` (fully described by `request`) |
| `key` | Provider id. Also the Nango integration id the user's key is saved under |
| `needs_key` | `true`: only offered to users who have a key for `key` |
| `capability` | Short phrase added to the `outmate_search` description |
| `description`, `parameters` | What the model reads: when to use it, and its JSON-schema inputs |
| `order` | Optional position in the model's tool list |
| `request` | `http` tools only: `method`, `url`, `query`, `body`, `auth`, `result_path` |

### Add a tool in three steps

1. In Nango, create an API-key integration whose id equals the file's `key` (skip if it exists).
2. Copy `tools/hunter_email_count.json`, change `name`, `tool`, `key`, `capability`, `description`,
   `parameters` and `request`.
3. Done. The next `outmate_search` call sees it, and its description lists the new capability.
   Each user adds their key for that provider on `/connections`.

`request.url` must be https with a fixed host. `{param}` may appear in the path and in `query` /
`body` values; a value that is exactly `{param}` is dropped when the model leaves it out. `auth.in`
is `header`, `query` or `bearer`. The user's key is attached by the server and never appears in a
URL we log or in a response.

## Per-user keys (Nango)

Set `NANGO_SECRET_KEY` (and `NANGO_HOST` for a self-hosted Nango). Then:

- Users open `https://<host>/connections`, paste their outmate token, and press **Connect** next to
  a provider. Nango's Connect screen takes the key; it never passes through this server.
- The connection is linked to the user by the `end_user_id` tag (the user's token name).
- On each request the server finds the caller's connections, reads their keys, and uses them. The
  keys are cached in memory for 60 seconds and redacted from every response.
- A user's own key wins. The server's `.env` keys are only a fallback, and only while
  `OUTMATE_SHARED_KEYS` is not `false`. If Nango is unreachable the fallback is used.
- Keyed tools are offered only when the user has that key, and the `outmate_search` description is
  built per user from the tools they can use.

Without `NANGO_SECRET_KEY` everything works as before with the shared keys, and `/connections`
shows each provider's status without Connect buttons.

| Route | Purpose |
|---|---|
| `GET /connections` | The page (static) |
| `GET /connections/api/state` | Each provider: `own`, `shared` or `none` (Bearer token) |
| `POST /connections/api/session` | Start a Nango Connect session for one provider |
| `POST /connections/api/refresh` | Forget cached keys after a connect |
