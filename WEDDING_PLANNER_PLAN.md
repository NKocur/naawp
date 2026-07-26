# Wedding Planner Web App — Product Plan

## Product vision

Create a calm, stylish, all-in-one wedding workspace that helps couples turn a large, emotional project into a clear plan. It should make the most important information visible at a glance: what needs attention next, how much has been committed, who has paid, and what is still owed.

## Primary users

- Couples planning their wedding together.
- A trusted planner, family member, or member of the wedding party who can be invited to help.

## Collaboration and separate logins

The app should support individual accounts so activity, responsibilities, and financial contributions remain clear. An owner can invite collaborators by email or shareable invitation link.

| Role | Access |
| --- | --- |
| Owner | Full control: wedding settings, budget privacy, invitations, permissions, and all records. |
| Editor | Create and edit tasks, vendors, quotes, reservations, expenses, payments, receipts, and ideas. |
| Contributor | Add ideas, receipts, notes, and updates to tasks assigned to them; limited access to financial details. |
| Viewer | Read-only access to the sections the owner chooses to share. |

### Collaboration requirements

- Record who created or last changed a task, expense, payment, receipt, or vendor record.
- Assign tasks to a specific collaborator and surface them in a personal “My tasks” view.
- Allow expenses to be split between multiple people and clearly show who paid and who needs reimbursement.
- Let the owner control whether each collaborator can view financial totals and individual payments.
- Keep an activity history for important actions, especially payments, reservations, and deleted/cancelled records.

## Product principles

- **Clarity first:** Every screen answers “what do I need to do next?”
- **One source of truth:** Quotes, reservations, receipts, payments, and vendor details stay connected.
- **Friendly finance tracking:** Show totals and responsibilities without making the app feel like accounting software.
- **Beautifully practical:** Editorial wedding imagery and soft color palettes support a highly usable interface rather than competing with it.

## Recommended site structure

### 1. Dashboard

The home screen should present a concise wedding overview.

- Countdown to the wedding date.
- A “next up” list of priority tasks.
- Budget snapshot: total budget, committed amount, paid amount, remaining amount.
- Upcoming payments and reservation deadlines.
- Recent activity, such as a newly uploaded receipt or accepted quote.
- Quick actions: add task, vendor, expense, quote, or idea.

### 2. Planning checklist

A timeline-based task center organized by planning phase.

- Suggested phases: 12+ months, 9–12 months, 6–9 months, 3–6 months, final 90 days, wedding week, post-wedding.
- Task fields: title, category, due date, owner, priority, status, notes, linked vendor, and estimated cost.
- Views for list, calendar, and “my tasks.”
- Filters for overdue, high priority, category, assigned person, and completed tasks.

### 3. Budget and finances

The financial hub should be the strongest part of the app.

- Category budgets: venue, catering, photography, attire, florals, music, rings, honeymoon, stationery, beauty, transportation, gifts, and contingency.
- A live total bill and budget variance (under or over budget).
- Expense stages: estimated, quoted, booked/committed, partially paid, paid, refunded.
- Payment schedule with deposit and final-payment dates.
- “Who paid for what” ledger, including split payments and reimbursements.
- “Who we owe” list, grouped by vendor or person, with due dates and status.
- Receipt storage attached to individual expenses.
- Exportable expense and payment summary.

### 4. Vendors, quotes, and reservations

A vendor record should keep every decision and commitment together.

- Vendor contact details, website, category, notes, and rating.
- Quote comparison table: quoted total, inclusions, expiration date, and selected option.
- Reservation status: researching, contacted, quoted, shortlisted, booked, declined.
- Contract and document uploads.
- Deposit, balance, payment deadlines, cancellation terms, and confirmation number.
- Direct links from vendor records to financial entries, tasks, receipts, and messages/notes.

### 5. Honeymoon

A lightweight trip-planning area.

- Destination ideas and saved inspiration.
- Travel reservations: flights, hotels, transport, excursions, and travel insurance.
- Itinerary by day.
- Honeymoon budget, payment schedule, and packing checklist.
- Important confirmation numbers and document reminders.

### 6. Rings and attire

Keep high-consideration purchases organized without burying them in general expenses.

- Ring preferences: metal, stone, size, style, engraving, insurance, warranty, and resize dates.
- Compare ring quotes and appointments.
- Attire tracking for both partners and wedding party: measurements, appointments, alterations, costs, and pickup dates.

