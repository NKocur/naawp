# Collaboration and production roadmap

> The active post-audit execution plan is in `NEXT_PHASE_PLAN.md`. This document remains the detailed historical implementation roadmap.

## Purpose

Turn the deployed wedding planner into a shared workspace for Andrea, Nash, and trusted family members without weakening privacy, financial controls, or data recovery.

## Current baseline — completed

- The planner is deployed on the Raspberry Pi with Docker Compose.
- The app is available at `https://planner.nashandandrea.com` through Cloudflare Tunnel; no router ports are open.
- Cloudflare Access sends a one-time code only to Andrea's and Nash's approved email addresses.
- The API has PostgreSQL-backed accounts, sessions, wedding workspaces, memberships, audit events, and task endpoints.
- GitHub is the deployment source. The Pi update routine is `git pull --ff-only origin master` followed by `sudo docker compose up -d --build`.
- `.env`, private keys, certificates, and persistent database data are ignored by Git.

## Important current limitation

Tasks, finances, vendors/quotes, idea boards, honeymoon planning, guests, day-of contacts, rings, and attire now have shared server-backed workflows. Retired browser-local widgets for fully migrated modules are hidden after sign-in so they cannot be mistaken for live data. Owners can preview and append supported tasks, vendors, expenses, guests, contacts, rings, attire, reservations, itinerary items, and packing items from an older browser backup. The same exact backup is fingerprint-protected from a second import; payments, budget categories, idea boards, and browser-only files/receipts remain intentionally excluded for manual review or re-upload.

## Audit follow-up — July 2026

Completed in the audit fix pass:

- Hide browser-local restore/start-fresh controls whenever a shared workspace is signed in.
- Allow Viewers to load shared non-finance modules while hiding edit controls; API membership checks remain authoritative.
- Prevent a second import of the exact same browser backup using an audited SHA-256 fingerprint.
- State the import scope and exclusions explicitly in both the UI and this roadmap.
- Route shared task saves around the retired browser-local entry-form handler so task creation reaches the API.
- Use a direct, guarded shared-task Save button path so the dialog's legacy submit behavior cannot prevent a task request.
- Reset the task form before setting its type; resetting afterward silently reverted the visible task modal to an expense value.

Still planned before broader use:

- Per-module permissions instead of role-only access.
- Removing or fully isolating the remaining legacy local handlers, dialogs, and sample-data code.
- Import conflict review beyond exact-backup fingerprinting, plus imports for the deliberately excluded record types.
- Automated integration tests for migrations, roles, imports, and shared CRUD.
- Off-device backups, restore testing, disk/backup-age monitoring, and a recovery runbook.

## Collaboration model

Cloudflare Access is the outer gate: it controls who can reach the website. The application role is the inner gate: it controls what an approved person can do in a particular wedding workspace.

| Role | Intended access |
| --- | --- |
| Owner | Full control of the workspace, finances, invitations, roles, settings, exports, archive recovery, and deletion approvals. Andrea and Nash should both be owners. |
| Editor | Create and edit planning records across allowed modules, including tasks, vendors, ideas, reservations, and finances. Cannot change owners or workspace security. |
| Contributor | Add comments, ideas, attachments, and task updates; work on assigned tasks; no financial totals unless explicitly granted. |
| Viewer | Read-only access to selected modules; no financial information by default. |

## Global implementation rules

- Every server record carries `wedding_id`, `created_by`, `updated_by`, timestamps, and an archive state where deletion should be recoverable.
- Every API route loads the signed-in membership and checks role permissions on the server. The browser is never the permission authority.
- Cloudflare email access and app invitations are separate. An invited app user must also be allowed by Cloudflare before they can load the app.
- Never put a database password, Cloudflare token, uploaded private file, or production backup in Git.
- Do not expose the PostgreSQL port, MinIO port, or Pi SSH port through router forwarding.
- Add audit entries for invitations, role changes, financial changes, uploads, archives, restores, and permanent deletion.

## Implementation order

### Phase 1 — Membership, invitations, and role enforcement

**Goal:** owners can invite people into the existing wedding workspace and assign safe, enforceable roles.

**Current implementation status:** In progress. The API now has invitations, owner-only membership management, token-hash storage, expiry/revocation, owner invitations, audit events, and a first owner-only People & access dialog. Email delivery is intentionally not automated yet: an owner copies the generated private invitation link and separately adds that email to Cloudflare Access.

#### Backend

1. Add an `invitations` table with wedding, email, role, token hash, expiry, inviter, accepted time, revoked time, and optional module permissions.
2. Add API endpoints to list members, create/revoke/re-send invitations, accept an invitation, update a member role, and remove a member.
3. Prevent removing the last owner and prevent a non-owner from changing roles.
4. Add a capability map, for example `tasks.write`, `ideas.write`, `finances.read`, `finances.write`, and `files.upload`.
5. Ensure registration cannot silently create a second workspace for someone accepting an invitation.
6. Add rate limits and audit events for all membership actions.

