# Audit Remediation Plan — Shared Wedding Workspace

## Purpose

This plan turns the July 2026 production audit into a safe sequence of fixes. It prioritizes data isolation, finance correctness, and collaboration clarity before broader cleanup work. Each phase should be committed, deployed through `./scripts/update.sh`, and verified before moving to the next.

## Working rules

- Do not run `docker compose down -v`; it would remove persistent database/upload volumes.
- Before every Pi deployment, let `./scripts/update.sh` create its database and upload backups.
- Test write actions with two accounts when a change affects shared data.
- Keep all application changes on GitHub before pulling them to the Pi.
- If a deployment health check briefly reports a connection reset, wait a few seconds and confirm `curl http://127.0.0.1:8080/api/health` returns `{"ok":true}`.

## Phase 0 — Establish a safe baseline

### Goal

Protect credentials and ensure there is a recoverable copy of the current working release before modifying financial and permission logic.

### Tasks

1. Rotate the PostgreSQL application password because an early `.env` path exists in Git history.
2. Rotate any Cloudflare API token if it was ever placed in a tracked file, shell history, or shared transcript.
3. Update the Pi-only `.env` with the new password and apply the corresponding PostgreSQL role password change.
4. Confirm `.env` is ignored and not tracked by Git.
5. Create a manual backup through `./scripts/backup.sh` and verify that both the SQL dump and upload archive exist.
6. Record the deployed Git commit and the most recent backup timestamp in the project progress notes.

### Verification

- `git ls-files` does not include `.env` or backup output.
- `sudo docker compose ps` shows database, API, and frontend healthy/running.
- `curl http://127.0.0.1:8080/api/health` returns `{"ok":true}`.
- Andrea and Nash can both sign in and see their existing workspace.

### Exit condition

Current production data is backed up, active credentials are fresh, and the stack is healthy.

## Phase 1 — Protect finance record isolation and arithmetic

### Goal

Make it impossible for an expense or payment in one wedding workspace to reference a vendor, category, or expense from another workspace.

### Tasks

1. Add a server helper that verifies a referenced finance record belongs to the requested `weddingId`.
2. Apply that helper when creating or editing expenses:
   - budget category;
   - vendor.
3. Apply it when creating or editing payments:
   - linked expense;
   - vendor;
   - payer and payment-split members should continue using the existing member validation.
4. On payment edit, calculate the effective payment amount from either the new amount or the stored amount.
5. Reject a split update whose total exceeds that effective amount, even when the request does not change the amount field.
6. Decide and document the overpayment policy:
   - recommended: permit overpayments but label/display the resulting credit clearly; or
   - reject payments above the associated expense’s committed amount.
7. Return clear validation messages that identify the invalid linked record rather than a generic request failure.
8. Add API tests for all cross-workspace and payment-split cases.

### Verification

Using two separate test workspaces:

1. Attempt to submit an expense in Workspace A with Workspace B’s vendor/category ID; it must receive a validation/authorization error.
2. Attempt to submit a payment in Workspace A with Workspace B’s expense/vendor ID; it must fail.
3. Create a $100 payment, then edit only its splits to total $101; it must fail.
4. Create/edit valid expense and payment records; finance totals, allocations, and both owner screens must refresh correctly.

### Exit condition

All finance references are workspace-scoped and payment totals cannot be invalidated through partial edits.

## Phase 2 — Make shared exports and Viewer behavior truthful

### Goal

Ensure the interface only offers actions the user can perform and that exported data is the shared server data users see on screen.

### Tasks

1. Replace the legacy local-storage expense CSV handler with a server-backed shared-finance export.
2. Include expense name, category, vendor, committed amount, paid amount, outstanding amount, status, payer, and dates where available.
3. Generate a workspace-aware filename rather than the old fixed Andrea/Nash demo filename.
4. Audit guest and other export buttons for the same local-storage behavior; migrate or hide each one in signed-in workspaces.
5. Define one UI permission map for each role:
   - Owner: all workspace settings, people/access, financial visibility, and write actions;
   - Editor: broad planning write access, without owner-only workspace administration;
   - Contributor: explicitly allowed planning/comment/task actions only;
   - Viewer: read-only approved modules, no create/edit/delete/upload controls.
6. Apply role checks before rendering buttons and forms on Ideas, Honeymoon, Guests, Contacts, Rings, and Attire.
7. Keep backend permission checks as the authoritative safety layer; the UI change prevents misleading controls rather than replacing server checks.
8. Add clear read-only text for viewers where useful.

### Verification

1. Add an expense from one owner account, export it, and confirm the CSV contains the server record.
2. Confirm no export contains stale browser-local sample data.
3. Sign in as a Viewer and visit every module; no write button, upload input, edit action, delete action, or writable form should be available.
4. Attempt a direct API write as a Viewer; it must still fail.
5. Sign in as Owner/Editor/Contributor and confirm each allowed action remains usable.

### Exit condition

The UI accurately represents permissions and every available export reflects shared data.

## Phase 3 — Remove legacy duplicate UI and event-handler risks

### Goal

Eliminate the remaining overlap between browser-local demo behavior and the signed-in server-backed workspace.

### Tasks

1. Consolidate Rings & Attire so signed-in users see one shared panel and one set of records.
2. Audit all signed-in tabs for duplicate legacy panels, static sample cards, and multiple calls-to-action for the same action.
3. Remove or isolate legacy local-storage handlers from shared-mode execution.
4. Replace duplicate global function declarations and duplicate form listeners, starting with task and comment flows.
5. Ensure each modal has one submission path, one close/cancel path, and visible error feedback.
6. Keep an intentional offline/demo mode only if it remains useful; otherwise remove it from production UI and documentation.
7. Replace remaining static sample names/locations/dates that can flash before shared data loads with loading states or neutral placeholders.
8. Add regression tests for task create/edit/delete, task comments, wedding settings, Rings/Attire, and Honeymoon actions.

