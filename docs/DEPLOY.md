# Deploying OmniRoute to Render (free tier)

This deploys a second, 24/7 OmniRoute instance that mirrors your local
configuration. The local instance stays primary; the cloud one is a resilient
standby that is also directly usable.

The full design — including every constraint that shaped it — is in
[`docs/superpowers/specs/2026-10-21-omniroute-render-deployment-design.md`](superpowers/specs/2026-10-21-omniroute-render-deployment-design.md).

---

## Why there is a "seed" step at all

Render's free tier has an **ephemeral filesystem**: it is wiped on every
redeploy *and* on every 15-minute idle spin-down. A persistent disk is not
available on the free tier.

So the instance cannot keep state between requests. Instead, it **rehydrates
its entire configuration from a seed on every cold start**. That is what
`tools/make-seed.mjs` and `entrypoint.sh` are for.

---

## Step 1 — Build the seed (on your machine)

```bash
cd omniroute-render

# 1a. Extract the config-only subset of your local database.
node tools/trim-db.mjs

# 1b. Export plaintext credentials (this is the ONLY step that writes
#     plaintext keys to disk). Keep the file; delete it afterwards.
omniroute auth export --format json --out auth-export.json --force

# 1c. Build the seed: re-encrypt every credential under a NEW key, strip
#     local-only state, and emit the uploadable artifacts.
node tools/make-seed.mjs
```

You should end up with:

| File | Size | Purpose |
|---|---|---|
| `seed.sqlite` | 2.6 MB | the seed database (git-ignored) |
| `seed.sqlite.gz.b64` | ~231 KB | base64+gzip, what you upload as `seed.b64` |
| `seed.server-env` | ~430 B | `JWT_SECRET`, `API_KEY_SECRET`, `STORAGE_ENCRYPTION_KEY`, `INITIAL_PASSWORD` |

`make-seed.mjs` prints a reminder to delete these once the upload is done.

> **Your local `STORAGE_ENCRYPTION_KEY` is never used or shipped.** The seed
> is built from the *plaintext* export and encrypted under a brand-new key
> generated at seed time. Your local instance is unaffected.

---

## Step 2 — Create the Render service

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect the `omniroute-render` repository
3. Settings:
   - **Runtime**: Docker
   - **Build Command**: *(leave empty — Docker runtime ignores it)*
   - **Health Check Path**: `/healthz`
   - **Instance Type**: Free
4. **Create Web Service**

---

## Step 3 — Environment variables

Render dashboard → your service → **Environment**:

| Key | Value | Why |
|---|---|---|
| `OMNIROUTE_MEMORY_MB` | `256` | The image defaults to 1024 MB, larger than the whole 512 MB box. 256 leaves room for native memory. |
| `REQUIRE_API_KEY` | `true` | Never relax this — the service has a public URL. |
| `OMNIROUTE_DISABLE_CREDENTIAL_HEALTH_CHECK` | `true` | The boot-time token-refresh sweep stalls the first request; disabling it took startup from ~20 s to ~6 s. |

`INITIAL_PASSWORD` and `OMNIROUTE_API_KEY` go in `server.env` (next step),
not here — that keeps every secret in one artifact and makes the precedence
explicit.

---

## Step 4 — Secret files

Render dashboard → your service → **Secret Files** → **Add**:

| Filename | Contents |
|---|---|
| `seed.b64` | the full contents of `seed.sqlite.gz.b64` |
| `server.env` | the full contents of `seed.server-env` |

Combined size must stay under **1 MB** — the seed is ~231 KB, so there is
plenty of room.

