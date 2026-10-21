# OmniRoute on Render.com — 24/7 Deployment Design

**Date:** 2026-10-21
**Status:** Draft for approval
**Author:** Claude Code (design prepared with Heet Limbani)

---

## 1. Intent and the why

Heet runs a local [Omniroute](https://github.com/diegosouzapw/OmniRoute) instance
(v3.8.51) on Windows at `localhost:20128`. It is his local AI gateway: one
OpenAI-compatible endpoint that routes to 352+ providers, with auto-fallback,
routing strategies, and combo definitions. Several local tools (Claude Code,
OpenClaw, "ClipForge"/YT-automate) talk to it as `ANTHROPIC_BASE_URL` /
`OPENAI_BASE_URL`.

**The problem:** the local instance only exists while his Windows box is on. It
is also a single point of failure — a crash, a reboot, or a botched upgrade
takes every local tool offline with it.

**The goal:** a second OmniRoute instance running on Render.com, reachable
24/7 from anywhere, carrying the same provider configuration so local tools
can fall back to it (and so it can serve as a second gateway for the local
box). The local instance stays the primary; the cloud one is a resilient
standby that is also directly usable.

**Why this is not a "just deploy the Docker image" task.** Three Render
constraints interact badly with Omniroute's design, and each one forced a
specific decision below. Getting any of them wrong produces a service that
looks deployed but silently loses its configuration, its memory, or its
credentials.

---

## 2. Goals, non-goals, anti-goals

### Goals
- G1. A Render-hosted OmniRoute reachable at a public HTTPS URL.
- G2. Carries over the local provider configuration: all 16 provider
  connections, all 5 combo definitions, the API keys, and the routing
  settings.
- G3. Survives Render's 15-minute idle spin-down and every redeploy without
  losing configuration.
- G4. Runs within Render's free tier (0.1 CPU / 512 MB) without being
  OOM-killed.
- G5. Credentials are encrypted at rest and the local encryption key never
  leaves Heet's machine.
- G6. The dashboard is protected by a password that is **not** reused from the
  local instance.

### Non-goals
- N1. Replicating the local instance's 1.3 GB of chat history, call logs, and
  usage analytics. That is local observability data with no value on a cold
  cloud standby, and it is the single biggest obstacle to shipping a seed DB
  (see §4).
- N2. Replacing the local instance. Both run; the local one stays primary.
- N3. Running the `web` image variant (Chromium/Playwright). It is 907 MB and
  would not fit the 512 MB tier. The web-cookie providers (gemini-web,
  claude-web, claude-turnstile) are therefore unavailable on the cloud
  instance.
- N4. Support for the local SOCKS5 proxy fleet (see §4.3).
- N5. Zero-downtime migration of the local instance's OAuth sessions. The 4
  OAuth connections are seeded and tested; any that fail refresh get
  re-authenticated by hand in the cloud dashboard.

### Anti-goals (what would make this a failure even if it technically works)
- A1. **An instance that boots but silently serves zero providers** because the
  seed DB failed to restore, or the credentials failed to decrypt. A "green"
  Render deploy that 401s or returns an empty model list is the worst
  outcome — it looks working.
- A2. **A publicly reachable, unauthenticated LLM proxy.** Render assigns a
  public `*.onrender.com` URL. An anonymous `/v1` proxy on the public
  internet is an open relay on Heet's provider credentials.
- A3. **A service that OOM-crashes under a real request** because the heap
  ceiling was left at the image default (1024 MB) on a 512 MB box.
- A4. **Leaking the local `STORAGE_ENCRYPTION_KEY`**, the local dashboard
  password hash, or the SOCKS5 proxy credentials to a public repo.

---

## 3. Constraints (all verified, not assumed)

### 3.1 Render free tier
| Constraint | Value | Source |
|---|---|---|
| Compute | 0.1 CPU / 512 MB RAM | Render docs, Compute Plans |
| Spin-down | After 15 min with no inbound traffic; ~1 min cold start | Render docs, Free |
| Filesystem | **Ephemeral.** Lost on redeploy, restart, *and spin-down* | Render docs, Free |
| Persistent disk | **Not available on free tier** | Render docs, Free |
| Secret files | Mounted at `/etc/secrets/<name>`; **1 MB combined cap**; non-root reader needs group 1000 | Render docs, env vars + Docker secrets |
| Blueprint `secretFiles` | **Not supported** — must be added via dashboard or API | Render Blueprint spec |
| Monthly hours | 750 free instance-hours per workspace | Render docs, Free |

### 3.2 Omniroute runtime
| Constraint | Value | Source |
|---|---|---|
| Image heap default | `OMNIROUTE_MEMORY_MB=1024` | upstream Dockerfile |
| Health endpoint | `/healthz` — in-memory, no DB access | upstream `scripts/dev/healthcheck.mjs` |
| Image `REQUIRE_API_KEY` | `true` (published image default) | upstream Dockerfile |
| Credential encryption | AES-256-GCM, `enc:v1:<iv>:<ct>:<tag>`, key = `scrypt(secret, "omniroute-field-encryption-v1", 32)` | upstream `src/lib/db/encryption.ts` |
| API key CRC | `pbkdf2(machineId+keyId, API_KEY_SECRET, 1000, 32, sha256)` → 8 hex chars | upstream `src/shared/utils/apiKey.ts` |
| API key validation | SHA-256 of the key compared to `key_hash`; **CRC is not checked at auth time** | upstream `src/lib/db/apiKeys.ts` |
| Password bootstrap | Stored bcrypt hash wins; else `INITIAL_PASSWORD` is hashed and stored | upstream `src/lib/auth/managementPassword.ts` |
| Boot secret resolution | `process.env` > `.env` > `{DATA_DIR}/server.env`; auto-generates missing secrets and **refuses** to auto-generate `STORAGE_ENCRYPTION_KEY` if encrypted rows exist | upstream `scripts/build/bootstrap-env.mjs` |

### 3.3 The local instance (measured)
| Fact | Value |
|---|---|
| `storage.sqlite` | 835 MB, 835,309,568 bytes |
| `storage.sqlite-wal` | 506 MB, 506,591,112 bytes |
| Provider connections | 16 (12 API-key, 4 OAuth) |
| API keys | 9, all distinct, plaintext `sk-…` in the `key` column |
| Combos | 5 |
| SOCKS5 proxies | 10, **plaintext username + password** in `proxy_registry` |
| `key_value` rows | 928 (settings, model overrides, provider defaults) |
| Chat history | 906,019 `conversation_turn_nodes` + 100,562 `proxy_logs` + 77,587 `usage_history` |
| Config-only trim | 2,699,168 bytes (2.57 MB) / 1,769 rows / 173 KB gzipped / 231 KB base64 |

### 3.4 Worked example of the 1.3 GB problem
The three largest tables are pure local observability. Stripping them and
keeping only configuration tables:

```
cleared tables: 88
rows kept:      1769
  key_value=928  model_context_overrides=474  _omniroute_migrations=193
  model_intelligence=100  provider_connections=16  api_keys=9  combos=5
size: 2,695,168 bytes (2.57 MB) → 173 KB gzipped → 231 KB base64
```

231 KB base64 is comfortably under Render's 1 MB secret-file cap. The full
1.3 GB database is not, and would not be in a Docker image layer either.

---

## 4. Design

### 4.1 The core insight: free-tier spin-down forces re-seeding on every boot

Because the free tier's filesystem is ephemeral **and spin-down is routine**,
the instance cannot rely on state surviving between requests. Every cold start
begins with an empty `DATA_DIR`.

Therefore the design cannot be "ship a DB and let it persist." It must be
**"ship a seed, and rehydrate from it on every boot."** This single fact
determines the whole architecture:

```
Render cold start
  │
  ├─ entrypoint.sh runs
  │    ├─ reads /etc/secrets/seed.b64      (base64 gzip of the seed DB)
  │    ├─ gunzip + base64 -d → $DATA_DIR/storage.sqlite
  │    ├─ reads /etc/secrets/server.env     (JWT/API_KEY/STORAGE keys)
  │    ├─ exports them into the environment
  │    └─ exec node dev/run-standalone.mjs
  │
  └─ OmniRoute boots against the restored DB
```

The seed DB is restored on **every** boot, so the instance always comes up
with full configuration regardless of how it was torn down. The cost is that
any *runtime* state (new provider connections added via the cloud dashboard,
new API keys created in the cloud) is lost on the next cold start. That is
the accepted trade-off of the free tier; §4.6 documents how to make durable
changes.

### 4.2 Component: the seed database

Built by `tools/make-seed.mjs` on Heet's machine from two sources:

- `~/.omniroute/storage.sqlite` — for config rows, combos, settings.
- `omniroute auth export --format json --force` — for **plaintext**
  credentials.

**Using the plaintext export as the credential source is the key security
decision.** The local `STORAGE_ENCRYPTION_KEY` is never read, copied, or
shipped. The seed builder encrypts each credential from scratch under a
**brand-new** key, generated fresh at seed-build time. Consequences:

- The local key never leaves the machine. ✓
- The cloud instance's key is independent of the local one, so a compromise of
  the cloud instance reveals nothing about the local instance. ✓
- The `bootstrap-env.mjs` guard ("refusing to auto-generate
  `STORAGE_ENCRYPTION_KEY`: encrypted credentials already exist") is
  satisfied by shipping the matching key in `server.env`. ✓

The seed builder also:

- Strips the `password` row from `key_value` so the cloud instance bootstraps
  its own password from `INITIAL_PASSWORD` (G6, A4).
- Deletes `proxy_registry`, `proxy_assignments`, `proxy_scope_rotation`,
  `free_proxies`, `upstream_proxy_config`, and sets `proxy_enabled = 0` on
  every connection (A4, N4).
- Verifies every credential round-trips through decrypt→encrypt→decrypt under
  the new key before writing the output. A silent decryption failure here
  would produce exactly the A1 failure mode.

### 4.3 Non-goal N4 detail: why the SOCKS5 proxies are dropped

`proxy_registry` holds 10 SOCKS5 proxies with **plaintext** `username` and
`password`, pointing at IPs (`31.59.20.176`, `45.38.107.97`, …) that a Render
instance cannot route to. Shipping them would put those credentials in a
public-facing artifact for no benefit. `proxy_assignments` binds one of them
to the `opencode-zen` connection, so dropping the registry also requires
clearing per-connection proxy flags — otherwise the seeded connections would
reference a proxy that no longer exists and fail at request time.

All 16 connections are set to `proxy_enabled = 0, per_key_proxy_enabled = 0`.

### 4.4 Component: the Docker image

The published image `diegosouzapw/omniroute:3.8.52` (443 MB) is used as the
base rather than building from source — the upstream build needs 6 GB of RAM
and 12+ minutes, and Render's builders are memory-constrained. The upstream
Dockerfile's own comment notes Turbopack is OOM-killed on constrained
builders.

The deploy Dockerfile is a thin layer:

```dockerfile
FROM diegosouzapw/omniroute:3.8.52

# Render secret files are root-owned by default; the image runs as `node`
# (uid 1000). Grant group 1000 read access (Render docs: Docker secrets).
USER root
RUN chgrp -R 1000 /etc/secrets && chmod -R g+r /etc/secrets
USER node

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
```

The upstream image's own `ENTRYPOINT` (`check-permissions.sh`) is replaced
because the deploy needs to run the restore step *before* the server starts.
`check-permissions.sh` is preserved in spirit: the entrypoint warns if
`DATA_DIR` is not writable.

**Version pinning:** `3.8.52`, not `latest`. `latest` tracks the highest
published stable SemVer and can advance under the service at any time.

### 4.5 Component: the entrypoint

```sh
#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

# 1. Restore the seed DB (present on every cold start).
if [ -f /etc/secrets/seed.b64 ]; then
  # Remove any prior copy first. A stale storage.sqlite would be silently
  # kept if the restore failed, and a leftover -wal/-shm pair would block the
  # write. (Found by the local spike: a previous instance's -shm/-wal left
  # the restore failing with EACCES and the server booted on stale data.)
  rm -f "$DATA_DIR/storage.sqlite" "$DATA_DIR/storage.sqlite-wal" "$DATA_DIR/storage.sqlite-shm"
  base64 -d < /etc/secrets/seed.b64 | gunzip > "$DATA_DIR/storage.sqlite"
  chown node:node "$DATA_DIR/storage.sqlite"
fi

# 2. Load the secrets that the DB's encrypted rows require.
if [ -f /etc/secrets/server.env ]; then
  set -a; . /etc/secrets/server.env; set +a
fi

# 3. Render injects PORT; single-port mode serves dashboard + API together.
exec node dev/run-standalone.mjs
```

**The `rm -f` is not optional.** The local spike caught the failure mode
directly: with a previous instance's `storage.sqlite-wal` / `-shm` still
present, the restore failed with `Permission denied`, the entrypoint's
`set -e` aborted the restore, and the server went on to boot against the
*stale* database — a silent, green-looking failure (anti-goal A1). Removing
the old files first makes the restore idempotent and self-healing.

Critical detail: `bootstrap-env.mjs` resolves secrets in the order
`process.env` > `.env` > `{DATA_DIR}/server.env`, and **auto-generates**
`JWT_SECRET` / `API_KEY_SECRET` when missing — persisting them to
`{DATA_DIR}/server.env`. On an ephemeral filesystem that file is lost on every
spin-down, so the JWT secret would rotate on every cold start, invalidating
dashboard sessions. Shipping `JWT_SECRET` and `API_KEY_SECRET` in
`server.env` and exporting them keeps them stable across cold starts.

`STORAGE_ENCRYPTION_KEY` **must** be in that file — without it,
`bootstrap-env.mjs` hits the encrypted-credentials guard and refuses to boot
rather than silently wiping the credentials.

**`INITIAL_PASSWORD` also goes in `server.env`, not in a separate Render
environment variable.** The spike showed the local install picking up
`INITIAL_PASSWORD=CHANGEME` from `~/.omniroute/.env` and warning loudly
about it. On Render there is no `~/.omniroute/.env`, but the same class of
problem is possible wherever a stray `.env` exists. Putting every secret in
the single `server.env` file and exporting it into `process.env` — which
`bootstrap-env.mjs` treats as highest priority — makes the precedence
explicit and leaves no room for an ambient file to supply a password.

### 4.6 Component: making runtime changes durable

The free tier cannot persist runtime state, so any change made *in the cloud
dashboard* is lost on the next cold start. The documented workflow:

1. Make the change in the cloud dashboard (add a provider, create an API key,
   add a combo).
2. Re-run the local seed builder with an updated `auth export` so the change
   is captured in the next seed.
3. Re-upload `seed.b64` and `server.env` as Render secret files and trigger
   a redeploy.

`tools/make-seed.mjs` is the single source of truth for this loop, and
`tools/upload-secrets.mjs` automates step 3 via the Render API.

**Alternative for the API-key case only:** the `OMNIROUTE_API_KEY`
environment variable is special-cased in `apiKeys.ts` — a bearer token equal
to it is accepted and granted a synthesized `manage` scope, and it is not
stored in the DB. A Render *environment variable* (not a secret file) is
therefore a durable way to hold one always-valid management key that survives
spin-down. This is the recommended way to authenticate a client against the
cloud instance. Note that `generateApiKeyWithMachine` embeds a CRC derived
from `API_KEY_SECRET`; the CRC is **not** verified at auth time (validation is
`SHA-256(key) == key_hash`), so an `OMNIROUTE_API_KEY` set as a plain env var
works regardless of which `API_KEY_SECRET` is in effect.

### 4.7 Component: memory sizing

Render free = 512 MB. The upstream image sets `OMNIROUTE_MEMORY_MB=1024`,
which is larger than the entire container — Node reads the host's RAM for its
heap heuristic, not the cgroup limit, so the heap would be sized for a
larger box and the container would be OOM-killed.

Render environment variables:

| Variable | Value | Reason |
|---|---|---|
| `OMNIROUTE_MEMORY_MB` | `256` | ~half the 512 MB box, leaving room for native memory (better-sqlite3, buffers, ~300 MB per upstream's own guidance) |
| `PORT` | `10000` | Render injects `PORT`; the image honours it |
| `HOSTNAME` | `0.0.0.0` | Bind all interfaces (the image default) |
| `REQUIRE_API_KEY` | `true` | Image default; **must not** be relaxed (A2) |
| `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK` | `true` | See below |

**`INITIAL_PASSWORD` and `OMNIROUTE_API_KEY` live in `server.env`**, not in
Render environment variables. §4.5 explains why: `process.env` is
`bootstrap-env.mjs`'s highest-priority source, so sourcing `server.env`
guarantees the intended values win over any ambient `.env` file, and it
keeps every secret in exactly one uploadable artifact.

**On the credential health check.** During local testing, the instance
performed a proactive token-refresh sweep at boot; a refresh to
`oidc.us-east-1.amazonaws.com` hung for 60 s and delayed the first successful
`/healthz` response to ~20 s. On Render's 0.1-CPU tier this would burn the
cold-start budget and, on a 15-minute spin-down cycle, recur constantly.
Setting `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true` suppresses the
proactive sweep. **Measured effect:** with the sweep disabled the same build
reached a healthy `/healthz` in **~6 s** instead of ~20 s. The trade-off:
OAuth tokens are then refreshed reactively on a 401 rather than proactively.
Given the OAuth connections are already flagged as needing post-deploy
verification (§8), this is the right default — but it is recorded here as a
deliberate trade-off, not an oversight.

### 4.8 Component: keep-alive

Render's free tier spins down after 15 minutes of no inbound traffic, and the
cold start is ~1 minute. Heet chose the free tier plus keep-alive pings.

The keep-alive is a GitHub Actions workflow (in the deploy repo) that pings
`GET /healthz` every 10 minutes. Rationale for a scheduled workflow over an
external cron service: it lives in the same private repo as the deployment,
needs no third-party account, and cannot be silently broken by someone
else's outage. A `cron-job.org` ping is the documented fallback if the
workflow's schedule proves unreliable.

**This is a mitigation, not a fix.** A pinger cannot prevent spin-down during
a GitHub Actions outage, and Render's own cold start remains ~1 minute on the
first request after any missed ping. Heet accepted this in exchange for
avoiding the ~$7/mo that a paid instance with a persistent disk would cost.
The design keeps the paid-instance path open (§9) — the seed/entrypoint
architecture is identical for both, and a paid instance would additionally
allow a real persistent disk and drop the pinger entirely.

---

## 5. Security model

| Asset | Where it lives | Exposure |
|---|---|---|
| Provider credentials (12 API keys, 4 OAuth token sets) | `seed.sqlite`, AES-256-GCM, encrypted under a key generated at seed time | Render secret file `seed.b64` (base64+gzip — **encoding, not encryption**; the DB's own encryption is the real protection) |
| `STORAGE_ENCRYPTION_KEY`, `JWT_SECRET`, `API_KEY_SECRET` | `server.env` | Render secret file |
| Dashboard password | `INITIAL_PASSWORD` env var → bcrypt-hashed into the DB at boot | Render env var (secret) |
| Local `STORAGE_ENCRYPTION_KEY` | Heet's machine only | **Never shipped** |
| Local dashboard password hash | Heet's machine only | Stripped from the seed |
| SOCKS5 proxy credentials | Heet's machine only | **Stripped from the seed** |
| The cloud gateway's public URL | The internet | Protected by `REQUIRE_API_KEY=true` + per-client API keys |

**Residual risk, stated plainly:** the seed DB is uploaded to Render as a
secret file, and Render's secret files are base64/gzip — a determined
attacker with read access to the Render service's secret store can decode
`seed.b64` and then needs `STORAGE_ENCRYPTION_KEY` from `server.env` to
decrypt the credentials. Both files are on the same service, so this is a
single-service compromise. The mitigation is that the credentials are
provider-scoped, revocable, and the local instance's key is unaffected. The
stronger mitigation is a paid instance with no public credential surface
beyond what Heet chooses to expose.

**An important non-goal:** this design does not attempt to make the cloud
instance safe for *untrusted* users. It is Heet's own gateway on the public
internet, protected by an API key. If that is not acceptable, the answer is
to put it behind a VPN or a paid instance with IP restrictions — not to
harden this one.

---

## 6. Repository layout

New **private** repo: `Heetisk/omniroute-render`

```
omniroute-render/
├── Dockerfile                  # thin layer on diegosouzapw/omniroute:3.8.52
├── entrypoint.sh               # seed restore + secret load + exec server
├── render.yaml                 # Blueprint (no secretFiles — added via API/dashboard)
├── .github/workflows/
│   ├── keepalive.yml           # pings /healthz every 10 min
│   └── deploy.yml              # (optional) redeploy on secret change
├── tools/
│   ├── make-seed.mjs           # builds seed.sqlite + seed.b64 + server.env
│   ├── trim-db.mjs             # config-only extraction from local storage.sqlite
│   └── upload-secrets.mjs      # pushes secret files via Render API
├── docs/
│   ├── DEPLOY.md               # step-by-step Render setup
│   └── superpowers/specs/2026-10-21-omniroute-render-deployment-design.md
└── .gitignore                  # seed.sqlite, seed.b64, server.env, auth-export.json
```

**Nothing secret is committed.** `seed.sqlite`, `seed.b64`, `server.env`, and
`auth-export.json` are all git-ignored. The repo contains only the Dockerfile,
the entrypoint, the tools, and documentation.

**Local secret hygiene.** The seed-building step produces two files that must
be treated as live secrets on Heet's machine:

| File | Contents | Handling |
|---|---|---|
| `auth-export.json` | **Plaintext** API keys and OAuth tokens for all 16 providers | Delete immediately after `make-seed.mjs` runs. It is the only artifact with plaintext credentials. |
| `seed.server-env` | `JWT_SECRET`, `API_KEY_SECRET`, `STORAGE_ENCRYPTION_KEY` | Delete after the secret file is uploaded to Render. |
| `seed.sqlite` / `seed.b64` | Credentials encrypted under the new key | Delete after upload. |
| `seed.storage-encryption-key` | The new encryption key, in the clear | Delete after upload. |

`tools/make-seed.mjs` should therefore write its outputs to a
git-ignored working directory and print a reminder to delete them once the
upload is confirmed. Heet's local `~/.omniroute/storage.sqlite` is untouched
by the whole procedure — the seed is a derived artifact, and the local
instance remains the source of truth.

---

## 7. Deployment steps (Heet executes)

1. **Build the seed locally** — `node tools/trim-db.mjs && node tools/make-seed.mjs`
   → produces `seed.b64` (231 KB) and `server.env`.
2. **Create the Render service** — New → Web Service → connect `Heetisk/omniroute-render`
   → Runtime: Docker → Region: Oregon → Plan: Free.
3. **Set environment variables** (Render dashboard → Environment):
   `OMNIROUTE_MEMORY_MB=256`, `REQUIRE_API_KEY=true`,
   `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true`.
   `INITIAL_PASSWORD` and `OMNIROUTE_API_KEY` go in `server.env` (§4.7).
4. **Add secret files** (Render dashboard → Secret Files):
   `seed.b64` (contents of `seed.b64`), `server.env` (contents of `server.env`).
   *Or* run `node tools/upload-secrets.mjs` with a Render API key.*
5. **Set the health check path** to `/healthz` (Render dashboard → Health
   Check Path). Render does **not** use the image's `HEALTHCHECK` instruction
   for Docker services — it runs its own probes, defaulting to a TCP socket
   check. `/healthz` is the upstream's lightweight in-memory lifecycle
   endpoint; the deeper `/api/monitoring/health` route is explicitly
   discouraged as a container health check upstream because it does
   synchronous SQLite reads and can mark a busy container unhealthy.
6. **Deploy** and watch the log for the restore banner and `Ready`.
7. **Verify** — see §8.
8. **Enable keep-alive** — the workflow in `.github/workflows/keepalive.yml`
   needs the service URL pasted in as a repo secret, then must be enabled
   manually (GitHub disables workflows on first push to a new repo).

---

## 8. Verification plan

Ordered so that each step's failure is unambiguous, and each is checked
against a specific anti-goal.

| # | Check | Expected | Guards |
|---|---|---|---|
| V1 | Render deploy log shows the seed restore line and `Ready in …` | both present | A1 |
| V2 | `GET /healthz` returns 200 | 200 | — |
| V3 | `GET /v1/models` **without** a key | 401 | A2 |
| V4 | `GET /v1/models` with `OMNIROUTE_API_KEY` | 200, non-empty `data[]` | A1 |
| V5 | `GET /v1/models` with a migrated per-client key (e.g. `claude`) | 200, 2000+ models | A1 |
| V6 | `POST /v1/chat/completions` with `qoder/glm-5.2` (an API-key provider) | 200, real content | A1, A3 |
| V7 | `POST /v1/chat/completions` with a `codex/*` model (OAuth) | 200, **or** a clear 401-auth error | §9 risk |
| V8 | Dashboard login with `INITIAL_PASSWORD` | login succeeds | G6 |
| V9 | Dashboard → Providers shows 16 connections, 5 combos | counts match | A1 |
| V10 | Wait 16 min idle, then re-run V2/V4 | 200 (after ~1 min cold start) | G3 |
| V11 | Trigger a redeploy, re-run V4 | 200, config intact | G3 |
| V12 | Container memory under load | no OOM-kill in the deploy log | A3 |

**Already validated locally** (spike, on this machine, against the real
upstream v3.8.51 build, using the exact seed + entrypoint + tools from this
repo):

| Spike result | Detail |
|---|---|
| Seed DB boots with no decryption errors | 16 connections, 16 credential fields re-encrypted and round-trip verified |
| Auth is enforced | 401 on unauthenticated `/v1/models` **and** `/api/providers` |
| Migrated API key authenticates | `/v1/models` → 200, **2,849–2,873 models** (count varies with the live catalog) |
| Live inference through a re-encrypted credential | `POST /v1/chat/completions` → `qoder/glm-5.2` → 200, `"content":"PONG"` |
| `OMNIROUTE_API_KEY` env mechanism works | 200, all 16 connections visible with synthesized `manage` scope |
| **Full rehydrate from a wiped `DATA_DIR`** | Wiped `DATA_DIR` → entrypoint restored the seed (2,695,168 bytes) + loaded 6 secrets → server ready → `/healthz` 200 → 401 unauth → 2,849 models with auth → live inference **"PONG"** again |
| Health-check flag effect | ~6 s to healthy `/healthz` with `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK=true`, vs ~20 s without |

The rehydrate test is the important one: it is the exact scenario Render's
spin-down produces, and it passed end-to-end including live inference.

**One finding from the spike, and it is not a defect in the design.** The 4
OAuth connections (`codex`, `kiro`, `kilocode`, `grok-cli`) returned **429
quota-exhausted**, not 401 auth errors. The identical error is returned by
the *local* instance for the same models at the same time, so this is real
upstream account state, not a migration artifact. The meaningful signal is
the error class: a **quota** error means the token decrypted and the
upstream provider recognised the account, which is exactly what "the
migration worked" looks like. A failed migration would have produced a 401.
`grok-cli` returned 401 "No active credentials" — correct, because that
connection is `is_active = 0` locally and was migrated as-is.

**A second finding, which was a real bug in the first draft of the
entrypoint.** The restore step originally wrote straight over any existing
`storage.sqlite`. With a previous instance's `-wal`/`-shm` still present, the
write failed with `Permission denied`, the entrypoint's `set -e` aborted the
restore, and the server went on to boot against the **stale** database — a
green-looking deploy with the wrong data. The fix is `rm -f` the old DB and
its sidecars before restoring, which makes the restore idempotent and
self-healing. This is the exact failure mode anti-goal A1 describes, caught
by the spike rather than shipped.

V1–V12 re-validate the same properties on Render's hardware.

---

## 9. Known risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OAuth refresh tokens are IP-bound or single-device; Render's egress IP changes | Medium | 4 of 16 connections unusable | Seed and test; re-auth those 4 by hand in the cloud dashboard (N5). Heet chose to include them and verify rather than drop them. |
| The 4 OAuth accounts are currently quota-exhausted upstream | **Observed** | Those 4 providers return 429 until the quota window resets | Not a migration defect — the local instance returns the same 429 at the same time. The spike confirmed the tokens decrypt and are recognised upstream (429 = quota, not 401 = auth). Re-test after the quota window resets. |
| 512 MB is too tight under concurrent load | Low–Medium | OOM-kill, service restarts | `OMNIROUTE_MEMORY_MB=256`; V12. Fall back to the `$7/mo` paid tier, which also gives a persistent disk. |
| GitHub Actions keep-alive misses a window | Medium | ~1 min cold start, not an outage | 10-minute interval vs. a 15-minute spin-down gives 5 minutes of slack. `cron-job.org` as a second pinger. |
| Free tier's 750 instance-hours/month is exceeded | Low | Service suspended for the rest of the month | 750 hours covers one always-on service with ~2× headroom. |
| Seed DB and server.env compromised together | Low | All provider credentials exposed | Keys are provider-scoped and revocable; the local instance's key is unaffected. A paid instance is the stronger posture. |
| A future `3.8.5x` changes the schema or the encryption format | Low | Boot failure or credential loss | Version-pinned image; the seed is rebuilt from the local instance on demand. |
| The `web` image variant is needed for gemini-web / claude-web providers | Low (not currently required) | Those 3 providers unavailable | N3. Requires a paid tier (907 MB image + browser RAM). |

---

## 10. Open questions for Heet

1. **Keep-alive pinger placement.** GitHub Actions (in-repo, no third-party
   account) vs. cron-job.org (external, independent of GitHub). Recommendation:
   GitHub Actions first, cron-job.org as a backstop. *The repo ships the
   GitHub Actions version.*
2. **Whether to also add an IP allowlist** to the cloud API keys
   (`ip_allowlist` exists in the `api_keys` table) once Heet's home egress IP
   is known. This would materially reduce A2's blast radius — it is the
   cheapest meaningful hardening available and it costs nothing but knowing
   the home IP.
3. **Whether to run a second seed build with the OAuth connections
   excluded**, as a fallback if the 4 OAuth refreshes turn out to be
   IP-bound in practice. The seed builder already excludes any connection
   you remove from the export, so this is a config change, not a code change.
4. **Backup of the local instance.** The seed is generated from the local
   OmniRoute DB. If the local DB is lost, the seed can be rebuilt — but only
   from credentials that still exist upstream. Worth a separate local
   backup routine, out of scope here.

---

## 11. Builder decisions (explicitly left to the implementer)

- The exact wording and structure of the `tools/*.mjs` scripts beyond the
  interfaces described in §4.2 and §6.
- Whether `make-seed.mjs` shells out to `omniroute auth export` or reads a
  previously-exported `auth-export.json` (the latter is preferred — it avoids
  writing plaintext credentials to disk twice — but either satisfies §4.2).
- Log formatting in `entrypoint.sh`, and whether it prints the seed's
  credential count (a useful boot-time assertion that the restore worked) or
  keeps the log quiet.
- The exact Render API calls in `tools/upload-secrets.mjs`, subject to the
  documented endpoint `PUT /services/{serviceId}/secret-files/{envVarKey}`
  with body `{"content": "…"}`.
- Whether `render.yaml` is committed at all, given `secretFiles` is not
  supported by the Blueprint spec and the service will be created manually.

---

## 12. Known gaps at the time of writing

Recorded so the next person does not mistake them for oversights.

1. **`tools/upload-secrets.mjs` is not written.** The design and the
   deployment guide both reference it as the automated path for uploading
   the two secret files. The manual path (Render dashboard → Secret Files)
   is fully specified and is the primary path; the script is an automation
   convenience that still needs writing, and it needs a Render API key
   whose handling has not been designed.
2. **`render.yaml` is not committed.** The Blueprint spec does not support
   `secretFiles`, so a Blueprint can create the service but cannot populate
   the secrets, and the service must be created manually anyway. Committing
   a half-working Blueprint would imply more automation than exists.
3. **The Docker image has not been built and run.** The `Dockerfile` is
   written against the published image's documented layout (verified:
   `dev/run-standalone.mjs` and `build/bootstrap-env.mjs` are both copied
   into the standalone bundle by upstream's `assembleStandalone.mjs`), and
   the entrypoint's *logic* was validated end-to-end locally against the
   real upstream v3.8.51 build. But Docker was not available in this
   environment, so the container has not been built, the group-1000 secret
   permission fix has not been exercised, and the `/app` working directory
   assumption in the `ENTRYPOINT` has not been confirmed against the real
   image. **V1 is the first check of this, and the first thing to try if the
   deploy fails.**
4. **The keep-alive workflow has not been observed working.** The schedule
   is standard and the curl is simple, but GitHub disables workflows on the
   first push to a new repository, so it must be enabled manually, and the
   pinger has not been observed preventing a spin-down in practice.
5. **Render-side behaviour is unverified.** Every constraint in §3.1 comes
   from Render's documentation, not from an actual deployment. The first
   deploy is the first real test of the 512 MB ceiling, the ~1 minute cold
   start, the 1 MB secret-file cap in practice, and the spin-down
   behaviour.
