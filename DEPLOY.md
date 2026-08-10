# Quest Learning University (QLC) — QNAP Deployment Guide

This guide is for your IT team to install QLC on the QNAP NAS using native Node.js
(no Docker), with a MySQL/MariaDB database, accessible via your company domain.

**Not able to set up the NAS server right now?** See **`CLOUD-DEPLOY.md`**
(included in this same package) for a genuinely free alternative using Render +
Aiven — same app, no server hardware needed. It has real trade-offs (explained
in that guide), but gets everyone on one shared database today.

**Do this first:** if Node.js, the database, the domain, and SSL aren't already
set up on the NAS, follow **`SERVER-SETUP.md`** (included in this same package)
before continuing here — it's the step-by-step guide for all of that. This guide
picks up assuming those prerequisites are already in place.

## What's in this package

- `qlc-server/` — the backend API (Node.js + Express) and, once built, the web app
  it serves to employees' browsers
- `schema.sql` — the full database structure
- `.env.example` — configuration template (copy to `.env` and fill in real values)

## Prerequisites checklist

(Full step-by-step instructions are in `SERVER-SETUP.md` — this is just a recap.)

- [ ] Node.js v18+ installed via App Center
- [ ] MariaDB/MySQL installed, with a `qlc` database and a dedicated `qlc_app` user
- [ ] Domain pointed at the NAS with a Reverse Proxy rule forwarding to port `4000`
- [ ] HTTPS/SSL certificate active for the domain

## Installation steps

1. Copy the `qlc-server` folder AND the `qlc-frontend` folder onto the NAS, e.g. to
   `/share/QLC/qlc-server` and `/share/QLC/qlc-frontend`.
2. Build the frontend first — this compiles the web app into static files that
   `qlc-server` will serve directly:
   ```
   cd /share/QLC/qlc-frontend
   npm install
   npm run build
   ```
   This creates `/share/QLC/qlc-server/public` automatically — no manual copying needed.
3. SSH into the NAS (or use the Node.js App Center's terminal) and set up the backend:
   ```
   cd /share/QLC/qlc-server
   npm install
   ```
4. Copy `.env.example` to `.env` and fill in the real database credentials, a
   random `JWT_SECRET`, and the public domain:
   ```
   cp .env.example .env
   nano .env
   ```
5. Create the upload folder referenced in `.env` (for Training Bank files, photos):
   ```
   mkdir -p /share/QLC/uploads
   ```
6. Initialize the database (creates all tables and a first Admin login):
   ```
   npm run initdb
   ```
7. Start the server:
   ```
   npm start
   ```
   You should see `QLC server running on port 4000`.

## Keeping it running (so it survives reboots)

If Node.js was installed via App Center (Method A in `SERVER-SETUP.md`), it
usually includes a way to register a persistent "Node.js Application" pointing
at `server.js` with the working directory set to `/share/QLC/qlc-server` —
configure that through the Node.js App Center control panel.

If Node.js was installed manually (Method B), use **pm2** instead — a small tool
that keeps Node apps running in the background and restarts them automatically:

1. Install pm2 globally (one time):
   ```
   npm install -g pm2
   ```
2. Start QLC through pm2 instead of `npm start`:
   ```
   cd /share/QLC/qlc-server
   pm2 start server.js --name qlc
   ```
3. Make pm2 itself start automatically on NAS reboot:
   ```
   pm2 startup
   ```
   This prints a command tailored to your system — copy and run that exact
   command it gives you, then run:
   ```
   pm2 save
   ```
4. Useful commands going forward:
   ```
   pm2 status          # check it's running
   pm2 logs qlc         # view live logs (Ctrl+C to exit, doesn't stop the app)
   pm2 restart qlc       # restart after an update
   ```

## First login

Once running, open `https://training.yourcompany.com` (your real domain).

- Username: `admin`
- Password: `admin123`

**Change this password immediately** after first sign-in — it's a well-known
default and this system is now reachable by your whole company network.

## Status of this deployment package

**Backend (API + database):** all modules are converted — Login, Employee Master,
Skills, Skill Matrix, Gap Analysis, Training Calendar, Attendance, Evaluation,
Effectiveness, Questionnaires (with scored tests), Training Needs, Training Bank,
and Access Control.

**Frontend (the web app people actually see and click through):** Login, first-time
password setup, and Employee Master are fully connected to the live server. Every
other module currently shows a "being connected to the live server" placeholder
instead of the real screen — the local laptop version already has all of them
working, and each one is being wired up to this server next, the same incremental
way the rest of this project was built. Updates will arrive as replacements to the
`qlc-frontend` folder — rebuild it (`npm run build`) and restart `qlc-server` after
each update; nothing else needs to change.
