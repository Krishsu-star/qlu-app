# Quest Learning University (QLC) — Free Cloud Deployment (Render + Aiven)

Your IT team isn't able to set up the QNAP server yet. This is a genuinely free
alternative that gets QLC online and shared across everyone's browsers — no
credit card needed anywhere — while you wait for real server hosting to become
available.

**This uses the exact same `qlc-server` and `qlc-frontend` code already built for
QNAP.** Nothing about the app itself changes — only *where* it runs.

## Honest limitations of this free setup

Read this before committing time to it — these are real trade-offs of "free":

1. **The app "sleeps."** Render's free tier spins the server down after ~15
   minutes with no visitors. The next person to open it waits 30–60 seconds for
   it to wake up. After that, it's normal speed until it goes quiet again.
2. **Uploaded files don't survive a restart.** Render's free tier has no
   permanent disk — so anything uploaded *through the app itself* (an SOP
   document via "Upload File," a Training Bank file, a Photo Gallery image) will
   be **lost** the next time the server restarts or redeploys. Until this is
   solved with proper storage, **use the "Link" option instead of "Upload File"**
   for SOPs and Training Bank — link to a file already saved in Google
   Drive/SharePoint/OneDrive. Photo Gallery uploads should be treated as
   temporary/demo-only on this setup.
3. **The database has a 1GB cap.** Plenty for employee records, sessions,
   assessments, and questionnaires — this limit is about data *rows*, not files,
   since files aren't stored here anyway (see #2).
4. **Not a substitute for real IT-approved hosting for sensitive HR data
   long-term.** This is a genuinely reasonable way to get the whole company
   using one shared, real database *today* — but revisit this with IT once
   they're able to help, especially for file storage and guaranteed uptime.

If these trade-offs aren't acceptable right now, the laptop version remains the
right choice until IT is ready — nothing here requires switching away from it.

---

## Part 1 — Create the free database (Aiven)

1. Go to https://aiven.io and sign up (no credit card required).
2. Create a new service → choose **MySQL**.
3. Pick the **Free** plan, choose any region, name it `qlc`, and create the
   service. It takes a couple of minutes to spin up.
4. Once it's running, open the service page and find the **Connection
   Information** panel. Note down:
   - **Host**
   - **Port**
   - **User** (usually `avnadmin`)
   - **Password**
   - **Default database name** (usually `defaultdb`)
5. In the **Databases** tab of the service, create a new database named `qlc`
   (cleaner than using the default one, though either works).

## Part 2 — Initialize the database schema

You'll run this once, from your own computer, to create all the tables.

1. Download and unzip `qlc-server.zip` (same as always).
2. Copy `.env.example` to `.env` and fill in the Aiven values from Part 1:
   ```
   DB_HOST=<your Aiven host>
   DB_PORT=<your Aiven port>
   DB_NAME=qlc
   DB_USER=avnadmin
   DB_PASSWORD=<your Aiven password>
   DB_SSL=true
   JWT_SECRET=<generate one — see the comment above it in .env.example>
   ```
3. In a terminal, inside the `qlc-server` folder:
   ```
   npm install
   npm run initdb
   ```
   This creates every table and a first Admin login, directly on your new
   Aiven database.

## Part 3 — Build the frontend

1. Unzip `qlc-frontend.zip` alongside `qlc-server` (same folder level).
2. In a terminal, inside `qlc-frontend`:
   ```
   npm install
   npm run build
   ```
   This builds straight into `qlc-server/public` — same as the QNAP process.

## Part 4 — Deploy to Render

1. Go to https://render.com and sign up (no credit card required for the free
   tier).
2. Put the `qlc-server` folder (which now includes the built `public` folder
   from Part 3) into its own GitHub repository — Render deploys from GitHub.
   - If you don't already use GitHub: create a free account at
     https://github.com, create a new repository, and upload the `qlc-server`
     folder's contents to it (GitHub's web uploader works fine for this, no
     command-line git required).
3. Back in Render, click **New → Web Service**, connect your GitHub account,
   and select that repository.
4. Configure it:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Under **Environment Variables**, add every value from your `.env` file
   (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_SSL`,
   `JWT_SECRET`) — one at a time, matching the names exactly. Do **not** upload
   the `.env` file itself; Render's environment variables panel replaces it.
   Leave `PORT` unset — Render sets this automatically.
6. Click **Create Web Service**. Render will build and start it — first deploy
   takes a few minutes. Watch the logs for `QLC server running on port ...`.
7. Render gives you a free URL like `https://qlc-yourname.onrender.com` — that's
   the address everyone uses to sign in.

## First login

Open the Render URL, sign in with `admin` / `admin123`, and immediately change
that password (Access Control → edit the admin account).

## Updating later

Whenever there's a new version of the app:
1. Rebuild the frontend (Part 3) into `qlc-server/public`.
2. Push the updated `qlc-server` folder to the same GitHub repository.
3. Render redeploys automatically within a minute or two of the push.
