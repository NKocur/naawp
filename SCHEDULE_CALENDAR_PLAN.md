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

The calendar derives these records from their source tables. It must not create a second schedule record for them.

| Source | Date used | Calendar behavior | Editing behavior |
| --- | --- | --- | --- |
| Wedding profile | `wedding_date` | Highlight as the wedding day | Opens Wedding Settings for Owners |
| Tasks | `due_date` | Task item, with task status/priority | Opens the existing task editor |
| Expenses | `due_date` | Payment/balance due item | Opens the expense editor |
| Payments | `paid_on` | Historical payment item | Opens the payment editor |
| Vendor quotes | `expires_on` | Quote-expiry reminder | Opens the quote editor |
| Honeymoon reservations | reservation date/due date when present | Travel booking or payment date | Opens reservation editor |
| Honeymoon itinerary | itinerary date | Travel itinerary item | Opens itinerary editor |
| Attire appointments | `appointment_on` | Appointment item | Opens attire appointment editor |

If a source has no valid date, it does not appear on the calendar. Editing or deleting a source record immediately changes its calendar representation after refresh.

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
2. Add task due dates, expense due dates, payments, quotes, wedding date, itinerary, reservations, and attire appointments in order.
3. Add an explicit `kind`, `linked`, `sourceId`, and source metadata for every item.
4. Add source-open behavior that routes the user to the proper tab/record.
5. Confirm updates to a source record appear on the next schedule refresh without duplicate records.

### Phase 2 verification

1. Create a task due date, expense due date, and itinerary item; all appear on the correct date.
2. Change a due date; the old date clears and the new date updates.
3. Delete a linked record; its schedule item disappears.
4. Payment history shows the paid date without being mislabeled as a future due date.
5. Events from a second test workspace never appear in the active workspace.

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
