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

# Render mounts secret files at /etc/secrets owned by root with mode 0600, so
# only root can read them. The upstream image runs as `node` (uid/gid 1000).
# Render's documented fix for a non-root reader is group 1000.
# https://render.com/docs/docker-secrets
USER root
RUN chgrp -R 1000 /etc/secrets 2>/dev/null || true \
 && chmod -R g+r /etc/secrets 2>/dev/null || true
USER node

# The upstream image's ENTRYPOINT is check-permissions.sh; we replace it with
# our own because the seed restore must run BEFORE the server starts.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
