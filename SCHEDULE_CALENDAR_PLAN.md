# Shared Schedule & Calendar Plan

## Purpose

Add one shared schedule that helps Andrea, Nash, and invited collaborators see every meaningful wedding date in one place. The schedule must not duplicate existing data: a task due date, expense due date, payment date, reservation, or honeymoon itinerary item remains owned and edited by its original feature. The calendar simply reflects it.

Manual calendar events are for plans that do not naturally belong to another record, such as a venue walkthrough, family planning call, tasting, dress fitting, airport pickup, RSVP reminder, or meeting.

## Goals

- Show a month calendar and an upcoming agenda from one shared workspace.
- Combine linked planning dates with manually created shared events.
- Make each linked item open its source record for editing.
- Keep manual events editable, deletable, and shared through the production backend.
- Preserve correct role permissions and avoid browser-local calendar data in signed-in workspaces.
- Make date-only records safe across time zones.

## Non-goals for the first release

- Email, SMS, or push reminders.
- Recurring events.
- External calendar synchronization (Google, Apple, Outlook, ICS subscriptions).
- Automatic travel-time calculations.
- Assigning a different time zone to every individual event.

## Date model

### Linked schedule items

The calendar derives these records from their source tables. It must not create a second schedule record for them. This inventory covers every current shared planner component and explicitly separates sources that are ready now from sources that need a proper date field first.

| Planner component | Current shared date field(s) | First calendar treatment | Required follow-up / why it is not automatic yet |
| --- | --- | --- | --- |
| Wedding settings | `weddings.wedding_date` | Include now; highlight as the wedding day. | Opens Wedding Settings for Owners. |
| Checklist tasks | `tasks.due_date` | Include now as task deadlines, including task status, priority, and assignee metadata. | No item without a due date should be invented on the calendar. |
| Shared expenses | `expenses.due_date` | Include now as expense/balance due dates. | Show committed/remaining amount, not a duplicate payment event. |
| Shared payments | `payments.paid_on` | Include now as historical money activity. | Clearly label it **Paid**, never as a future deadline. |
| Expense quote attachments | Attachment upload timestamp only | Do not create a schedule event from an attachment. | The attachment inherits its expense context; a due date belongs on the expense. |
| Budget categories and allocations | No date | Do not include automatically. | Categories are grouping/budget records, not dated plans. |
| Shared vendor records | No shared structured date | Do not include automatically in the first release. | Add `contract_due_on`, `deposit_due_on`, `final_payment_due_on`, and optionally `event_service_on` before linking vendor commitments. Do not parse cancellation terms or notes. |
| Shared vendor quotes | `vendor_quotes.expires_on` | Include now as quote-expiry reminders. | Opens the quote editor; quote files themselves are not separate events. |
| Legacy catering quote comparison | No shared date and may be browser-era data | Exclude from the shared schedule. | Retire/migrate it into the shared vendor quote model before considering it a source. |
| Honeymoon profile | `dates_label` is free text | Do not derive events from it. | Add structured `starts_on` and `ends_on` to represent the trip range; do not parse text such as “October 2026.” |
| Honeymoon reservations | `travel_reservations.due_date` | Include now as reservation payment deadlines. | Add structured `starts_on`/`ends_on` (and optional departure/arrival times) for flights, stays, transport, and activities. `details` is free text and must not be parsed. |
| Honeymoon itinerary | `honeymoon_itinerary_items.planned_on` | Include now as travel itinerary items. | Keep this as a date-only item until optional time fields are deliberately added. |
| Honeymoon packing | No date | Do not include automatically. | Users can create a manual packing reminder or give individual packing items a future due-date feature. |
| Honeymoon travel documents | No date | Do not include automatically. | Users can add a manual passport/visa/insurance reminder; later add a document expiry/renewal date if useful. |
| Guest list and RSVPs | No date | Do not include individual guests automatically. | Add a workspace-level RSVP deadline, or optional per-guest response/follow-up date, rather than treating guest creation/update timestamps as events. |
| Day-of contacts | No date | Do not include automatically. | Contacts are reference information; manual events cover calls, handoffs, and meetings. |
| Ring checklist | No date | Do not include automatically. | Add an optional due date only if ring tasks should become scheduled deadlines; otherwise use a normal checklist task/manual event. |
| Attire appointments | `attire_appointments.appointment_on` | Include now as appointments. | Opens the attire appointment editor; location remains display metadata. |
| Idea boards, attachments, and comments | Created/updated timestamps only | Do not include automatically. | Inspiration activity is not a plan date. Add a manual event or a dated task for a decision deadline. |
| Collaboration members/invitations | Created/expiry timestamps only | Exclude from the wedding schedule. | These are access-management records, not planning events. |
| Activity feed/audit history | Recorded timestamps only | Exclude from the schedule. | It is retrospective history, not a future plan. |
| Browser-only legacy schedules/payment schedules/reservations | May have local dates, but are not authoritative shared records | Exclude from the signed-in schedule. | Migrate them to shared API records first; never mix one browser's local data into the workspace calendar. |

