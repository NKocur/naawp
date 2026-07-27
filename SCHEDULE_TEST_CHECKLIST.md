# Schedule verification checklist

Run this after a calendar-related deployment with two Owner accounts in the same workspace.

## Manual event and permissions

1. Add a one-day manual event and confirm it appears in Agenda and Month views.
2. Edit the event, then confirm its original day is clear and the new day is populated.
3. Make it a multi-day event and confirm it appears on every included day.
4. Delete it and confirm it disappears after refresh.
5. Confirm a Viewer can see the event but has no Add, Edit, or Delete control.

## Linked dates

1. Set the wedding day and RSVP deadline in Wedding Settings; verify both are visible in Schedule.
2. Add dates for a task, expense, payment, vendor milestone, quote expiry, reservation, itinerary item, attire appointment, packing item, and travel-document expiry.
3. Confirm each appears once on the correct day and its Open action routes to the relevant planning tab.
4. Change and then clear one of those dates; verify the old schedule item moves and then disappears.
5. Confirm an unrelated note containing a date does not create a Schedule entry.

## Range, filters, and resilience

1. Use Earlier, Later, Today, and Month navigation. Check that the selected period changes without duplicating entries.
2. Test each filter and confirm it hides only the intended categories.
3. Refresh while the Pi is reachable. The temporary “Refreshing schedule” status should disappear when data loads.
4. Briefly test with the browser offline after a successful load. Existing items should remain visible with an error notice instead of being erased.

## Deployment smoke check

1. On the Pi run `./scripts/update.sh`.
2. Confirm `curl http://127.0.0.1:8080/api/health` returns `{"ok":true}`.
3. Test the Schedule from both Owner accounts after the migration completes.
