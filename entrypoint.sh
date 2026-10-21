#!/bin/sh
# OmniRoute on Render — cold-start entrypoint.
#
# Render's free tier has an EPHEMERAL filesystem that is wiped on every
# redeploy AND on every 15-minute idle spin-down. So this script does not
# rely on state surviving: it rehydrates the full configuration from a seed
# on EVERY boot.
#
#   1. Restore the seed database  (Render secret file: /etc/secrets/seed.b64)
#   2. Load the secrets          (Render secret file: /etc/secrets/server.env)
#   3. Exec the server
#
# Both secret files are optional at the syntax level, but in practice
# server.env is REQUIRED: without STORAGE_ENCRYPTION_KEY the upstream
# bootstrap refuses to auto-generate one (encrypted credentials already
# exist) and the server will not boot.

set -e

DATA_DIR="${DATA_DIR:-/app/data}"
SEED_FILE="${SEED_FILE:-/etc/secrets/seed.b64}"
SERVER_ENV_FILE="${SERVER_ENV_FILE:-/etc/secrets/server.env}"

mkdir -p "$DATA_DIR"

# ── 1. Restore the seed database ───────────────────────────────────────────
if [ -f "$SEED_FILE" ]; then
  # Remove any prior copy FIRST. A leftover storage.sqlite would be silently
  # reused if the restore failed (green-looking, broken server), and a live
  # -wal/-shm pair left by a previous instance blocks the write outright.
  rm -f "$DATA_DIR/storage.sqlite" \
        "$DATA_DIR/storage.sqlite-wal" \
        "$DATA_DIR/storage.sqlite-shm"

  base64 -d < "$SEED_FILE" | gunzip > "$DATA_DIR/storage.sqlite"

  # The upstream image runs as `node` (uid/gid 1000).
  chown node:node "$DATA_DIR/storage.sqlite" 2>/dev/null || true

  echo "[entrypoint] restored seed database ($(wc -c < "$DATA_DIR/storage.sqlite") bytes)"
else
  echo "[entrypoint] WARNING: $SEED_FILE not found - starting with an empty database"
fi

# ── 2. Load the secrets ───────────────────────────────────────────────────
# `set -a` exports everything the file defines. The upstream bootstrap
# resolves secrets as process.env > .env > {DATA_DIR}/server.env, so
# exporting here guarantees these values win over anything else on disk.
if [ -f "$SERVER_ENV_FILE" ]; then
  set -a
  . "$SERVER_ENV_FILE"
  set +a
  echo "[entrypoint] loaded $(grep -c '=' "$SERVER_ENV_FILE") secrets from $SERVER_ENV_FILE"
else
  echo "[entrypoint] WARNING: $SERVER_ENV_FILE not found - the server will likely refuse to boot"
fi

# ── 3. Hand off to the server ──────────────────────────────────────────────
# `node dev/run-standalone.mjs` is the upstream image's own CMD; it calls
# bootstrap-env (which resolves DATA_DIR, ports, and the heap ceiling) and
# then spawns the WS-aware server. Render injects PORT.
exec node dev/run-standalone.mjs
