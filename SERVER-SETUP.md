# QLC — Server Prerequisites Setup Guide (QNAP)

This guide is for whoever has **admin access to the QNAP NAS** (usually your IT
team). It covers everything that needs to be installed and configured on the NAS
itself, **before** installing the QLC software. Do these steps once.

If your QTS (QNAP's operating system) version has slightly different menu names
than described here, the same settings exist under a similarly-named section —
QNAP's own help documentation for your exact model/version can confirm the exact
path if needed.

---

## Step 1 — Install Node.js

Many QNAP models don't list Node.js in the official App Center at all — this
depends on your exact model and QTS version, and there's no way to know in
advance without trying. If it's not there, don't worry — there's a reliable
method that works on any x86 QNAP regardless of what App Center offers.

### Method A — App Center (try this first)

1. Open **App Center**, and make sure App Center itself is up to date: go to
   **App Center → Settings (gear icon) → Check for Updates**.
2. Search for **Node.js**. If nothing appears, it's genuinely not available for
   your model through the official store — skip to Method B below. Don't spend
   time troubleshooting this further; it's a known gap on many QNAP models.

### Method B — Manual install via SSH (works on any x86 QNAP)

This downloads Node.js directly from nodejs.org — the same official binaries
used everywhere else — and doesn't depend on QNAP's App Center at all.

1. Enable SSH first if you haven't (see Step 2 below), then connect:
   ```
   ssh admin@<NAS-IP-address>
   ```
2. Download the official Node.js LTS build for Linux x64 (check
   https://nodejs.org/en/download for the current LTS version number — the
   command below uses 20.x as an example):
   ```
   cd /share/CACHEDEV1_DATA
   wget https://nodejs.org/dist/v20.17.0/node-v20.17.0-linux-x64.tar.xz
   tar -xf node-v20.17.0-linux-x64.tar.xz
   mv node-v20.17.0-linux-x64 /share/CACHEDEV1_DATA/nodejs
   ```
   (If `/share/CACHEDEV1_DATA` doesn't exist on your NAS, use `/share/homes` or
   check available volumes with `df -h` first — the exact share name varies by
   how the NAS storage was set up.)
3. Add Node.js to the system PATH so the `node` and `npm` commands work from
   anywhere. Add this line to `/root/.profile` (create the file if it doesn't
   exist):
   ```
   echo 'export PATH=/share/CACHEDEV1_DATA/nodejs/bin:$PATH' >> /root/.profile
   source /root/.profile
   ```
4. Confirm it works:
   ```
   node -v
   npm -v
   ```
   You should see version numbers (e.g. `v20.17.0`).

**Important:** because this bypasses App Center, Node.js won't show up in the
QNAP app list or get automatic updates through App Center. That's fine — it
still runs exactly the same way. Just note it down somewhere for future
reference (e.g. "Node.js is manually installed at
`/share/CACHEDEV1_DATA/nodejs`") so a future admin isn't confused about where
it came from.

## Step 2 — Enable SSH / terminal access

Most of the remaining steps need a command line.

1. Go to **Control Panel → Network & File Services → Telnet / SSH**.
2. Enable **Allow SSH connection**, and note the port (default `22`).
3. From a Mac/Linux computer, or Windows using PowerShell or PuTTY, connect:
   ```
   ssh admin@<NAS-IP-address>
   ```
   Use the NAS admin username and password when prompted.

## Step 3 — Install the database (MariaDB)

1. In **App Center**, search for **MariaDB 10** (or **MySQL**, if that's what's
   available on your QTS version) and install it.
2. Open the MariaDB app once installed — it will prompt you to set a **root
   password** the first time. Write this down somewhere safe (e.g. your
   organization's password manager) — this is different from the app's own
   database password created in the next step.
3. Some QNAP MariaDB packages include **phpMyAdmin** as an optional companion app
   — installing it makes the next step easier (a web interface instead of typing
   SQL by hand). If it's available, install it too.

## Step 4 — Create a dedicated database and user for QLC

Never use the database root account for the app itself — create a separate,
limited-permission account.

**Option A — using phpMyAdmin (easier):**
1. Open phpMyAdmin in a browser, log in with the root password from Step 3.
2. Click **Databases** → create a new database named `qlc` (use the collation
   `utf8mb4_general_ci` if it's asked).
3. Click **User accounts** → **Add user account**.
   - Username: `qlc_app`
   - Host: `localhost`
   - Password: generate a strong password and save it — this goes in the app's
     `.env` file later.
   - Under **Database for user account**, tick "Grant all privileges on database
     qlc" (only on that one database, not globally).
4. Click **Go** to save.

**Option B — using the command line:**
```
mysql -u root -p
```
Enter the root password, then at the `MariaDB>` prompt:
```sql
CREATE DATABASE qlc CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'qlc_app'@'localhost' IDENTIFIED BY 'choose_a_strong_password_here';
GRANT ALL PRIVILEGES ON qlc.* TO 'qlc_app'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

You should now have: database name `qlc`, username `qlc_app`, and a password —
these three values go into the QLC app's `.env` file (see the main `DEPLOY.md`).

## Step 5 — Point your domain at the NAS

1. Confirm with whoever manages your company's DNS that the subdomain (e.g.
   `training.yourcompany.com`) has a DNS record pointing at the NAS's public IP
   address (or is routed there through your existing network setup).
2. On the NAS, go to **Control Panel → Network & Virtual Switch → Reverse Proxy**.
3. Add a new rule:
   - Source domain: `training.yourcompany.com`
   - Source port: `443` (HTTPS)
   - Destination IP: `localhost` (or `127.0.0.1`)
   - Destination port: `4000` (the port QLC runs on — matches `PORT` in `.env`)
4. Save the rule.

## Step 6 — Set up HTTPS (SSL certificate)

Employees' browsers should never see a plain `http://` warning page.

1. Go to **Control Panel → Security → Certificate & Private Key**.
2. Choose **Let's Encrypt Certificate Manager** (or your organization's own
   certificate if you have one already).
3. Enter the domain (`training.yourcompany.com`) and follow the prompts — QNAP
   handles the verification and renewal automatically for Let's Encrypt.
4. Once issued, make sure the Reverse Proxy rule from Step 5 is using this
   certificate for HTTPS.

## Step 7 — You're ready for the app itself

At this point the NAS has everything QLC needs:
- Node.js installed
- A database (`qlc`) and dedicated database user (`qlc_app`) ready
- The domain pointed at the NAS with HTTPS working

Now follow the separate **`DEPLOY.md`** guide (included in the `qlc-server.zip`
package) to install the QLC application itself using these values.

## Quick checklist to hand off

When you're done, you should be able to answer all of these:
- [ ] `node -v` shows v18 or newer
- [ ] Database name: `qlc` — confirmed it exists
- [ ] Database user: `qlc_app` — confirmed it can log in and has access to `qlc`
- [ ] `https://training.yourcompany.com` (your real domain) loads *something* in
      a browser, even if it's just an error page for now — confirms the domain
      and SSL are wired up correctly before the app is even installed