#### Frontend

1. Add a **People & access** page visible only to owners.
2. Show members, role, invitation state, last activity, and allowed modules.
3. Provide an invite form with email, role, optional expiry, and a clear Cloudflare reminder.
4. Add an invitation acceptance screen that lets a new person set an app password or sign in to an existing account.
5. Hide forbidden actions in the UI, but rely on the API for actual enforcement.

#### Acceptance checks

- An owner invites a test account as Contributor.
- The test account cannot see finances or change roles.
- An Editor can edit an allowed task.
- Removing access blocks subsequent API requests immediately.
- The audit log identifies the person who invited, changed, or removed a member.

### Phase 2 — Shared tasks and comments

**Goal:** make the checklist the first fully shared module.

**Current implementation status:** In progress. Server-backed task records, ordered Kanban columns, archive actions, member-backed assignments, server-backed comments, role-aware checklist controls, an owner-only task-backup import, private task attachments, and a shared activity feed are implemented. Task files are stored in a Docker-managed Pi volume with metadata/checksums in PostgreSQL and membership-checked upload, open, and archive routes. Concurrent-edit feedback remains.

1. Complete task API support for ordering within a Kanban column, category changes, assignments, due dates, priority, comments, archive/restore, and attachments.
2. Add `task_comments` and `task_attachments` tables with author, edit history, archive state, and timestamps.
3. Replace local-storage task reads/writes with API calls while retaining a local export option.
4. Add optimistic UI updates, clear error states, and refresh/sync behavior for simultaneous editors.
5. Add activity feed entries for task creation, moves, assignments, comments, and completion.

#### Acceptance checks

- Andrea changes a task on one device and Nash sees it after refresh or sync.
- Two users can reorder separate tasks without losing data.
- Comments show their author and support owner-authorized edit/archive actions.
- Contributor permissions are enforced for both the UI and direct API calls.

### Phase 3 — Shared budget, payments, and vendors

**Goal:** establish one trusted financial source of truth.

**Current implementation status:** In progress. The database foundation for shared budget categories, vendors, expense stages, payments, and repayment splits is in place. Server-side shared finance totals, budget-category read/create/edit/archive, shared expense list/create/edit/archive, payment list/create/edit/archive, vendor list/create/edit/archive, vendor-quote list/create/edit/archive, and protected vendor-quote attachment endpoints are available to Owners and Editors. The Budget page now displays those shared totals, lets Owners and Editors manage planned budget categories and shared expense/payment records, selects both a payer and a reimbursement debtor from actual workspace members, and lets an Owner or Editor mark an outstanding reimbursement as settled. It also displays the total still owed back. The Vendors page now has shared vendor and quote records with add/edit/archive forms and shared PDF/photo attachment upload, viewing, and deletion. The server verifies that any selected payer or reimbursement recipient belongs to the workspace.

**Idea boards status:** Shared board records, attachments, and attachment comments now support workspace-aware create/edit/open/archive operations. Attachment files are stored in the Pi's persistent Docker upload volume with membership-checked access. Comments are attributed to the signed-in account; an author or Owner can edit/delete them. Legacy browser-local boards remain visibly separate until an optional import tool is added.

**Honeymoon status:** Shared trip profile, reservations, itinerary, packing, and travel documents now support shared create/edit/archive operations. Travel documents can carry an optional protected PDF/photo attachment and a ready/to-do state. The legacy browser-local Honeymoon widgets remain visibly separate until an optional import tool is added.

**Guests status:** In progress. Shared guest/household records now support group, party size, RSVP state, notes, server-computed RSVP totals, and create/edit/archive operations. Legacy browser-local guest widgets remain visibly separate until an optional import tool is added.

**Day-of contacts status:** In progress. Shared contacts now support name, role, phone/email, and create/edit/archive operations. The shared wedding-day schedule remains to be migrated from the browser-local view.

**UI consolidation status:** In progress. Retired local widgets are hidden after sign-in for migrated modules. The original Vendor and Idea Board card grids, Honeymoon hero and planning lists, Guest summary/table, Day-of Contacts card, Finance summary/table/lists, and Rings/Attire cards now render shared records and route their actions to shared workflows. Retired local payment-schedule/reimbursement widgets are hidden after sign-in.

#### Data model

1. Add budget categories and planned allocations.
2. Add expenses with amount, currency, stage (`estimated`, `quoted`, `committed`, `partially_paid`, `paid`, `refunded`, `cancelled`), linked vendor, and due date.
3. Add payments with payer, payee/vendor, amount, date, method, reimbursement status, and linked receipt.
4. Add split responsibilities to represent who paid and who owes whom.
5. Add vendors, quotes, reservations, contracts, confirmation numbers, and payment schedules.

#### Frontend