**Or upload them with the API** (needs an API key from
[dashboard.render.com/account/api-keys](https://dashboard.render.com/account/api-keys)):

```powershell
$env:RENDER_API_KEY = 'rnd_...'
node tools/upload-secrets.mjs --name omniroute-render
```

Add `--dry-run` first to check the sizes without uploading.

> `server.env` must contain `STORAGE_ENCRYPTION_KEY`. Without it the server
> refuses to boot rather than silently wiping your credentials, because it
> detects encrypted rows it cannot decrypt.

**Before you upload, set a strong `INITIAL_PASSWORD` in `server.env`.** Open
the file and replace the generated placeholder. That password is the only
thing protecting the dashboard on a public URL.

> **Note on file permissions.** Render mounts secret files owned by root with
> mode 0600, so only root can read them — and the upstream image runs the
> server as the non-root `node` user. This is why `Dockerfile` starts the
> container as root and `entrypoint.sh` drops privileges to uid 1000 after
> reading the secrets. If you fork this deploy, keep that behaviour: a
> container that starts as `node` cannot read its own secret files and will
> boot with an empty database.

---

## Step 5 — Deploy and verify

Deploy, then check the log for:

```
[entrypoint] restored seed database (2695168 bytes)
[entrypoint] loaded 4 secrets from /etc/secrets/server.env
```

Then run the verification table from the design doc (§8). The minimum:

```bash
URL=https://omniroute-render.onrender.com

curl -s $URL/healthz                        # -> ok
curl -s -o /dev/null -w '%{http_code}\n' $URL/v1/models   # -> 401
curl -s -H "Authorization: Bearer $OMNIROUTE_API_KEY" $URL/v1/models | head -c 200
```

---

## Step 6 — Enable keep-alive

Render's free tier sleeps after 15 minutes idle. The repo has
`.github/workflows/keepalive.yml`, which pings `/healthz` every 10 minutes.

1. Repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret** → name `RENDER_URL`, value your service URL.
2. Repo → **Actions** → enable the `keepalive` workflow. GitHub disables
   workflows on the first push to a new repo, so this step is required.

---

## Making changes to the configuration later

The free tier cannot persist runtime state, so **anything you change in the
cloud dashboard is lost on the next cold start.**

To make a change stick:

1. Make it in the cloud dashboard (add a provider, create a key, add a combo).
2. Re-run the Step 1 seed build locally so the change is captured.
3. Re-upload `seed.b64` and `server.env` as secret files.
4. Trigger a redeploy.

`tools/make-seed.mjs` is the single source of truth for this loop.

---

## Upgrading to a paid instance (optional, ~$7/mo)

A paid instance buys two things the free tier cannot give you: no spin-down
(no pinger needed) and a real persistent disk.

The Dockerfile and entrypoint do not change. You would:

- set `plan: starter` (or `1c-2g`)
- mount a disk at `/app/data` and set `DATA_DIR=/app/data`
- raise `OMNIROUTE_MEMORY_MB` to `512` or `1024`
- delete the keep-alive workflow

Because the seed is still restored on every boot, the seed mechanism stays
harmless even with a persistent disk.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Log shows `Refusing to auto-generate STORAGE_ENCRYPTION_KEY` | `server.env` missing or lacks the key | Re-upload `server.env` |
| Log shows `WARNING: /etc/secrets/seed.b64 not found` | The secret file is not attached, or the container is running as a user that cannot read it | Check the Secret Files list. The image must start as root (it does — `entrypoint.sh` drops to uid 1000 after reading) |
| Boot succeeds but `/v1/models` returns an empty list | Seed restore failed silently | Check the log for the `[entrypoint] restored seed database` line. A leftover `-wal`/`-shm` is the usual cause; the entrypoint removes them, but check `DATA_DIR` is writable |
| `401` on every request | `REQUIRE_API_KEY` is not `true`, or the client sends the wrong key | Confirm the env var; use `OMNIROUTE_API_KEY` from `server.env` |
| Dashboard login rejected | `INITIAL_PASSWORD` was never set, or the `.env` precedence bit | Set `INITIAL_PASSWORD` in `server.env`; the entrypoint exports it so it wins |
| `qoder` returns `cli_not_found` | The `qodercli` binary is not in the base image | Expected. Only the `runner-cli` image variant ships it, at the cost of a much larger image |
| OAuth providers return `429` | The upstream account is quota-exhausted | Not a deploy fault — the local instance returns the same. `429` (quota) means the token decrypted fine; `401` would mean it did not |
| First request hangs ~1 min | The instance was asleep | Expected on a cold start; the keep-alive workflow prevents it |
| `500` / OOM in the log | 512 MB is too tight | Lower `OMNIROUTE_MEMORY_MB` to `192`, or move to a paid plan. Measured locally: ~385 MB resident at idle |
