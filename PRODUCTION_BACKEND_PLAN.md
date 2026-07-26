# Production backend plan

The current app is a static, browser-local demo. It cannot provide separate logins, shared live data, reliable backups, or secure file storage by itself.

## Recommended Raspberry Pi deployment

- Front end: this static site served by Nginx.
- API: a small Node.js service (Express/Fastify) behind Nginx.
- Database: PostgreSQL, stored on a Pi-attached SSD rather than an SD card.
- Files: MinIO/S3-compatible object storage on the same SSD, with authenticated download endpoints.
- Authentication: email/password accounts with bcrypt/Argon2 password hashes, secure HTTP-only session cookies, password reset email, and role checks (owner, editor, contributor, viewer).
- Operations: Docker Compose, daily encrypted database/file backups to an off-device location, HTTPS via Caddy or Nginx plus a trusted certificate, and regular operating-system updates.

## Data and safety rules

- Every record belongs to a wedding workspace and is checked against the signed-in user’s role.
- Files are private by default; never expose object-storage paths directly.
- Replacing or deleting a receipt, quote, contract, or attachment creates an audit entry.
- Deletion becomes archive/restore in the app; a background retention policy handles permanent removal only when appropriate.
- Store timestamps and the user who last changed every financial record.

## Migration path

1. Add an API and database schema while keeping the existing screen design.
2. Move local-storage records into the API one collection at a time, starting with accounts, weddings, tasks, and expenses.
3. Move files to authenticated object storage and replace browser data URLs with file IDs.
4. Enable invitations and real contributor roles.
5. Import the current JSON backup once into the new workspace, then keep the browser demo backup only as an export feature.