1. Replace finance, payment, vendor, quote, and reservation local storage with API data.
2. Compute total budget, committed amount, paid amount, amount owed, and reimbursements on the server or from a documented shared query.
3. Make editing paid/committed/estimated states explicit and fully reversible through audit-backed history.
4. Restrict financial visibility and editing by role/module permission.

#### Acceptance checks

- Totals agree with individual expense and payment records.
- A payment update changes the balance exactly once.
- A contributor without finance permission receives a `403` from finance APIs.
- Owners can export a complete financial report.

### Phase 4 — Private attachments and idea boards

**Goal:** store receipts, PDFs, vendor quotes, and inspiration media outside browser local storage.

1. Add a storage service on the Pi SSD: MinIO/S3-compatible storage or an application-managed upload volume.
2. Store metadata in PostgreSQL: original filename, sanitized storage key, MIME type, byte size, SHA-256 checksum, uploader, module link, and archive state.
3. Upload through authenticated API endpoints; never expose filesystem paths or a public bucket.
4. Serve downloads/previews only after membership and module-permission checks.
5. Generate safe image thumbnails and PDF preview metadata; retain original files.
6. Support replace, archive, restore, comment, and delete actions with audit entries.
7. Migrate idea boards, vendor quotes, receipts, and honeymoon documents to the shared attachment system.

#### Acceptance checks

- A permitted user can upload and view an attachment from a second device.
- An uninvited user and a viewer without permission cannot download a direct file URL.
- Deleting a file archives it; an owner can restore it.
- Database and file backups restore a usable attachment.

### Phase 5 — Remaining shared modules and migration

**Goal:** migrate all high-value planning records, then remove local storage as the source of truth.

1. Migrate ideas/boards/comments/themes.
2. Migrate guests, contacts, RSVP notes, schedules, and wedding-day information.
3. Migrate honeymoon destination, itinerary, reservations, packing, documents, and payments.
4. Migrate rings, attire, appointments, measurements, and reminders.
5. Build a one-time owner-only import that reads the existing local JSON export, previews record counts/conflicts, and imports transactionally.
6. Keep JSON export as a recovery/export feature, not the live database.
7. Add per-module migration flags so the UI never mixes local and server records silently.

#### Acceptance checks

- Import can be run on a copy of an export and reports successes/failures.
- An imported record has a stable server ID and correct owner/workspace.
- Two browsers show the same shared data after migration.
- A rollback path exists until each module is accepted.

### Phase 6 — Backups, monitoring, and recovery

**Goal:** protect real wedding planning data from SD-card failure, deletion, or a failed upgrade.

1. Move PostgreSQL and attachment storage to a Pi-attached SSD before treating the system as the only copy.
2. Add a scheduled encrypted PostgreSQL dump and attachment backup to an off-device destination.
3. Retain daily, weekly, and monthly backups for a documented period.
4. Add a restore runbook: restore into a separate test database, verify counts and file checksums, then document approval before production restore.
5. Add health checks for API, database, disk capacity, backup age, and tunnel status.
6. Document app updates, rollback, secret rotation, Raspberry Pi updates, and Cloudflare-token rotation.

#### Acceptance checks

- A scheduled backup completes without manual steps.
- A test restore recreates a sample workspace and attachment set.
- An alert or visible status identifies a failed backup or low disk space.

## Release gates

| Gate | Required before proceeding |
| --- | --- |
| Invite family | Phase 1 acceptance checks pass; invited accounts and Cloudflare allow-list are tested. |
| Put tasks in daily use | Phase 2 passes; browser-local task data has been exported and migrated. |
| Put money records in daily use | Phase 3 passes; an off-device backup and restore test exist. |
| Upload irreplaceable contracts/receipts | Phase 4 passes; private download authorization and backup restore are verified. |
| Treat the Pi as primary source of truth | Phase 5 and Phase 6 pass; SSD and recovery documentation are in place. |

## Routine operating checklist

### Before a code deployment

1. Commit and push the change from the Windows project folder.
2. Confirm `.env` and tokens are not in `git status` or GitHub.
3. On the Pi, run `git pull --ff-only origin master`.
4. Run `sudo docker compose up -d --build`.
5. Check `curl http://127.0.0.1:8080/api/health` and the protected public URL.

### Before inviting someone

1. Create their app invitation and select the least-privileged role.
2. Add their exact email to the Cloudflare Access allow-list.
3. Test their ability to sign in and confirm they cannot access restricted modules.
4. Remove their Cloudflare and app access when their help is no longer needed.

## Immediate next sprint

1. Deploy and test owner invitations with Andrea and Nash as Owners.
2. Test shared tasks and comments from two accounts, including Kanban reordering and permission boundaries.
3. Add task attachments and a shared activity view.
4. Add a one-time owner import for older browser-local task data.
5. Start the shared budget, payments, and vendor data model. Until then, Budget, Vendors, Ideas, Honeymoon, and Details explicitly identify themselves as browser-local, single-device modules.
