import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolCatalog } from "../src/tools.js";

/** The first tools outmate shipped with. Tests that pin exact tool lists use these, so adding new provider files never breaks them. */
export const CORE_TOOL_FILES = [
  "web_search", "read_url", "search_companies", "search_people",
  "apollo_companies", "apollo_people", "hunter_domain", "hunter_email", "hunter_email_count",
];

export function coreToolsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "outmate-core-tools-"));
  for (const f of CORE_TOOL_FILES) cpSync(new URL(`../tools/${f}.json`, import.meta.url), join(dir, `${f}.json`));
  return dir;
}

export const coreCatalog = (): ToolCatalog => new ToolCatalog(coreToolsDir());