If a source has no valid structured date, it does not appear on the calendar. Editing or deleting a linked source record immediately changes its calendar representation after refresh. The schedule must never infer dates from labels, notes, terms, descriptions, confirmation text, or file names.

### Source coverage rules

1. A single source record may produce one or more normalized schedule items only when it has an explicit shared date field. For example, a future vendor record can expose separate deposit and final-payment dates; those are separate events with the same source record.
2. A source-owned item is edited in its original feature. The schedule uses **Open task**, **Open expense**, **Open reservation**, and similar actions rather than duplicated editors.
3. Manual events cover all date-based plans that have no natural source record yet: venue walk-throughs, tastings, RSVP reminders, calls, family meetings, vendor deadlines, airport transfers, and day-of logistics.
4. Created-at, updated-at, upload-at, and activity timestamps are audit metadata. They are never planning dates.

### Manual events

Manual events are stored in a new server table. Recommended fields:

```text
id
wedding_id
title
event_type             -- meeting, appointment, reminder, travel, ceremony, other
starts_on              -- required calendar date
ends_on                -- optional date for multi-day events
starts_at              -- optional local time
ends_at                -- optional local time
location               -- optional
notes                  -- optional
created_by
updated_by
archived_at
created_at
updated_at
```

Use `DATE` for date-only events and local `TIME` fields for optional times. Do not convert a date-only item through JavaScript `Date`/UTC serialization; render it as a local calendar date.

## Permissions

| Role | View schedule | Add/edit/delete manual events | Edit linked source item |
| --- | --- | --- | --- |
| Owner | Yes | Yes | Yes, including workspace settings and finance |
| Editor | Yes | Yes | Yes where already allowed |
| Contributor | Yes | Yes for manual events | Existing contributor permissions only |
| Viewer | Yes | No | No |

The backend remains authoritative. The interface must hide disabled add/edit/delete controls for Viewers rather than relying on UI-only protection.

## API plan

### Manual events

```text
GET    /api/weddings/:weddingId/events?from=YYYY-MM-DD&to=YYYY-MM-DD
POST   /api/weddings/:weddingId/events
PATCH  /api/weddings/:weddingId/events/:eventId
DELETE /api/weddings/:weddingId/events/:eventId
```

Use input validation for title length, event type, ISO dates, valid optional times, `endsOn >= startsOn`, and workspace membership.

### Combined schedule feed

```text
GET /api/weddings/:weddingId/schedule?from=YYYY-MM-DD&to=YYYY-MM-DD
```

The response combines manual events and linked records into a normalized shape:

```json
{
  "items": [
    {
      "id": "task:<uuid>",
      "kind": "task",
      "sourceId": "<uuid>",
      "title": "Confirm menu",
      "startsOn": "2026-08-10",
      "endsOn": null,
      "startsAt": null,
      "endsAt": null,
      "status": "todo",
      "editable": true,
      "linked": true
    },
    {
      "id": "<uuid>",
      "kind": "manual",
      "title": "Cake tasting",
      "startsOn": "2026-08-14",
      "location": "Manila",
      "editable": true,
      "linked": false
    }
  ]
}
```

The response must include only records belonging to the requested wedding workspace and only dates within or overlapping the requested range.

## Interface plan

### Navigation

1. Add a **Schedule** entry to the primary sidebar.
2. Keep any existing browser-only schedule widgets out of the signed-in shared path.
3. Make the new Schedule tab the one source of truth for production users.

### Header

- Title: **Schedule**
- Month controls: previous month, today, next month.
- View switch: **Month** and **Agenda**.
- Filter control: All, Tasks, Money, Vendors, Travel, Appointments, Manual events.
- **Add event** button for permitted roles only.

