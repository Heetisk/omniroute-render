/**
 * trim-db.mjs — extract a CONFIG-ONLY copy of your local OmniRoute database.
 *
 * Why this exists
 * ---------------
 * Your local `~/.omniroute/storage.sqlite` is ~835 MB, plus a ~506 MB WAL.
 * Almost all of that is local observability: 906,019 conversation_turn_nodes,
 * 100,562 proxy_logs, 77,587 usage_history rows. None of that belongs on a
 * cloud standby, and none of it fits in Render's 1 MB secret-file cap.
 *
 * This script keeps only the tables that describe *configuration* — provider
 * connections, combos, API keys, routing settings — and empties everything
 * else. The result is ~2.6 MB (1,769 rows).
 *
 * Usage:  node tools/trim-db.mjs
 * Output: ./trimmed.sqlite  (git-ignored)
 */
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const HOME = process.env.USERPROFILE || process.env.HOME;

const SRC = path.join(HOME, ".omniroute", "storage.sqlite");
const OUT = path.join(REPO, "trimmed.sqlite");

/**
 * Tables that hold configuration worth carrying to the cloud instance.
 * Everything not listed here is local observability and gets emptied.
 */
const KEEP = [
  // provider credentials + their metadata
  "provider_connections", "provider_nodes",
  // client-facing keys
  "api_keys",
  // routing configuration
  "combos", "model_combo_mappings", "model_context_overrides",
  "model_capabilities", "model_capability_overrides", "model_intelligence",
  "domain_fallback_chains", "domain_budgets", "domain_lockout_state",
  "domain_circuit_breakers", "reasoning_routing_rules", "auto_candidate_overrides",
  // quota / key policy configuration
  // (note: api_key_quota_counters, api_key_token_counters and
  //  api_key_token_limit_reset_logs are USAGE COUNTERS, not configuration,
  //  so they are deliberately NOT in this list.)
  "provider_key_limits", "account_key_limits", "registered_keys",
  "quota_pools", "quota_pool_connections", "quota_groups", "quota_allocations",
  "quota_allocation_model_caps", "provider_plans", "provider_quota_state",
  "api_key_quota_limits", "api_key_token_limits",
  "key_groups", "key_group_members", "tier_config", "tier_assignments",
  // settings store (928 rows: routing rules, model aliases, provider defaults)
  "key_value",
  // user configuration worth keeping
  "memory", "skills", "plugins", "middleware_hooks", "compression_combos",
  "compression_combo_assignments", "sync_tokens", "files", "semantic_cache",
  "inspector_custom_hosts", "agent_bridge_state", "agent_bridge_mappings",
  "agent_bridge_bypass", "connection_runtime_state", "exclusive_connection_leases",
  // schema bookkeeping - required for the migration runner
  "_omniroute_migrations", "sqlite_sequence", "db_meta",
];

const keep = new Set(KEEP);

if (!fs.existsSync(SRC)) {
  console.error(`Source database not found: ${SRC}`);
  console.error("Is OmniRoute installed and has it run at least once?");
  process.exit(1);
}

for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(OUT + suffix, { force: true });

// VACUUM INTO gives us a consistent copy even while the local server is
// running, and rewrites the file without the WAL sidecar.
const src = new DatabaseSync(SRC, { readOnly: true });
src.exec(`VACUUM INTO '${OUT.replace(/\\/g, "/")}'`);
src.close();

const db = new DatabaseSync(OUT);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((r) => r.name);

let cleared = 0;
for (const t of tables) {
  if (keep.has(t)) continue;
  try {
    db.exec(`DELETE FROM "${t}"`);
    cleared++;
  } catch {
    // FTS / virtual tables can refuse DELETE; the matching shadow tables are
    // emptied by their own triggers, and both are local-only anyway.
  }
}

// Reclaim the space the deleted rows occupied.
db.exec("VACUUM");

let total = 0;
const populated = [];
for (const t of tables) {
  try {
    const c = db.prepare(`SELECT count(*) n FROM "${t}"`).get().n;
    total += c;
    if (c > 0) populated.push([t, c]);
  } catch {
    // ignore unreadable tables
  }
}

const size = fs.statSync(OUT).size;
db.close();

console.log("emptied tables:", cleared);
console.log("rows kept:", total);
console.log(
  populated
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([t, c]) => `${t}=${c}`)
    .join(", ")
);
console.log(
  `size: ${size} bytes = ${(size / 1024 / 1024).toFixed(2)} MB  ->  ${OUT}`
);
console.log("\nNext: omniroute auth export --format json --out auth-export.json --force");
console.log("Then: node tools/make-seed.mjs");
