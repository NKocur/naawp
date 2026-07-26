# Production backend setup

This backend is the first migration step from the browser-local demo to a shared wedding workspace. It currently provides:

- Account registration and login with password hashing and HTTP-only sessions.
- A wedding workspace created for the registering owner.
- Server-enforced roles: owner, editor, contributor, viewer.
- PostgreSQL-backed tasks, expenses, sessions, memberships, and audit events.
- Protected task API endpoints and a health check.
- Task create/update/archive operations recorded in the server-side audit log.

The front-end still uses local storage. Do not treat the app as multi-user until the UI is migrated to the API.

## Start locally or on a Raspberry Pi

1. Copy `.env.example` to `.env` and replace `POSTGRES_PASSWORD` with a long random value. Never commit `.env`.
2. Install Docker Engine and the Compose plugin on a 64-bit Raspberry Pi OS system using an SSD for database storage.
3. Start the stack:

   ```sh
   docker compose up -d --build
   ```

4. Verify the API from the Pi:

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
- `GET /api/weddings/:weddingId/tasks`
- `POST /api/weddings/:weddingId/tasks`
- `PATCH /api/weddings/:weddingId/tasks/:taskId`
- `DELETE /api/weddings/:weddingId/tasks/:taskId` (archives the task)

## Safety notes

- The database service has no published host port.
- Cookies are `HttpOnly` and `SameSite=Strict`; production cookies are also `Secure`.
- Authentication endpoints are rate limited.
- Every protected route checks membership role on the server.
- Backup the PostgreSQL volume off-device before relying on the backend for real wedding data.