### Month view

- Monday–Sunday grid, responsive for desktop and mobile.
- Wedding date receives a distinct visual treatment.
- Show up to three event chips per day plus a “+ N more” control.
- Use consistent category colors:
  - Tasks: green
  - Money: terracotta
  - Vendors/quotes: gold
  - Travel: blue
  - Appointments: lavender
  - Manual events: neutral charcoal
- Clicking a chip opens a compact details panel. Linked records show **Open task**, **Open expense**, etc.; manual records show **Edit** and **Delete** when permitted.

### Agenda view

- Group items by date, starting with today.
- Show time when available, source/type, title, status, location, and relevant amount/balance for money entries.
- Include an empty state with **Add event** when no schedule items exist in the selected range.

### Manual event dialog

- Title (required)
- Type
- Date and optional end date
- Optional start/end times
- Optional location
- Notes
- Save, Cancel, and Delete when editing
- Clear validation errors near fields; no required-field lock-in when closing the dialog

## Implementation phases

## Implementation progress

### Completed — shared manual-event foundation (July 2026)

- Added the shared `schedule_events` database table with workspace isolation, date-range indexing, soft deletion, and audit history.
- Added server-backed event create, read, edit, and delete endpoints with Owner, Editor, and Contributor write access; Viewers remain read-only.
- Added the Schedule navigation tab and an upcoming Agenda view with event-type filtering and range navigation.
- Added the manual event dialog with optional end date, local times, location, and notes. Closing or cancelling the dialog does not create a record.
- Added frontend safeguards for date-only rendering and a full-width event save action.

### Next — calendar grid and structured-date follow-ups

Build the Month view, then add the future structured date fields described in Phase 2A without relying on free-text notes or labels.

### Completed — initial linked schedule feed (July 2026)

- Added the normalized shared `/schedule` feed with workspace isolation and range filtering.
- Added the initial ready sources: wedding day, task due dates, expense due dates, payment history, vendor quote expirations, honeymoon reservation due dates, itinerary items, and attire appointments.
- Linked items are read-only inside Schedule and provide an **Open** action back to their owning planner section.
- Added category filters for manual events, tasks, money, vendors, travel, appointments, and ceremony items.

### Completed — month calendar view (July 2026)

- Added Agenda and Month view switching within Schedule.
- Added month navigation, Today, source-colored calendar chips, and source-open behavior from the calendar.
- Added multi-day manual-event expansion so an event is visible on every date it covers in Agenda and Month views.
- Kept date-only values as calendar-day strings so they do not shift due to UTC conversion.

### Completed — structured honeymoon dates (July 2026)

- Added start/end dates to the shared honeymoon profile, allowing the trip itself to appear as a multi-day travel item.
- Added start/end dates and optional local start/end times to shared travel reservations.
- Kept reservation payment due dates separate from travel dates, so Schedule can show a travel range and a money deadline when both exist.
- Updated the Honeymoon forms and reservation history to display and edit the structured fields.

### Completed — structured vendor milestones (July 2026)

- Added contract due, deposit due, final-payment due, and service-day dates to shared vendor records.
- Added those dates to the vendor form and edit flow rather than deriving anything from contract notes.
- Added each saved milestone as a separate linked Schedule item, categorized as vendor work or money where appropriate.

### Completed — workspace RSVP deadline (July 2026)

- Added an optional RSVP deadline to shared Wedding Settings.
- Saved it on the workspace itself, so it is shared by all members and survives deployments.
- Added it to the linked Schedule feed as a clearly labeled RSVP deadline item.

### Completed — optional packing deadlines (July 2026)

- Added an optional “Need by” date to shared packing items.
- Kept packing checklist-only when no date is supplied, while dated items appear as linked Schedule reminders.

### Completed — optional travel-document expiry dates (July 2026)

- Added an optional expiry date for shared travel documents such as passports, visas, and insurance.
- Expiry dates are visible on the document card and appear as linked Schedule reminders only when provided.

### Phase 1 — Shared manual event foundation

1. Add an `events` migration with indexes for `wedding_id`, active state, and date range lookups.
2. Add CRUD endpoints with role checks and audit events.
3. Add an `events` client loader and a dedicated Schedule tab.
4. Implement Agenda view first because it is easiest to validate.
5. Implement the manual event dialog, create/edit/delete controls, and Viewer read-only behavior.

