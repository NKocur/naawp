# Ever After Wedding Planner

A responsive front-end prototype for a collaborative wedding-planning dashboard. It includes task priorities, expense/owed totals, vendor reservations, idea boards, a honeymoon view, and a collaboration overview.

## Run locally

Open `index.html` in a modern browser. The prototype stores newly added expenses and tasks in that browser's local storage.

## Raspberry Pi deployment (static prototype)

This project now includes a Docker/Nginx setup for a Raspberry Pi running a 64-bit operating system. Copy the project to the Pi, then run:

```sh
docker compose up -d --build
```

The app will be available on the Pi’s local network at `http://<pi-address>:8080`.

This static deployment is suitable for previewing the demo. The current local-storage data is browser-specific; secure shared accounts, invitations, receipts, and a central database require the planned server-side implementation. Do not expose this static demo directly to the public internet.

## Next implementation milestone

Add an authenticated backend with a database before sharing the app with collaborators. The core records should be users, weddings, memberships/roles, tasks, vendors, reservations, expenses, payments, and attachments. Use server-enforced authorization for Owner, Editor, Contributor, and Viewer permissions; do not rely on the front-end alone for access control.
