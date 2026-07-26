#!/bin/sh
# Safe Pi update: backup first, then fetch only a fast-forward update and rebuild.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT_DIR"

"$ROOT_DIR/scripts/backup.sh"
git pull --ff-only origin master
if docker info >/dev/null 2>&1; then
  docker compose up -d --build
else
  sudo docker compose up -d --build
fi
curl --fail --silent --show-error http://127.0.0.1:8080/api/health
echo
echo "Update complete. A database and uploads backup was made before deployment."
