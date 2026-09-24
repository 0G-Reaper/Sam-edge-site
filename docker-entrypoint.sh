#!/bin/sh
# The platform mounts the data volume as root. Hand it to the app user, then drop privileges.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown -R sam:sam /data || true
  exec setpriv --reuid=sam --regid=sam --clear-groups "$@"
fi
exec "$@"
