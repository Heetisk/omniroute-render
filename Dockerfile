# OmniRoute on Render.
#
# Thin layer on the published upstream image. We do NOT build from source:
# the upstream build needs ~6 GB of RAM and 12+ minutes, and Render's
# builders are memory-constrained (upstream's own Dockerfile notes that
# Turbopack gets OOM-killed on constrained builders).
#
# Pinned to an exact version - `latest` tracks the highest published stable
# SemVer and can advance under the service at any time.

FROM diegosouzapw/omniroute:3.8.52

# The upstream image's ENTRYPOINT is check-permissions.sh; we replace it with
# our own because the seed restore must run BEFORE the server starts.
#
# --chmod is used because a COPY'd file is owned by root, and a `RUN chmod`
# executed as `node` cannot change the mode of a root-owned file.
COPY --chmod=755 entrypoint.sh /app/entrypoint.sh

# This container starts as ROOT on purpose.
#
# Render mounts secret files at /etc/secrets owned by root with mode 0600, so
# only root can read them. The upstream server runs as the non-root `node`
# user (uid 1000). A container that starts as `node` cannot read its own
# secret files and boots with an EMPTY database - a silent, green-looking
# failure.
#
# entrypoint.sh therefore starts as root, reads the secrets and restores the
# seed, and then permanently drops to uid 1000 for the server process via
# setpriv. The server itself never runs as root.
#
# Verified locally: with root-owned 0600 secret files, a container started as
# uid 1000 fails with "Permission denied"; the same container started as root
# reads them and the privilege drop works.
USER root

ENTRYPOINT ["/app/entrypoint.sh"]
