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
#   3. Drop privileges to `node` and exec the server
#
# WHY THIS RUNS AS ROOT (and then drops to `node`)
# ----------------------------------------------------
# Render mounts secret files at /etc/secrets owned by root with mode 0600, so
# ONLY root can read them. The upstream image runs its server as the non-root
# `node` user (uid 1000). A container that starts as `node` therefore CANNOT
# read its own secret files — it fails with "Permission denied" and boots
# with an empty database.
#
# Render's documented remedy is to make the files group-readable by the
# application's group (group 1000), but that fix has to be applied to the
# mount AT RUNTIME, and a container that starts as `node` cannot chgrp a
# root-owned file it cannot read.
#
# So: this entrypoint starts as root, does the two things that need root
# (read the secrets, restore the seed), and then permanently drops to uid
# 1000 for the server process. The server itself never runs as root.
#
# The image therefore sets `USER root` and this script is responsible for
# the privilege drop.

set -e

DATA_DIR="${DATA_DIR:-/app/data}"
SEED_FILE="${SEED_FILE:-/etc/secrets/seed.b64}"
SERVER_ENV_FILE="${SERVER_ENV_FILE:-/etc/secrets/server.env}"
APP_UID="${APP_UID:-1000}"
APP_GID="${APP_GID:-1000}"

mkdir -p "$DATA_DIR"

# ── 1. Restore the seed database ───────────────────────────────────────────
if [ -f "$SEED_FILE" ]; then
  # Remove any prior copy FIRST. A leftover storage.sqlite would be silently
  # reused if the restore failed (a green-looking deploy with the wrong
  # data), and a live -wal/-shm pair left by a previous instance blocks the
  # write outright.
  rm -f "$DATA_DIR/storage.sqlite" \
        "$DATA_DIR/storage.sqlite-wal" \
        "$DATA_DIR/storage.sqlite-shm"

  base64 -d < "$SEED_FILE" | gunzip > "$DATA_DIR/storage.sqlite"

  echo "[entrypoint] restored seed database ($(wc -c < "$DATA_DIR/storage.sqlite") bytes)"
else
  echo "[entrypoint] WARNING: $SEED_FILE not found - starting with an EMPTY database"
  echo "[entrypoint] WARNING: no providers will be configured. Check the Render secret files."
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

# Hand the data dir to the unprivileged user, since the server runs as it.
chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true

# ── 3. Drop privileges and hand off to the server ─────────────────────────
# `node dev/run-standalone.mjs` is the upstream image's own CMD; it calls
# bootstrap-env (which resolves DATA_DIR, ports, and the heap ceiling) and
# then spawns the WS-aware server. Render injects PORT.
if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] dropping privileges to uid ${APP_UID}"
  exec setpriv --reuid="$APP_UID" --regid="$APP_GID" --clear-groups \
    env PORT="${PORT:-20128}" \
        DATA_DIR="$DATA_DIR" \
        NODE_ENV=production \
        HOSTNAME=0.0.0.0 \
        NODE_OPTIONS="" \
        "$@" node dev/run-standalone.mjs
fi

# Already unprivileged (e.g. a local `docker run --user 1000`).
exec "$@" node dev/run-standalone.mjs
