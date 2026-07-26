# Safe updates and recovery

The Docker database and uploaded files use named volumes, so `docker compose up -d --build` preserves them. Do **not** use `docker compose down -v` for normal updates: `-v` deletes the named volumes.

## Normal Raspberry Pi update

From `~/WeddingPlannerApp`:

```sh
chmod +x scripts/backup.sh scripts/update.sh
./scripts/update.sh
```

This creates three files in `backups/` before downloading code or rebuilding:

- a compressed PostgreSQL dump;
- a compressed archive of `/app/uploads` (task, quote, idea, and travel files);
- SHA-256 checksums for both files.

Copy completed backup sets off the Pi periodically (for example, to a computer or encrypted external drive). A backup on the same Pi does not protect against hardware loss.

## Restore outline

Stop the stack, preserve the current volumes, then restore only after confirming which backup set you intend to use. Database restore overwrites current database contents, so take a fresh backup first.

```sh
cd ~/WeddingPlannerApp
./scripts/backup.sh
sudo docker compose down
sudo docker compose up -d db
# Wait until the database is healthy, then restore the selected SQL dump:
gunzip -c backups/ever-after-YYYYMMDDTHHMMSSZ.sql.gz | sudo docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
sudo docker compose up -d
```

Uploaded-file recovery is separate: copy the matching uploads archive back into the API container's `/app/uploads` volume before starting the API. Ask for help before restoring files if the existing uploads must be retained.

## Migration safety

The API records every completed SQL migration and its SHA-256 checksum in `schema_migrations`. On an update, previously completed migrations are skipped. If an old migration file was edited, startup stops rather than running an unknown schema change; add a new numbered migration instead.
