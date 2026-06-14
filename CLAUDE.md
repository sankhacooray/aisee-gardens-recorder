# aisee-gardens-recorder — local notes

## What this is

A **mobile-first field recorder** for the Aisee × Singapore Botanic Gardens routes. A gardens/aisee
staff member walks a route on their phone; the page captures **real GPS**, lets them **Mark POI** or
**Mark checkpoint** along the way, and on **Finish** posts the whole route — the walked track + the
marked points — to the `aisee-gardens-backend-appscript` JSON API (`route.create`). The route then
renders on the backend **dashboard** map and can be simulated there.

It is a **standalone static page** (no build step, no server of its own) — deliberately *not* part of
the Apps Script dashboard, because **Apps Script's HtmlService iframe blocks `navigator.geolocation`**
(a won't-fix Google sandbox limitation). Only a normally-hosted page can read GPS.

## Why static / separate from the dashboard

- Geolocation needs a **secure context** AND an un-sandboxed frame. The Apps Script web app is served
  inside a cross-origin iframe with no `allow="geolocation"`, so GPS is permanently blocked there.
- This page is plain HTML/CSS/JS hosted on a normal origin (localhost for dev, HTTPS for phones), so
  GPS works. It talks to the backend purely over the cross-origin JSON API.

## Files

- `index.html` · `styles.css` · `app.js` — the app (map, GPS watch, marking, save).
- `manifest.webmanifest` · `sw.js` · `icon.svg` — installable PWA (offline shell; SW cache is
  version-stamped by `deploy.py`).
- `deploy.py` — publish to GitHub Pages (HTTPS, for on-device testing). Needs a git `origin` remote.

There is **no server file** — this is a pure static site. The backend (`aisee-gardens-backend-appscript`)
is the only server: it handles auth (the shared `API_TOKEN`) and stores recorded routes in the Sheet.

## Configuration — none to paste

The recorder **signs in through the backend** (login proxy). There's nothing to paste: the backend
`/exec` URL is hardcoded (`BACKEND_URL` in `app.js`), and the **Maps key + project list arrive from the
backend after login** (`?action=bootstrap`). First screen is **"Sign in with Google"**.

### Login flow (AHL login-broker pattern, no Google Identity Services)

1. Tap **Sign in with Google** → the tab navigates to `BACKEND_URL?action=login&return=<thisUrl>&nonce=…`.
2. The backend (Google-gated) reads your identity, checks the central `Staff` list, mints an **HMAC
   session token**, and shows a **Continue** button.
3. Continue returns here with `#email&name&token` in the URL fragment; the recorder caches
   `{email, name, token}` in `localStorage` and strips the hash.
4. It calls `?action=bootstrap&auth=<token>` → `{user, mapsKey, projects}` → loads the map + project
   dropdown. Saving posts `route.create` with `auth: <token>` (no shared API token).

**Backend prerequisite:** the recorder's URL must be on the backend's `AISEE_RETURN_URLS` allow-list.
`http://localhost:4766/` is seeded by `setupPlatform()`. For the deployed (HTTPS) recorder, run
`addReturnUrl('https://<user>.github.io/<path>/')` in the backend editor.

**Project picker.** The header `<select>` is filled from `bootstrap`. Pick the project a walk belongs to
before saving; the chosen `projectId` rides with `route.create`. Projects are created/deleted from the
**dashboard**, not here.

**Maps / Directions key** lives on the backend (`setMapsApiKey`), not here. The optional "Snap path to
footpaths" save option additionally needs the **Directions API** enabled on that key.

**Account** sheet (gear icon): shows who you're signed in as, a **Sign out**, and an advanced backend-URL override.

## Run / test

- **Desktop dev:** serve the folder over `localhost` (a secure context, so geolocation works). Pick any:
  - **Run and Debug ▶ "Serve recorder (4766)"** (`.vscode/launch.json`) — a **node** config that runs
    `npx serve -l 4766` and auto-opens the browser. (It's node, not python, on purpose — debugpy is
    broken under Homebrew Python 3.14's `pyexpat`/`libexpat` mismatch, so a Python launch won't start.)
  - **Terminal → Run Task → "Serve recorder (4766)"** (`.vscode/tasks.json`, `python3 -m http.server`).
  - or just `python3 -m http.server 4766` / `npx serve -l 4766` in a terminal.

  Then open <http://localhost:4766> → Chrome devtools → **Sensors** to fake a location and "walk" it.
  Record → Mark a checkpoint + a POI → Finish → Save.
- **On a phone:** deploy to HTTPS first (`python3 deploy.py` → GitHub Pages) — geolocation is blocked
  on plain-`http://` LAN IPs. Then open the Pages URL on the phone and walk the route for real.

## Flow

Record (starts the GPS track) → walk → **Checkpoint** drops a stay-on-track point · **POI** opens a
sheet (name, category, briefing, radius) → **Finish** → name + status/tracking mode → **Save**. The
POST sends `waypoints` (checkpoints), `pois`, and `track_polyline` (the encoded GPS track) plus
`distance_m` / `est_duration_min` computed from the track.

## Port

`4766` (see workspace [PORTS.md](../PORTS.md)) — used for local static serving
(`python3 -m http.server 4766`, or the `.vscode/launch.json` "Serve" config). Nothing binds it in
production; GitHub Pages serves the deployed site.
