/**
 * create-service.mjs — create the Render web service for this deploy.
 *
 * Usage:
 *   $env:RENDER_API_KEY = 'rnd_...'
 *   node tools/create-service.mjs
 *
 * The service is a Docker web service on the free plan, pointed at this
 * repository. Environment variables and secret files are set separately
 * (tools/upload-secrets.mjs for the secrets, the API for the env vars).
 */
import {
  createWebService,
  firstOwnerId,
  findWebService,
  listServices,
  updateEnvVars,
  putSecretFile,
  triggerDeploy,
} from "./render-api.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

const SERVICE_NAME = process.env.RENDER_SERVICE_NAME || "omniroute-render";
const REPO_URL = "https://github.com/Heetisk/omniroute-render";

const ownerId = await firstOwnerId();
console.log("owner:", ownerId);

// Idempotent: if the service already exists, reuse it.
let service = await findWebService(SERVICE_NAME, ownerId);
if (service) {
  console.log(`Service "${SERVICE_NAME}" already exists (${service.id}) - reusing it.`);
} else {
  console.log(`Creating service "${SERVICE_NAME}"...`);
  service = await createWebService({
    ownerId,
    type: "web_service",
    name: SERVICE_NAME,
    repo: REPO_URL,
    branch: "main",
    autoDeployTrigger: "commit",
    serviceDetails: {
      runtime: "docker",
      plan: "free",
      region: "oregon",
      envSpecificDetails: {
        dockerContext: ".",
        dockerfilePath: "./Dockerfile",
        dockerCommand: "",
      },
      healthCheckPath: "/healthz",
      // 0.0.0.0/0 so the public URL is reachable; access is gated by
      // REQUIRE_API_KEY=true, not by the network.
      ipAllowList: [{ cidrBlock: "0.0.0.0/0", description: "everywhere" }],
    },
  });
  console.log(`Created: ${service.id}`);
}

console.log(`id:   ${service.id}`);
console.log(`url:  ${service.serviceDetails?.url ?? "(assigned after first deploy)"}`);
console.log(`dashboard: https://dashboard.render.com/web/${service.id}`);

// ── Environment variables ─────────────────────────────────────────────────
// Deliberately NOT set here: INITIAL_PASSWORD and OMNIROUTE_API_KEY. They
// live in the server.env secret file, which the entrypoint sources into
// process.env, so that the intended values win over any ambient .env.
console.log("\nSetting environment variables...");
await updateEnvVars(service.id, [
  { key: "OMNIROUTE_MEMORY_MB", value: "256" },
  { key: "REQUIRE_API_KEY", value: "true" },
  { key: "OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK", value: "true" },
]);
console.log("  OMNIROUTE_MEMORY_MB=256");
console.log("  REQUIRE_API_KEY=true");
console.log("  OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true");

// ── Secret files ──────────────────────────────────────────────────────────
const FILES = [
  ["seed.b64", path.join(REPO, "seed.sqlite.gz.b64")],
  ["server.env", path.join(REPO, "seed.server-env")],
];

console.log("\nUploading secret files...");
for (const [name, file] of FILES) {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${file} - run the seed build first (see docs/DEPLOY.md).`);
    process.exit(1);
  }
  const content = fs.readFileSync(file, "utf8");
  await putSecretFile(service.id, name, content);
  console.log(`  ${name}  (${content.length} bytes)`);
}

// ── First deploy ──────────────────────────────────────────────────────────
console.log("\nTriggering the first deploy...");
try {
  const deploy = await triggerDeploy(service.id, { clearCache: true });
  console.log(`  deploy id: ${deploy?.id ?? "(unknown)"}`);
} catch (err) {
  console.log(`  Could not auto-trigger: ${err.message}`);
}

console.log(`
Done. Watch the deploy at:
  https://dashboard.render.com/web/${service.id}

When it goes live, the URL is:
  ${service.serviceDetails?.url ?? "https://" + SERVICE_NAME + "-<suffix>.onrender.com"}

Then verify:
  curl -s <url>/healthz
  curl -s -o /dev/null -w '%{http_code}\\n' <url>/v1/models     # expect 401
  curl -s -H "Authorization: Bearer <OMNIROUTE_API_KEY>" <url>/v1/models | head -c 200
`);
