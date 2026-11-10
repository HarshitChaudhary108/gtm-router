/**
 * Operator tool: manage user tokens for the MCP server. Run on the server machine.
 *   npm run token -- create alice
 *   npm run token -- list
 *   npm run token -- revoke alice
 */
import { TokenStore } from "../src/auth.js";
import { loadEnv, parseConfig } from "../src/config.js";

loadEnv();
const store = new TokenStore(parseConfig().tokensFile);
const [command, name] = process.argv.slice(2);

try {
  if (command === "create" && name) {
    const { token } = store.create(name);
    console.log(`Token for "${name}". It is shown once and cannot be recovered:\n\n${token}\n`);
    console.log("User runs:  gtm login --url <server> --token <token>");
  } else if (command === "list") {
    const records = store.list();
    if (records.length === 0) console.log("No tokens.");
    for (const r of records) console.log(`${r.name}\tcreated ${r.created_at}`);
  } else if (command === "revoke" && name) {
    console.log(store.revoke(name) ? `Revoked "${name}".` : `No token named "${name}".`);
  } else {
    console.log("Usage: npm run token -- create <name> | list | revoke <name>");
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : "failed");
  process.exitCode = 1;
}