### 7. Idea boards

Visual boards for collecting and organizing inspiration.

- Boards such as overall style, ceremony, reception, florals, attire, cake, stationery, honeymoon, and rings.
- Save image, link, note, color, source, approximate cost, and tags.
- Drag-and-drop board layout or a clean masonry grid.
- Convert an idea into a task, vendor lead, or budget placeholder.

### 8. Wedding details

- Event date, venue, ceremony and reception schedule.
- Guest count target and key contacts.
- Wedding party and roles.
- Notes for vows, readings, music, and day-of logistics.

## Financial model

Each financial item should support the following fields:

| Field | Purpose |
| --- | --- |
| Category | Budget grouping and reporting |
| Vendor / payee | Who receives payment |
| Description | Plain-language context |
| Estimated cost | Early planning number |
| Committed total | Accepted quote or contract total |
| Amount paid | Sum of recorded payments |
| Amount owed | Calculated: committed total minus amount paid |
| Paid by | Person(s) who contributed |
| Split | Amount or percentage per contributor |
| Due date | Next payment deadline |
| Receipt / contract | Supporting document attachments |
| Status | Planned, due, partial, paid, cancelled |

### Key calculations

- **Total bill:** total committed costs across active expenses.
- **Paid so far:** total completed payments.
- **Still owed:** total committed costs minus completed payments.
- **Remaining budget:** overall budget minus total committed costs.
- **Reimbursements due:** payments made on another person’s behalf, minus repayments received.

## Priority list

### Priority 1 — MVP foundation

Build these first because they create daily value and establish the core data model.

1. Wedding setup: date, overall budget, and collaborators.
2. Dashboard with countdown, priorities, budget snapshot, and upcoming deadlines.
3. Checklist with task ownership, due dates, and priorities.
4. Budget/expense tracker with totals, amounts paid, and amounts owed.
5. Vendor and reservation records with deposits and final-payment dates.
6. Payment ledger showing who paid for what and reimbursement balances.
7. Secure individual accounts, invitations, and the Owner/Editor/Contributor/Viewer permission roles.

### Priority 2 — Decision support

1. Quote storage and side-by-side comparison.
2. Receipt and contract upload/attachment support.
3. Category budgets and budget-versus-actual reporting.
4. Calendar and deadline reminders.
5. Search and filtering across vendors, tasks, and expenses.

### Priority 3 — Delight and expansion

1. Idea boards with saved images and links.
2. Honeymoon planning and itinerary.
3. Dedicated rings and attire tracking.
4. Shareable read-only summaries for family or a planner.
5. Export to CSV/PDF and optional calendar integrations.

## Suggested navigation

`Overview · Checklist · Budget · Vendors · Ideas · Honeymoon · Details`

Keep the global **Add** button prominent, with options to add a task, expense, payment, vendor, quote, reservation, receipt, or idea.

## Visual direction

- **Mood:** modern editorial, warm, refined, and reassuring.
- **Palette:** ivory/soft stone base, charcoal text, muted sage or dusty rose accents, and one optional metallic-gold highlight.
- **Typography:** a distinctive serif for major headings paired with a highly readable sans-serif for application UI.
- **Layout:** generous whitespace, rounded cards, subtle shadows, clear section dividers, and a responsive two-column dashboard that collapses cleanly on mobile.
- **Data display:** use progress bars for budget and planning completion, compact status chips, and calm warnings for overdue payments or tasks.

## Important user flows

1. Add a vendor → record a quote → mark it selected → create a reservation → automatically add the committed cost and payment schedule to Budget.
2. Record a payment → attach receipt → select who paid → update total paid, amount owed, and reimbursement balance.
3. Save an inspiration item → tag it → convert it into a checklist task or a vendor lead.
4. Open Dashboard → see the highest-priority task and the nearest financial deadline without hunting through sections.

## Success criteria for the first release

- A couple can set up their wedding and see a useful dashboard in under five minutes.
- They can answer “What do we owe?” and “Who has paid?” from one screen.
- Every booked vendor has a clear status, payment schedule, and supporting files.
- Users can identify their top next actions without manually sorting a long checklist.
- The interface feels polished enough to return to frequently during a long planning period.

## Demo implementation status

The current interactive browser demo includes:

- Responsive Overview, Checklist, Budget, Vendors, Ideas, Honeymoon, and Details pages.
- Personalized Andrea and Nash workspace with collaboration-role examples.
- Local browser storage for newly added tasks, expenses, and payments.
- Live budget totals, paid totals, outstanding balances, and a "Who we owe" list.
- Payment recording with payer selection and a receipt filename attachment.
- Vendor reservation cards, quote comparison, honeymoon reservations, and ring/attire planning examples.
- All add/edit dialog close controls dismiss safely without requiring incomplete fields to be filled.
- Wedding identity is personalized for Andrea and Nash: October 18, 2026 in Manila.

### Implementation log

| Area | Status | Implemented in demo |
| --- | --- | --- |
| Responsive wedding workspace | Complete | Overview, Checklist, Budget, Vendors, Ideas, Honeymoon, and Details navigation/screens. |
| Personalization and collaboration preview | Complete | Andrea and Nash workspace plus example contributor roles. |
| Wedding settings | Complete for demo | Editable couple names, wedding date, and location with live greeting, calendar card, countdown, top bar, backup/restore, and activity logging. |
| Task management | Complete for demo | Add, edit, and delete tasks directly from checklist cards; comment with edit/delete controls; complete/reopen; drag tasks between Do Next, In Progress, and Done Kanban columns; and reorder cards within a column with browser-local persistence. |
| Expense management | In progress | Add, search/filter, edit, delete with linked-payment warning, CSV export, editable overall budget, live dashboard totals/allocation, and per-person payment contribution summary. Instalment scheduling remains future work. |
| Payment management | In progress | Record, edit, and delete payments; choose payer, store/open browser-local receipt files, update linked balances/history, expand the full payment history, and calculate Andrea/Nash settlement from payments. |
| Outstanding balances | Complete for demo | Live "Who we owe" list calculated from expense balances. |
| Vendor management | Complete for demo | Add, edit, and delete vendors; save planning notes and contract/cancellation terms; open a vendor quote library to upload, preview, replace, open, and delete quote PDFs/photos with quote amount, expiry, and notes. |
| Quote management | Complete for demo | Add, edit, delete, compare, and select one catering quote; browser-local persistence. |
| Reservation management | Complete for demo | Add, edit, and delete honeymoon/travel reservations with type, status, confirmation, details, balance, and due date. |
| Idea boards | Complete for demo | Open boards to browse attachment thumbnails; add, replace, open full-size, link, caption, and delete image/PDF/text attachments; comments support add/edit/delete controls. |
- PDF attachments open through browser Blob URLs for reliable full-file previews.
| Ring checklist | Complete for demo | Add, edit, complete/reopen, and delete ring planning items with notes. |
| Attire appointments | Complete for demo | Add, edit, and delete fittings/pickups with date, location, and time details. |
| Honeymoon destination and itinerary | Complete for demo | Edit destination, dates, description, and planned budget; add, edit, delete, and date-sort itinerary plans with notes. |
| Honeymoon travel readiness | Complete for demo | Editable packing checklist and travel-document list with notes, completion/readiness status, delete controls, local persistence, activity logging, and backup/restore coverage. |
| Activity history | Complete for demo | Dashboard activity panel with local persistence; task, expense, payment, vendor, quote, reservation, and guest add/edit/delete events plus task completions are captured. |
| Guest list and RSVPs | Complete for demo | Add, edit, delete, search, filter, and track party-size RSVP records with live totals. |
| Local backup and restore | Complete for demo | Download all browser-local planning data as JSON and restore it on another browser/device. |
| Dashboard payment schedule | Complete for demo | Upcoming payment cards, outstanding-balance count, and next due date are calculated from vendor balances and due dates rather than fixed sample cards. |
| Dashboard checklist summary | Complete for demo | Navigation badge and overview task summary update from the live checklist; “View all” opens the full Kanban board. |
| Day-of contacts | Complete for demo | Add, edit, and delete key contacts with role and phone/email details; changes are included in backups and activity history. |
| Day-of contact sheet | Complete for demo | The Details screen provides a live, printable-style contact sheet from the maintained day-of contacts. |
| Shared accounts and secure files | In progress | Fastify/PostgreSQL backend foundation now has account registration/login, HTTP-only sessions, wedding workspaces, membership roles, audit events, Docker services, and an Nginx API proxy. The UI has API-backed account registration/login/logout, and the authenticated task API supports list/create/update/archive with audit entries. Existing local tasks will be migrated deliberately rather than overwritten; expenses, invitations, attachments, and secure file storage remain. |

