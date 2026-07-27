# Production backend setup

This backend is the first migration step from the browser-local demo to a shared wedding workspace. It currently provides:

- Account registration and login with password hashing and HTTP-only sessions.
- A wedding workspace created for the registering owner.
- Server-enforced roles: owner, editor, contributor, viewer.
- PostgreSQL-backed tasks, expenses, sessions, memberships, and audit events.
- Protected task API endpoints and a health check.
- Task create/update/archive operations recorded in the server-side audit log.
- Owner-managed invitation links, member roles, revocation, and removal safeguards.

The signed-in planner uses the shared API and PostgreSQL for its planning records. Browser-local data remains only as a legacy signed-out/demo fallback and should not be used as a backup for the shared workspace.

## Start locally or on a Raspberry Pi

1. Copy `.env.example` to `.env` and replace `POSTGRES_PASSWORD` with a long random value. Never commit `.env`.
2. Install Docker Engine and the Compose plugin on a 64-bit Raspberry Pi OS system using an SSD for database storage.
3. Start the stack:

   ```sh
   docker compose up -d --build
   ```

4. Make the helper scripts executable once, then use the safe update command for future deployments:

   ```sh
   chmod +x scripts/backup.sh scripts/update.sh
   ./scripts/update.sh
   ```

   It backs up PostgreSQL and uploaded files before rebuilding. See `BACKUP_AND_UPDATE.md` for recovery notes. Never use `docker compose down -v` for a normal update.

5. Verify the API from the Pi:

   ```sh
   curl http://127.0.0.1:8080/api/health
   ```

The web service deliberately binds only to `127.0.0.1:8080`. Publish it through Cloudflare Tunnel rather than opening router ports.

## First account

Send a JSON request to `POST /api/auth/register` with `email`, a password of at least 12 characters, `displayName`, and `weddingName`. The server creates the account, wedding workspace, and owner membership in one transaction.

## Current API

- `GET /api/health`
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/weddings`
- `GET /api/weddings/:weddingId/collaboration` (owner)
- `POST /api/weddings/:weddingId/invitations` (owner; returns a one-time invitation token)
- `DELETE /api/weddings/:weddingId/invitations/:invitationId` (owner)
- `PATCH /api/weddings/:weddingId/members/:memberId` (owner)
- `DELETE /api/weddings/:weddingId/members/:memberId` (owner)
- `GET /api/invitations/:token`
- `POST /api/invitations/accept`
- `GET /api/weddings/:weddingId/tasks`
- `POST /api/weddings/:weddingId/tasks`
- `PATCH /api/weddings/:weddingId/tasks/:taskId`
- `DELETE /api/weddings/:weddingId/tasks/:taskId` (archives the task)

## Schedule date and time-zone rules

- Calendar-day fields are stored as PostgreSQL `DATE` values (`YYYY-MM-DD`): wedding day, RSVP deadline, task/expense due dates, reservation dates, itinerary dates, vendor milestones, packing reminders, and document expiries.
- A date-only field is a planning calendar day, not a UTC timestamp. The browser deliberately renders it as a local calendar date so October 18 remains October 18 in Manila and in the planner's local view.
- Optional start/end times are stored separately and are displayed as local planning times. The app does not convert them between travel time zones yet; include the city/time-zone context in the reservation note when needed.
- The Schedule endpoint only includes items whose saved structured dates overlap the selected range. Text that happens to mention a date never creates a calendar item.
- Clearing an optional date removes that linked schedule item on the next refresh without deleting the original record.

## Safety notes

- The database service has no published host port.
- Cookies are `HttpOnly` and `SameSite=Strict`; production cookies are also `Secure`.
- Authentication endpoints are rate limited.
- Every protected route checks membership role on the server.
- Invitation tokens are random, stored only as SHA-256 hashes, expire, and are revoked after use.
- Adding an email to Cloudflare Access remains a separate required step before an invited person can reach the app.
- Backup the PostgreSQL volume off-device before relying on the backend for real wedding data.
