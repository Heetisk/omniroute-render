/**
 * make-seed.mjs — build the uploadable seed for the Render deployment.
 *
 * Inputs
 *   trimmed.sqlite    (from tools/trim-db.mjs)  — config rows, encrypted creds
 *   auth-export.json  (from `omniroute auth export --format json --force`)
 *
 * What it does
 *   1. Re-encrypts every provider credential under a BRAND-NEW key, so the
 *      local STORAGE_ENCRYPTION_KEY never has to be read, copied, or shipped.
 *   2. Strips local-only state: the SOCKS5 proxy registry (plaintext
 *      credentials, unroutable IPs) and the copied dashboard password hash.
 *   3. Verifies every credential round-trips through the new key.
 *   4. Emits the artifacts Render consumes.
 *
 * Usage:  node tools/make-seed.mjs
 * Outputs (all git-ignored):
 *   seed.sqlite                 the seed database
 *   seed.sqlite.gz.b64          base64(gzip(seed.sqlite))  -> upload as seed.b64
 *   seed.server-env             JWT_SECRET / API_KEY_SECRET / STORAGE_ENCRYPTION_KEY
 *   seed.storage-encryption-key the new key, in the clear
 */
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// Must match upstream src/lib/db/encryption.ts.
const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const STATIC_SALT = "omniroute-field-encryption-v1";
const PREFIX = "enc:v1:";

const deriveKey = (secret) => scryptSync(secret, STATIC_SALT, 32);

function encrypt(plain, key) {
  if (!plain) return null;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  let ct = cipher.update(plain, "utf8", "hex");
  ct += cipher.final("hex");
  return `${PREFIX}${iv.toString("hex")}:${ct}:${cipher.getAuthTag().toString("hex")}`;
}

function decrypt(value, key) {
  if (!value || !value.startsWith(PREFIX)) return value;
  // enc:v1:<iv_hex>:<ct_hex>:<tag_hex> -> split gives ["enc","v1",iv,ct,tag]
  const parts = value.split(":");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(parts[2], "hex"), {
    authTagLength: AUTH_TAG_LEN,
  });
  decipher.setAuthTag(Buffer.from(parts[4], "hex"));
  let out = decipher.update(parts[3], "hex", "utf8");
  out += decipher.final("utf8");
  return out;
}

const TRIMMED = path.join(REPO, "trimmed.sqlite");
const EXPORT = path.join(REPO, "auth-export.json");

if (!fs.existsSync(TRIMMED)) {
  console.error("trimmed.sqlite not found - run: node tools/trim-db.mjs");
  process.exit(1);
}
if (!fs.existsSync(EXPORT)) {
  console.error(
    "auth-export.json not found - run:\n" +
      "  omniroute auth export --format json --out auth-export.json --force"
  );
  process.exit(1);
}

const exported = JSON.parse(fs.readFileSync(EXPORT, "utf8"));
const byId = new Map(exported.map((e) => [e.id, e]));

// A fresh key, generated here. The local key is never involved.
const newSecret = randomBytes(32).toString("hex");
const newKey = deriveKey(newSecret);

const OUT = path.join(REPO, "seed.sqlite");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(OUT + suffix, { force: true });

const trimmed = new DatabaseSync(TRIMMED);
trimmed.exec(`VACUUM INTO '${OUT.replace(/\\/g, "/")}'`);
trimmed.close();

const db = new DatabaseSync(OUT);

// ── 1. Re-encrypt the provider credentials ────────────────────────────────
const upd = db.prepare(
  `UPDATE provider_connections
      SET api_key = ?, access_token = ?, refresh_token = ?, id_token = ?
    WHERE id = ?`
);

let fields = 0;
let rows = 0;
for (const r of db.prepare("SELECT id FROM provider_connections").all()) {
  const e = byId.get(r.id);
  if (!e) {
    console.warn(`  ! no auth-export entry for ${r.id} - its credential stays empty`);
    upd.run(null, null, null, null, r.id);
    continue;
  }
  const vals = ["apiKey", "accessToken", "refreshToken", "idToken"].map((k) => {
    const v = e[k];
    if (!v) return null;
    fields++;
    return encrypt(v, newKey);
  });
  upd.run(vals[0], vals[1], vals[2], vals[3], r.id);
  rows++;
}