### Phase 1 verification

1. Owner creates an event; the second Owner sees it after refresh.
2. Editor can create and edit an event.
3. Viewer sees the event but no write controls; direct API writes fail.
4. Multi-day event appears on every included date in Agenda/Month logic.
5. A canceled dialog does not create an event.

### Phase 2 — Linked schedule feed

1. Create the normalized combined `/schedule` endpoint.
2. Add the already-ready sources in this order: wedding date, task due dates, expense due dates, payments, vendor quote expirations, reservation due dates, honeymoon itinerary items, and attire appointments.
3. Add an explicit `kind`, `linked`, `sourceId`, and source metadata for every item.
4. Add source-open behavior that routes the user to the proper tab/record.
5. Confirm updates to a source record appear on the next schedule refresh without duplicate records.
6. Keep budget categories, files, guests, contacts, ring checklist items, packing, documents, ideas, collaboration records, activity, and all browser-only records out of this feed unless a future migration adds an explicit planning date.

### Phase 2A — Structured-date upgrades

These upgrades are deliberately separate from the initial linked feed. They prevent the calendar from relying on ambiguous free-text fields.

1. Add honeymoon `starts_on` and `ends_on`, then render the trip as a multi-day linked travel item.
2. Add reservation `starts_on` and `ends_on`, plus optional local departure/arrival times where applicable; retain `due_date` as a separate payment deadline.
3. Add structured vendor dates for contract, deposit, final payment, and optional service day. Show each populated date as a distinct vendor-linked item.
4. Add a workspace RSVP deadline, with an optional later per-guest follow-up date if that becomes useful.
5. Decide whether ring checklist and packing items need an optional due date or should remain checklist-only; do not add dates merely to populate the calendar.
6. Add optional document expiry/renewal dates only if they are intended to become reminders.
7. Migrate or retire browser-only schedule/payment/reservation data before it can appear in any shared schedule response.

### Phase 2 verification

1. Create a task due date, expense due date, and itinerary item; all appear on the correct date.
2. Change a due date; the old date clears and the new date updates.
3. Delete a linked record; its schedule item disappears.
4. Payment history shows the paid date without being mislabeled as a future due date.
5. Events from a second test workspace never appear in the active workspace.
6. Free-text fields such as honeymoon dates, reservation details, and vendor terms never generate a schedule item.
7. A vendor with a note mentioning a date has no calendar item until the corresponding structured date field is saved.

### Phase 3 — Month calendar and filters

1. Build the month-grid renderer using date strings, not UTC-converted timestamps.
2. Add month navigation, Today, event chips, overflow controls, and filters.
3. Add mobile stacking and accessible keyboard/focus behavior.
4. Add an event details popover/panel.
5. Ensure the selected calendar range controls the server request range.

### Phase 3 verification

1. October 2026 shows the wedding on October 18 in Manila’s local planning date.
2. Calendar navigation does not request or render unrelated months unnecessarily.
3. Filters hide/show only their intended categories.
4. Mobile layout is readable without clipped event titles or action buttons.
5. A calendar item opens the correct source record.

### Phase 4 — Quality and reliability

1. Add API tests for permissions, date validation, range filtering, overlap handling, and workspace isolation.
2. Add frontend tests or a repeatable browser checklist for event CRUD, linked-date updates, and month navigation.
3. Add loading, empty, and failure states without deleting the current visible schedule.
4. Record audit events for manual event changes.
5. Document the date/time-zone rules in the production setup and user-facing help.

### Completed — Schedule refresh resilience (July 2026)

- Added an in-place refresh state to the Schedule tab.
- A failed refresh preserves the most recently loaded Schedule items and explains what happened instead of replacing the agenda with an empty state.

## Deployment checklist

1. Commit and push all application and migration changes.
2. On the Pi, run:

   ```bash
   cd ~/WeddingPlannerApp
   ./scripts/update.sh
   ```

3. Confirm `curl http://127.0.0.1:8080/api/health` returns `{"ok":true}`.
4. Test one manual event and one linked task due date with both Owner accounts.
5. Confirm the database and uploads backups were created by the update script.

## Future enhancements

- Optional calendar reminders and notification preferences.
- ICS export/subscription and external calendar integrations.
- Recurring planning events.
- Event attendees and assignees.
- Vendor availability and payment-installment scheduling.
- Weather/travel context closer to the wedding and honeymoon dates.
