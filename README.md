# omniroute-render

A 24/7 [Omniroute](https://github.com/diegosouzapw/OmniRoute) gateway on
Render's free tier, carrying a copy of your local OmniRoute configuration.

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

The seed + entrypoint were validated end-to-end against the real upstream
build before this repo was written:

| Check | Result |
|---|---|
| Seed boots, no decryption errors | 16 connections, 16 credential fields re-encrypted and round-trip verified |
| Auth enforced | 401 on unauthenticated `/v1/models` and `/api/providers` |
| Migrated API key authenticates | 200, **2,873 models** |
| Live inference via a re-encrypted credential | `qoder/glm-5.2` → 200, `"content":"PONG"` |
| `OMNIROUTE_API_KEY` env mechanism | 200, all 16 connections visible with `manage` scope |
| **Rehydrate from a wiped `DATA_DIR`** | wipe → restore → healthy → 2871 models → inference `"PONG"` again |
| Startup with health check disabled | ~6 s to healthy (vs ~20 s with it on) |