// ── 2. Strip local-only state ─────────────────────────────────────────────
// 10 SOCKS5 proxies with plaintext username/password, pointing at IPs a
// Render instance can never reach. proxy_assignments binds one of them to a
// provider connection, so the per-connection proxy flags must be cleared too
// or the seeded connections would reference a proxy that no longer exists.
for (const t of [
  "proxy_registry", "proxy_assignments", "proxy_scope_rotation",
  "free_proxies", "free_proxy_sync_errors", "upstream_proxy_config",
]) {
  try {
    db.exec(`DELETE FROM "${t}"`);
  } catch {
    // table absent in this schema version
  }
}
db.exec("UPDATE provider_connections SET proxy_enabled = 0, per_key_proxy_enabled = 0");

// The dashboard password: drop the copied local bcrypt hash so the cloud
// instance bootstraps its own from INITIAL_PASSWORD in server.env.
db.exec("DELETE FROM key_value WHERE key = 'password'");

// ── 3. Verify the round-trip ──────────────────────────────────────────────
// A silent decryption failure here would produce a server that boots green
// and serves zero providers, so this is checked, not assumed.
let verified = 0;
for (const r of db
  .prepare("SELECT id, api_key, access_token, refresh_token, id_token FROM provider_connections")
  .all()) {
  for (const f of ["api_key", "access_token", "refresh_token", "id_token"]) {
    if (!r[f]) continue;
    const plain = decrypt(r[f], newKey);
    if (!plain) throw new Error(`decrypt failed for ${r.id}.${f}`);
    verified++;
  }
}

db.exec("VACUUM");
const size = fs.statSync(OUT).size;
db.close();

// ── 4. Emit the artifacts ─────────────────────────────────────────────────
const b64 = path.join(REPO, "seed.sqlite.gz.b64");
const gz = path.join(REPO, "seed.sqlite.gz");
const { execFileSync } = await import("node:child_process");

// gzip via zlib keeps this dependency-free and consistent across platforms.
const { gzipSync } = await import("node:zlib");
const gzipped = gzipSync(fs.readFileSync(OUT), { level: 9 });
fs.writeFileSync(gz, gzipped);
fs.writeFileSync(b64, gzipped.toString("base64"));

fs.writeFileSync(
  path.join(REPO, "seed.storage-encryption-key"),
  newSecret,
  { mode: 0o600 }
);

const serverEnv = [
  "# OmniRoute cloud secrets.",
  "# Upload this file to Render as a secret file named 'server.env'.",
  "#",
  "# STORAGE_ENCRYPTION_KEY is REQUIRED: without it the server refuses to boot",
  "# rather than silently wiping the encrypted provider credentials.",
  "#",
  "# INITIAL_PASSWORD: the dashboard password for the CLOUD instance only.",
  "# CHANGE IT to something strong before uploading - this is the only thing",
  "# protecting a dashboard on a public URL.",
  "",
  `JWT_SECRET=${randomBytes(64).toString("hex")}`,
  `API_KEY_SECRET=${randomBytes(32).toString("hex")}`,
  `STORAGE_ENCRYPTION_KEY=${newSecret}`,
  "STORAGE_ENCRYPTION_KEY_VERSION=v1",
  `INITIAL_PASSWORD=${process.env.INITIAL_PASSWORD || "CHANGE_ME_BEFORE_UPLOADING"}`,
  `OMNIROUTE_API_KEY=${process.env.OMNIROUTE_API_KEY || "sk-omniroute-" + randomBytes(12).toString("hex")}`,
  "",
].join("\n");
fs.writeFileSync(path.join(REPO, "seed.server-env"), serverEnv, { mode: 0o600 });

console.log("provider connections seeded:", rows);
console.log("credential fields re-encrypted:", fields);
console.log("round-trip decrypt verified:", verified);
console.log(`seed.sqlite          ${size} bytes (${(size / 1024).toFixed(1)} KB)`);
console.log(`seed.sqlite.gz.b64   ${gzipped.length} bytes gzipped -> ${fs.statSync(b64).size} bytes base64`);
console.log("");
console.log("Upload these to Render as secret files:");
console.log("  seed.b64     <- seed.sqlite.gz.b64");
console.log("  server.env   <- seed.server-env");
console.log("");
if (!process.env.INITIAL_PASSWORD || !process.env.OMNIROUTE_API_KEY) {
  console.log("NOTE: INITIAL_PASSWORD and OMNIROUTE_API_KEY were generated as");
  console.log("      placeholders. Open seed.server-env and set both by hand before");
  console.log("      uploading - the dashboard password is the only thing protecting");
  console.log("      a publicly reachable dashboard.");
}
console.log("");
console.log("WHEN THE UPLOAD IS CONFIRMED, DELETE:");
console.log("  auth-export.json        (PLAINTEXT credentials)");
console.log("  seed.server-env         (all secrets)");
console.log("  seed.storage-encryption-key");
console.log("  seed.sqlite, seed.sqlite.gz, seed.sqlite.gz.b64");
