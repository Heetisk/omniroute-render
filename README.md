# omniroute-render

A 24/7 [Omniroute](https://github.com/diegosouzapw/OmniRoute) gateway on
Render's free tier, carrying a copy of your local OmniRoute configuration.

**Live at:** https://omniroute-render-a0ci.onrender.com

- **Full setup guide:** [`docs/DEPLOY.md`](docs/DEPLOY.md)
- **Design document:** [`docs/superpowers/specs/2026-10-21-omniroute-render-deployment-design.md`](docs/superpowers/specs/2026-10-21-omniroute-render-deployment-design.md)

## How it works

Render's free tier has an ephemeral filesystem that is wiped on every
redeploy **and** on every 15-minute idle spin-down, and it has no persistent
disk. So this service does not try to keep state between requests. Instead:

```
cold start
  ├─ entrypoint.sh
  │    ├─ base64 -d | gunzip  /etc/secrets/seed.b64  →  $DATA_DIR/storage.sqlite
  │    ├─ source /etc/secrets/server.env  →  JWT_SECRET, API_KEY_SECRET,
  │    │                                     STORAGE_ENCRYPTION_KEY, INITIAL_PASSWORD
  │    └─ exec node dev/run-standalone.mjs
  └─ OmniRoute boots with your providers, combos, keys and settings
```

The seed is a config-only extract of your local `~/.omniroute/storage.sqlite`:
1.3 GB of local chat history and analytics are stripped, leaving 1,769 config
rows (2.6 MB, ~231 KB base64+gzip).

Every provider credential in the seed is re-encrypted under a **new** key
generated at seed-build time. Your local `STORAGE_ENCRYPTION_KEY` never
leaves your machine.

## Layout

| Path | What it is |
|---|---|
| `Dockerfile` | thin layer on `diegosouzapw/omniroute:3.8.52` |
| `entrypoint.sh` | seed restore + secret load + exec the server |
| `tools/trim-db.mjs` | extracts the config-only subset of the local DB |
| `tools/make-seed.mjs` | re-encrypts credentials, strips local-only state, emits the seed |
| `.github/workflows/keepalive.yml` | pings `/healthz` every 10 min to prevent spin-down |

## Security notes

- No secret is ever committed. `seed.sqlite`, `seed.b64`, `server.env` and
  `auth-export.json` are git-ignored.
- The cloud instance has a **separate** dashboard password from your local
  one, and `REQUIRE_API_KEY=true` is never relaxed.
- Your local SOCKS5 proxies (which carry plaintext credentials and point at
  unroutable IPs) are stripped from the seed.
- The service is designed for *your* clients, not untrusted users. Put it
  behind a VPN or IP allowlist if that is not acceptable.

## Local test results

Validated in a real Docker container built from this repo, using a
root-owned 0600 secret mount that reproduces Render's exact permissions.

| Check | Result |
|---|---|
| Container build | succeeds on `diegosouzapw/omniroute:3.8.52` |
| Boot | seed restored → 6 secrets loaded → privileges dropped to uid 1000 → ready |
| Container health | `healthy` |
| `/healthz` | 200 |
| `/v1/models` unauthenticated | 401 |
| `/v1/models` with a migrated key | 200, 1,516 models |
| `/api/providers` | 200, all 16 connections |
| Dashboard login (right / wrong password) | 200 / 401 |
| Live inference via a re-encrypted credential | `agentrouter/deepseek-v4-flash` → 200, `"content":"PONG"` |
| Memory | 385 MB resident (fits the 512 MB tier) |
| **Cold start** (container destroyed, fresh FS) | rehydrates identically |

## Live deployment results

Deployed and verified at https://omniroute-render-a0ci.onrender.com:

| Check | Result |
|---|---|
| Boot from a cold start | seed restored → 6 secrets → privileges dropped → ready |
| `/healthz` | 200 |
| `/v1/models` unauthenticated | **401** |
| `/v1/models` authenticated | 200, 1,562 models |
| `/api/providers` (management key) | 200, all 16 connections |
| **Live inference via a re-encrypted OAuth token** | `kiro/claude-sonnet-4.5` → 200, `"content":"PONG"` |

Some upstream providers refuse Render's datacenter IP or are out of quota —
`agentrouter` (WAF), `codex` (quota), `longcat` (quota), `qoder` (needs a
CLI binary not in the base image). Those are provider-account properties,
not deployment faults. See the design doc §9 and §12 for the detail.

Two findings from testing are baked into the code:

- The container **starts as root** and drops to uid 1000 via `setpriv`.
  Render mounts secret files root-only readable, and the upstream image runs
  as `node` — so a container started as `node` cannot read its own secrets
  and boots with an empty database.
- The entrypoint **removes any existing `storage.sqlite`** (and its
  `-wal`/`-shm`) before restoring, so a failed restore can never silently
  leave stale data in place.