### Remaining demo milestones

1. Task details — complete for demo: priority, assignee, linked-vendor, notes, and stored due dates are editable and shown on dashboard/Kanban cards.
2. Payment schedules and reimbursements — complete for demo: add deposits, instalments, and final balances with amounts/due dates; mark them paid to create/reverse linked payment records and expense balances; reopen/delete them; and record/delete explicit reimbursements between contributors.
3. Global quick add — complete for demo: the top-bar Add button can start task, expense, payment, vendor, idea-board, reservation, or guest records.
3. Honeymoon reservation costs — complete for demo: booked and paid amounts are editable per reservation, and committed trip budget is calculated from reservations plus other trip commitments.
4. Idea conversions — complete for demo: each idea attachment can create a task, expense, or vendor lead, with activity logging.
5. Extend the activity log to every newer action, including itinerary, packing, travel-document, attachment, comment, and reservation changes.
6. Add PDF export for budget, payment, and outstanding-balance reports.
7. Archive/restore — in progress: main planning records can be archived instead of deleted and restored from Settings; financial records retain their linked-payment safeguards and remain the next archive extension.
8. Implement the production backend described in `PRODUCTION_BACKEND_PLAN.md` for shared accounts, secure files, and live multi-user data.

### Data-management rules

- Deleting a paid expense, payment, receipt, or booked vendor must require confirmation and leave an audit-history entry in the production app.
- Deleting a parent record should warn about connected records, such as payments attached to an expense or a quote attached to a vendor.
- The demo may use browser-local storage, but the production app must use soft delete/archive and server-side audit history rather than irreversible deletion by default.
- Every editable financial record should show who last changed it and when.

### Production milestone: shared accounts

The demo is intentionally local to one browser. Before collaborators can use it together, replace browser storage with a database-backed service that provides:

- Password-based or passwordless sign-in and invitation acceptance.
- A wedding workspace shared through server-enforced role permissions.
- Centralized records, file uploads, audit history, and encrypted backups.
- A Raspberry Pi deployment with HTTPS and private remote access.

## Future considerations

- Guest list, RSVP collection, seating chart, meal selections, and gift tracking.
- Automated email reminders for upcoming invoices and tasks.
- Currency support and tax/tip calculations.
- Data backup, private document storage, and privacy controls for shared collaborators.

## Raspberry Pi self-hosting plan

Hosting the app on a Raspberry Pi is a good option for a small private group and keeps the wedding data under the couple’s control. Build the app so it can run locally during development, then deploy the same application to the Pi when the core experience is ready.

### Recommended deployment approach

1. Run the web app, database, and file storage as separate Docker containers on the Raspberry Pi.
2. Store application data in a durable database and keep receipt/contract uploads in a dedicated persistent storage location.
3. Give the Pi a stable local-network address and use HTTPS for all browser access.
4. For access outside the home, use a private secure-access layer such as Tailscale or a secured Cloudflare Tunnel instead of directly exposing the Pi to the public internet.
5. Schedule automatic backups of the database and uploaded documents to a separate drive and, ideally, an encrypted off-site location.
6. Keep the Pi operating system, application dependencies, and passwords up to date.

### Demo deployment status

- A Docker/Nginx static deployment is included for local-network Raspberry Pi previews.
- It serves the current interactive demo at port 8080 and preserves the browser-local behavior.
- It is **not** yet appropriate for shared accounts or public internet access; those require the planned authenticated backend, database, HTTPS, and secure remote-access layer.
- See `STATIC_HOSTING_GUIDE.md` for static-hosting limitations, safe demo-publishing guidance, and the production requirements for shared use.

### Hosting priorities

- **Before sharing with others:** account authentication, permission checks, HTTPS, and database backups.
- **Before storing contracts or receipts:** encrypted backup storage, access controls, and a recovery test.
- **Before remote access:** secure tunnel/private network configuration and strong passwords for every account.

### Practical limitations

- The app will depend on the home internet connection and Pi power availability.
- A small Pi works well for a few collaborators, but uploaded photos and documents will need storage monitoring.
- If always-on reliability or public access becomes important, the same app can later move to a managed host without changing its features.
