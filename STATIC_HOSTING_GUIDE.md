# Static Hosting Guide: What Works and What Does Not

## Purpose

This document explains what happens if the current Wedding Planner demo is hosted on a static service such as Netlify Drop or Cloudflare Pages.

## What static hosting works well for

- Publishing the webpage quickly with a shareable URL.
- Showing the visual design and testing the planning workflow on phones, tablets, and computers.
- Running the current client-side features: tasks, Kanban drag-and-drop, budgets, vendors, quotes, reservations, idea boards, comments, guest list, and local backup export.
- Updating the site by uploading the changed project folder again.

## Important limitations of the current demo

### Data is not shared

The current app saves planning records in each browser's local storage.

- Andrea's phone, Nash's laptop, and a planner's tablet would each have separate data.
- A change on one device does not appear on another device.
- The static host stores webpage files, not the wedding records created inside the browser.

### There are no real user accounts

The visible collaboration roles are a design preview only.

- No password or magic-link sign-in exists yet.
- No invitation flow exists yet.
- No server-enforced Owner, Editor, Contributor, or Viewer permissions exist yet.

### Attachments are browser-local

Idea-board photos and PDFs are currently stored inside browser local storage.

- They are not available to other collaborators.
- Browser storage has limited capacity, so large photos/PDFs can fail to save.
- Clearing browser data can remove attachments and planning records unless a JSON backup was downloaded first.

### Do not use a public static host for sensitive documents

Do not use this demo to store private contracts, receipts with sensitive information, travel documents, financial account information, or guest contact details if the site is shared publicly.

## Safe way to publish the demo now

1. Download a local JSON backup from **Settings → Download backup**.
2. Upload the project folder to Netlify Drop or Cloudflare Pages.
3. Treat the published site as a design/demo copy rather than the shared source of truth.
4. Keep private documents outside the public demo.
5. Re-upload the folder after code/design changes.

## Recommended hosting choices

| Need | Recommended option |
| --- | --- |
| Fastest drag-and-drop preview | Netlify Drop |
| Direct folder/ZIP upload with CDN | Cloudflare Pages Direct Upload |
| Hosting from a public code repository | GitHub Pages |
| Private shared planning app with logins | Raspberry Pi or managed app host with a backend/database |

## What is required before shared use

Before Andrea, Nash, or other contributors use one shared wedding workspace, build and deploy:

1. An authenticated backend with secure sign-in and invitations.
2. A central database for wedding records, payments, tasks, comments, and guest list data.
3. Server-enforced collaboration roles and permission checks.
4. Private file storage for receipts, contracts, and idea attachments.
5. HTTPS, backups, and a recovery process.
6. Audit history stored on the server rather than only in each browser.

## Raspberry Pi route

The included Docker/Nginx configuration can serve the current static demo on a home network. It does not solve shared data or accounts by itself.

For a Raspberry Pi production setup, add the backend, database, private file storage, HTTPS, scheduled backups, and a secure remote-access layer such as Tailscale or Cloudflare Tunnel before inviting collaborators.
