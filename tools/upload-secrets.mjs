/**
 * upload-secrets.mjs — push the seed + server.env to a Render service.
 *
 * Usage:
 *   $env:RENDER_API_KEY = 'rnd_...'
 *   node tools/upload-secrets.mjs --service <serviceId> [--dry-run]
 *
 * Or, to look the service up by name:
 *   node tools/upload-secrets.mjs --name omniroute-render
 *
 * Uploads:
 *   seed.b64     <- seed.sqlite.gz.b64   (the base64+gzip seed database)
 *   server.env   <- seed.server-env      (JWT/API/STORAGE keys + password)
 *
 * The API key is read from RENDER_API_KEY. It is never written to a file and
 * never passed as a command-line argument.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  findWebService,
  listSecretFiles,
  putSecretFile,
  listOwners,
  triggerDeploy,
  RenderApiError,
} from "./render-api.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const serviceId = arg("service");
const serviceName = arg("name");
const dryRun = has("dry-run");

if (!serviceId && !serviceName) {
  console.error("Usage: node tools/upload-secrets.mjs --service <id> | --name <service-name> [--dry-run]");
  process.exit(2);
}

const FILES = [
  ["seed.b64", path.join(REPO, "seed.sqlite.gz.b64")],
  ["server.env", path.join(REPO, "seed.server-env")],
];

for (const [, file] of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file}. Run the seed build first:`);
    console.error("  node tools/trim-db.mjs");
    console.error("  omniroute auth export --format json --out auth-export.json --force");
    console.error("  node tools/make-seed.mjs");
    process.exit(1);
  }
}

let target = null;

if (serviceId) {
  target = { id: serviceId, name: serviceId };
} else {
  // The API can list services across owners; try each owner until we find
  // a match by name.
  let owners = [];
  try {
    owners = await listOwners();
  } catch (err) {
    console.error(`Could not list owners: ${err.message}`);
    process.exit(1);
  }
  for (const owner of owners ?? []) {
    try {
      const found = await findWebService(serviceName, owner.id);
      if (found) {
        target = found;
        break;
      }
    } catch {
      // Try the next owner.
    }
  }
  if (!target) {
    console.error(`No web service named "${serviceName}" was found for this API key.`);
    console.error("Check the name, or pass --service <id>.");
    process.exit(1);
  }
}

console.log(`Target service: ${target.name} (${target.id})`);

const existing = await listSecretFiles(target.id).catch(() => []);
const existingNames = (Array.isArray(existing) ? existing : []).map((f) => f?.name ?? f?.key);
console.log(`Existing secret files: ${existingNames.length ? existingNames.join(", ") : "(none)"}`);

if (dryRun) {
  for (const [name, file] of FILES) {
    const bytes = fs.statSync(file).size;
    console.log(`  would upload ${name}  (${bytes} bytes) from ${path.basename(file)}`);
  }
  const total = FILES.reduce((n, [, f]) => n + fs.statSync(f).size, 0);
  console.log(`\nTotal: ${total} bytes (Render's limit is 1 MB = 1048576 bytes)`);
  if (total > 1048576) {
    console.error("WARNING: total exceeds Render's 1 MB secret-file limit.");
    process.exitCode = 1;
  }
  process.exit(0);
}

for (const [name, file] of FILES) {
  const content = fs.readFileSync(file, "utf8");
  try {
    await putSecretFile(target.id, name, content);
    console.log(`  uploaded ${name} (${content.length} bytes)`);
  } catch (err) {
    if (err instanceof RenderApiError) {
      console.error(`  FAILED ${name}: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

console.log("\nSecret files uploaded. Triggering a deploy so the new secrets take effect...");
try {
  const deploy = await triggerDeploy(target.id, { clearCache: true });
  console.log(`  deploy id: ${deploy?.id ?? "(unknown)"}`);
  console.log(`  watch it at https://dashboard.render.com/`);
} catch (err) {
  console.log(`  Could not auto-trigger a deploy: ${err.message}`);
  console.log("  Trigger one manually from the Render dashboard.");
}

console.log("\nReminder: once the deploy is live and verified, delete these locally:");
console.log("  auth-export.json  seed.server-env  seed.storage-encryption-key");
console.log("  seed.sqlite  seed.sqlite.gz  seed.sqlite.gz.b64");
