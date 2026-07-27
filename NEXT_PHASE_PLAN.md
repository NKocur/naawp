# Next Phase Plan — Shared Wedding Workspace

## Current position

Andrea and Nash have a deployed, Cloudflare-protected shared workspace on the Raspberry Pi. Core planning modules are server-backed: tasks, finances, vendors and quotes, ideas, honeymoon planning, guests, contacts, rings, and attire.

The priority is no longer adding broad new screens. It is making the existing workspace safe to rely on, easy to use with collaborators, and recoverable if the Pi or an update fails.

## Priority 0 — Verify the current release

Before adding more features, deploy the latest release and run a short two-account check.

1. Deploy the latest GitHub `master` commit to the Pi.
2. Verify `/api/health` returns `{"ok":true}`.
3. Sign in as both Andrea and Nash.
4. Confirm a change to a task, vendor, guest, ring item, and honeymoon reservation appears after refresh in the other account.
5. Confirm the Rings/Attire local-only notice and browser-local Settings restore/start-fresh controls are gone after sign-in.
6. Create a temporary Viewer account and confirm it can read shared non-finance modules but cannot reveal or submit edit controls.

**Exit condition:** the deployed UI matches the current shared-data model and both Owners can use it without errors.

## Priority 1 — Backups and recovery

Do this before adding real contracts, receipts, or important financial records.

1. Move Docker PostgreSQL and upload data to a Pi-attached SSD, if one is available.
2. Add a scheduled backup job that includes:
   - PostgreSQL dump;
   - uploaded-file volume archive;
   - encrypted copy to an off-device destination.
3. Keep daily, weekly, and monthly retention periods.
4. Add a restore runbook that restores into a test database first and verifies record counts and attachments.
5. Add a simple health report for API, database, disk space, tunnel service, most recent backup time, and last backup result.

**Exit condition:** one successful restore test has been completed and documented.

## Priority 2 — Collaboration permissions

Make family collaboration safe and understandable.

1. Test invitations end-to-end: Cloudflare allow-list, invitation link, account creation, role changes, revocation.
2. Add per-module permissions, beginning with finance visibility and edit rights.
3. Define the final role policy:
   - Owners: Andrea and Nash;
   - Editors: trusted planners with broad write access;
   - Contributors: tasks, ideas, comments, and assigned work;
   - Viewers: read-only non-finance access unless explicitly granted.
4. Add a visible permission summary in People & access.
5. Add audit-log visibility for membership, role, invitation, and finance changes.

**Exit condition:** a test Contributor and Viewer both receive only their intended access through the UI and direct API requests.

## Priority 3 — Finish data migration and remove legacy ambiguity

1. Test the owner backup importer with a copied backup, then verify imported counts in the shared UI.
2. Add richer duplicate/conflict review beyond exact-backup fingerprinting.
3. Extend import support for deliberately excluded records:
   - budget categories and payment history;
   - honeymoon profile and travel documents;
   - idea boards and text metadata;
   - vendor quote metadata.
4. Keep browser-only files, receipts, PDFs, and images as explicit manual re-upload steps unless a safe server-side attachment import is implemented.
5. Remove or isolate remaining legacy local-storage handlers, sample defaults, and old dialogs after their replacements are accepted.
6. Rewrite outdated demo/static-hosting documentation so it cannot be mistaken for production guidance.

**Exit condition:** no signed-in workflow can accidentally create browser-local planning data, and import behavior is explicit and tested.

## Priority 4 — Financial and attachment polish

1. [Done] Payment receipts and expense quotes use the protected server attachment system. Each can be added while creating or editing its record, or later from the matching expense/payment history; permitted finance members can open or delete it.
2. Add shared payment schedules for deposits, installments, and final balances.
3. Add owner financial exports (CSV and printable summary).
4. Add file replace, archive, restore, and metadata preview support.
5. Add image thumbnails and useful PDF preview metadata where practical.
6. Clarify currency behavior and support Philippine peso if that is the desired planning currency.

**Exit condition:** all financial records and supporting documents are shared, exportable, and recoverable.

**Progress:** The shared expense tracker presents expenses and payments as separate responsive card panels, with quotes, receipts, balances, and record actions kept with the relevant item. Add/edit expense and payment forms open as focused dialogs from those panels.

**Progress:** Vendor cards now group vendor details, quotes, files, and quote actions together; the standalone quote area is now only used to add or edit an offer.

## Priority 5 — Reliability, quality, and usability

1. Add automated API/integration tests for authentication, role checks, migrations, imports, and critical CRUD flows.
2. Add user-facing sync/conflict feedback when someone else changes the same record.
3. Add reliable empty/loading/error states for each shared module.
4. Add a small deployment smoke-test checklist or script.
5. Review accessibility, mobile layout, keyboard operation, and destructive-action confirmations.

**Exit condition:** updates can be deployed with repeatable checks and common collaboration errors are understandable.

## Recommended execution order

1. Priority 0 verification.
2. Priority 1 backups and restore test.
3. Priority 2 permissions and invitation testing.
4. Priority 3 legacy cleanup/import improvements.
5. Priority 4 financial and attachment polish.
6. Priority 5 test automation and quality pass.

## Deployment routine

```bash
cd ~/WeddingPlannerApp
git pull --ff-only origin master
sudo docker compose up -d --build
curl http://127.0.0.1:8080/api/health
```

After a frontend update, hard-refresh the browser once (`Ctrl+F5`) if it appears to be serving an older page.
