#!/bin/sh
# Creates a consistent PostgreSQL dump plus a copy of uploaded files.
# Run from the repository root on the Raspberry Pi.
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR=${EVER_AFTER_BACKUP_DIR:-"$ROOT_DIR/backups"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

cd "$ROOT_DIR"
mkdir -p "$BACKUP_DIR"

docker compose ps --status running --services | grep -qx db || {
  echo "Database container is not running; no backup was made." >&2
  exit 1
}

DB_FILE="$BACKUP_DIR/ever-after-$STAMP.sql.gz"
UPLOADS_FILE="$BACKUP_DIR/ever-after-$STAMP-uploads.tar.gz"
MANIFEST_FILE="$BACKUP_DIR/ever-after-$STAMP.sha256"

docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip -9 > "$DB_FILE"
docker compose exec -T api sh -c 'mkdir -p /app/uploads && tar -C /app/uploads -czf - .' > "$UPLOADS_FILE"

sha256sum "$DB_FILE" "$UPLOADS_FILE" > "$MANIFEST_FILE"
echo "Backup complete: $DB_FILE"
echo "Uploads complete: $UPLOADS_FILE"
