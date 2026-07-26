#!/bin/sh
set -eu

# Docker creates a new named volume as root. The app itself intentionally runs
# as the non-root `node` user, so make only the persistent upload directory
# writable before dropping privileges.
uploads_directory="${UPLOADS_DIRECTORY:-/app/uploads}"
mkdir -p "$uploads_directory"
chown -R node:node "$uploads_directory"

exec su-exec node "$@"