### Verification

1. Hard-refresh each tab while signed in; no duplicate section or demo destination should appear.
2. Open every modal, save valid data, cancel invalid/incomplete data, and close via the cancel button; each action behaves once.
3. Confirm task edits generate exactly one API request and appear to the other owner after refresh.
4. Confirm all displayed names, dates, and records come from the active workspace.

### Exit condition

Signed-in planning has one authoritative UI and no browser-local demo handler can intercept a shared action.

## Phase 4 — Harden attachment lifecycle

### Goal

Keep uploads safe, understandable, and maintainable as more receipts, quotes, PDFs, and photos are added.

### Tasks

1. Enforce an allow-list of intended attachment MIME types and file extensions on the server.
2. Preserve the existing 50 MB limit and make the limit visible near upload controls.
3. Serve unknown/untrusted file types as downloads rather than inline content; retain safe PDF/image viewing behavior.
4. Delete an uploaded binary if its database transaction fails.
5. Decide whether deleting a record means immediate binary deletion, recoverable archival, or timed retention.
6. Implement a documented orphan-file cleanup/retention job consistent with that decision.
7. Add replace/retry attachment flows where a failed upload can otherwise leave incomplete metadata behind.
8. Add attachment API tests for allowed types, blocked types, oversized files, unauthorized access, and failed metadata persistence.

### Verification

1. Upload a JPEG, PNG, PDF, and supported document type; each opens/downloads correctly for a permitted member.
2. Try an unsupported executable/script type; it must be rejected with a clear message.
3. Try a file over 50 MB; it must be rejected without a browser network error.
4. Delete/archive a test record and confirm file handling follows the documented retention policy.

### Exit condition

Attachments are controlled, recoverable, and do not silently accumulate orphan files.

## Phase 5 — Deployment hygiene, backup resilience, and monitoring

### Goal

Reduce the chance that an update or Pi failure causes data loss or a confusing outage.

### Tasks

1. Add root and backend `.dockerignore` files to exclude `.env`, backups, `.git`, logs, and unrelated local files from Docker build context.
2. Extend deployment smoke checks to confirm:
   - API health through nginx;
   - frontend root page returns successfully;
   - database is healthy;
   - Cloudflare tunnel service is active.
3. Schedule automated PostgreSQL and uploads backups.
4. Copy encrypted backups off the Pi (cloud storage or another trusted device).
5. Define daily, weekly, and monthly retention windows.
6. Write a restore runbook that restores into a test database/volume before production.
7. Perform and document one full restore test, including an attachment download.
8. Add a lightweight health report for disk space, last backup time/result, container state, and tunnel status.

### Verification

1. Build Docker images and inspect logs to confirm ignored files are not in build context.
2. Run the smoke check after a deployment and intentionally verify its failure output against a stopped test service where safe.
3. Restore a recent backup into a test target; compare record counts and open a restored attachment.
4. Confirm an off-device encrypted backup exists and can be listed without exposing its contents.

### Exit condition

Updates have repeatable checks and the workspace has a proven recovery path outside the Pi.

## Phase 6 — Automated quality coverage and user experience pass

### Goal

Prevent the kinds of regressions already encountered: modal save no-ops, stale UI after saves, date conversion errors, and hidden local-data fallbacks.

### Tasks

1. Establish an API test database and test runner; the current test command succeeds but runs zero tests.
2. Cover authentication, invitations, workspace membership, roles, and last-owner protections.
3. Cover all critical CRUD paths: tasks/comments, wedding profile, finance, vendors/quotes, ideas, Honeymoon, guests, contacts, and Rings/Attire.
4. Add browser/integration smoke tests for sign-in, workspace load, task save/edit, finance save/export, file upload, and Viewer read-only behavior.
5. Add consistent loading, empty, success, and error states to every shared module.
6. Run an accessibility and responsive/mobile pass: keyboard dialog operation, focus order, labels, contrast, narrow-screen layouts, and destructive confirmations.
7. Update `NEXT_PHASE_PLAN.md`, setup documentation, and deployment documentation to remove obsolete static-hosting/demo guidance.

### Verification

1. Test command reports real test counts and fails when a known behavior is intentionally broken.
2. A pre-deploy smoke suite passes locally/CI before deployment.
3. Manual test on desktop and phone-size viewport completes the main planning flow without clipped controls or inaccessible dialogs.

### Exit condition

The app has repeatable regression protection and a polished, understandable shared-workspace experience.

## Recommended order

1. Phase 0 — safe baseline and credential rotation.
2. Phase 1 — finance isolation and payment arithmetic.
3. Phase 2 — accurate exports and role-aware UI.
4. Phase 3 — shared/legacy consolidation.
5. Phase 4 — attachment lifecycle hardening.
6. Phase 5 — backups, Docker hygiene, and monitoring.
7. Phase 6 — automated coverage and UX pass.

## Progress log

| Phase | Status | Notes |
| --- | --- | --- |
| Audit | Complete | July 2026 audit completed; no code changes made as part of the audit. |
| Phase 0 | Not started | Credential rotation and baseline backup. |
| Phase 1 | Not started | Finance record ownership and split validation. |
| Phase 2 | In progress | Shared Overview finance cards, payment list, and task counts now use server-backed records; shared exports and Viewer UI remain. |
| Phase 3 | Not started | Legacy/demo consolidation. |
| Phase 4 | Not started | Upload safety and lifecycle. |
| Phase 5 | Not started | Deployment/backup resilience. |
| Phase 6 | Not started | Tests and UX quality. |
