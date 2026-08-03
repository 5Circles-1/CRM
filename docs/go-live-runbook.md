# Go-live runbook

Follow this top to bottom. Every phase ends with a **✓ check** — do not move on
until it passes. Commands are for Ubuntu 24.04 LTS; run them over SSH as a user
with `sudo`. Where you see `crm.yourcompany.in`, substitute your real domain
throughout.

Every step in Phases 2–6 has been executed against a fresh, empty database as
part of this repository's verification — the sequence is proven, not
theoretical.

---

## Phase 0 — Decisions and purchases (one sitting, before touching a server)

1. **Rent a VM.** Ubuntu 24.04 LTS, 2 vCPU / 4 GB RAM / 40 GB disk. Any Indian
   region of DigitalOcean, AWS Lightsail, Hetzner, or E2E Networks works —
   ₹800–1,600/month. Note its public IP.
2. **Point a domain at it.** Create an `A` record: `crm.yourcompany.in → <IP>`.
   TLS (Phase 4) needs this to exist first; DNS can take an hour to propagate,
   so do it now.
3. **Decide your first numbers.** You'll enter these in Phase 6:
   - Monthly breakeven (you've said **₹7,00,000**)
   - Daily dial target per caller (start with a two-week measured baseline;
     until then leave the placeholder 80)
   - Per-counsellor monthly collection target (breakeven ÷ number of closers,
     grossed up — e.g. 2 closers → ₹8,23,529 ÷ 2 ≈ **₹4,12,000** each)
4. **Choose the pilot team.** Two callers + one counsellor. Everyone else stays
   on the current process for two weeks.
5. **Android or iPhone?** (open-questions.md, question 2). Doesn't block
   go-live — but decide before commissioning the call-log app.

**✓ check:** you can `ssh <user>@crm.yourcompany.in` and log in.

---

## Phase 1 — Server preparation (~30 minutes)

```bash
sudo apt update && sudo apt -y upgrade

# Firewall: SSH + web only. Postgres is NOT exposed to the internet.
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

# PostgreSQL 16 (Ubuntu 24.04 default)
sudo apt -y install postgresql postgresql-contrib

# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt -y install nodejs git

# A dedicated system user that owns the app - never run it as root
sudo adduser --system --group --home /opt/crm crm
```

**✓ check:** `psql --version` says 16.x, `node --version` says v22.x,
`sudo ufw status` shows 80, 443, OpenSSH allowed.

---

## Phase 2 — Database (~15 minutes)

```bash
# Get the code
sudo -u crm git clone https://github.com/5Circles-1/CRM.git /opt/crm
cd /opt/crm

# Create the database and the two roles
sudo -u postgres psql <<'SQL'
create database crm;
SQL

# Apply all migrations (creates schema, engines, RLS, and the crm_app group).
# This runner records what it applied - rerunning it later is always safe.
# NEVER run db/rebuild.sh on this machine: it DROPS the database.
sudo -u postgres CRM_DB=crm ./db/migrate.sh

# The application's login role. It inherits crm_app: cannot bypass RLS,
# cannot delete, owns nothing. Generate the password with: openssl rand -base64 24
sudo -u postgres psql -d crm <<'SQL'
create role crm_api login password 'PASTE-A-GENERATED-PASSWORD' in role crm_app;
grant usage on schema crm to crm_api;
SQL
```

**✓ check:** `sudo -u postgres CRM_DB=crm ./db/migrate.sh` again prints
`up to date (0 applied this run)`.

---

## Phase 3 — Application (~20 minutes)

```bash
cd /opt/crm/api
sudo -u crm npm ci --omit=dev

# Environment file - copy the template and fill it in
sudo -u crm cp .env.example .env
sudo -u crm nano .env
```

Set in `.env`:

```
DATABASE_URL=postgresql://crm_api:PASTE-A-GENERATED-PASSWORD@localhost:5432/crm
PORT=8080
HOST=127.0.0.1        # only Caddy talks to it; not exposed directly
LOG_LEVEL=info
# SERVICE_USER_ID=    <- comes from the next step
```

**Bootstrap** — creates your teams, your admin login, and the service account.
This is the one command that runs as the database owner, once:

```bash
sudo -u crm DATABASE_URL="postgresql://postgres@/crm?host=/var/run/postgresql" \
  npm run bootstrap -- \
  --admin-email you@yourcompany.in \
  --admin-name "Your Name" \
  --admin-password 'a-long-temporary-password' \
  --teams "Team A,Team B"
```

It prints `SERVICE_USER_ID=<uuid>` — paste that line into `.env`. The admin
password you just typed is temporary; the UI forces you to change it at first
login.

```bash
# Install as a service so it survives reboots
sudo cp /opt/crm/deploy/crm.service /etc/systemd/system/crm.service
sudo systemctl daemon-reload
sudo systemctl enable --now crm
```

**✓ check:** `curl -s localhost:8080/health` returns `{"ok":true}`, and
`sudo journalctl -u crm -n 20` shows no errors. If the log says *"refusing to
start: database role ... bypasses row-level security"*, your `DATABASE_URL`
points at the wrong role — that guard is protecting you; fix the URL, don't
work around it.

---

## Phase 4 — HTTPS (~10 minutes)

```bash
sudo apt -y install caddy
sudo cp /opt/crm/deploy/Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile   # replace crm.yourcompany.in with your domain
sudo systemctl reload caddy
```

Caddy fetches and renews the TLS certificate automatically.

**✓ check:** `https://crm.yourcompany.in/ui/` from your phone (off the office
network) shows the login screen with a padlock. Log in as the admin, set your
real password when prompted.

### Phase 4b (optional) — restrict who can even reach the login page

The standard setup above is the same model as your bank or any SaaS CRM: the
login page is publicly reachable, the data is not - authentication and
row-level security are the locks. If you want the login page itself
unreachable from outside the office, two options, in order of preference:

- **Office IP allowlist.** Requires a static public IP from your office ISP.
  Uncomment the two `@outside` lines in `/etc/caddy/Caddyfile`, put your
  office IP in, `sudo systemctl reload caddy`. Trade-offs: no phone/home
  access for anyone (including you), and access breaks silently if the ISP
  changes the IP - keep this in mind before blaming the server.
- **Tailscale private network.** The CRM disappears from the public internet
  entirely; every staff device joins a free private network once. Strongest
  isolation, but with 40-60 people the device enrolment is real ongoing admin
  work. Do this only if you have someone who will own it.

Recommendation: run the pilot on the standard setup; add the allowlist after
cutover if your office has a static IP. Do not start with Tailscale unless
device management already exists in your company.

---

## Phase 5 — Backups (~10 minutes; do NOT postpone this)

```bash
sudo mkdir -p /var/backups/crm && sudo chown crm:crm /var/backups/crm
sudo -u crm crontab -e
# add:  30 21 * * * /opt/crm/deploy/backup.sh
```

Then arrange the **off-machine copy** — sync `/var/backups/crm` nightly to
object storage or any other machine. A backup on the server it protects is not
a backup.

**✓ check:** run `/opt/crm/deploy/backup.sh` by hand once; a `crm-<date>.dump`
file appears. Diary a quarterly restore drill (commands are in the script).

---

## Phase 6 — Configure the business (in the UI, ~30 minutes)

All of this is point-and-click as the admin at `https://crm.yourcompany.in/ui/`.

1. **Admin → Settings.** Set `finance.monthly_breakeven_inr` = 700000,
   `finance.collection_efficiency_pct` (85 until you have real history),
   `score.counsellor_monthly_collection_target_inr` from Phase 0. Leave the
   dial target at 80 until you have two weeks of data. Every change is audited.
2. **Admin → Products.** Create what counsellors sell — name, code, list price,
   and whether it is SEBI-regulated. No products = no deal can be booked.
3. **Admin → Users.** Create the pilot people: 2 callers (assign to a team,
   enter their dialing SIM number) and 1 counsellor. Give each a temporary
   password ≥10 characters — the system forces a change at first login.
4. **Admin → Ingestion → New source.** Name it, leave the sheet fields blank
   for now (next phase), priority `normal`. Create a second source named
   "Website — call back" with priority `immediate` if you use one.

**✓ check:** log in as one pilot caller in a private browser window: they are
forced to change the password, see an empty My Day, and can press
**Start shift**.

---

## Phase 7 — Connect the Meta Google Sheet (~45 minutes)

1. In Google Cloud Console: create a project → enable the **Google Sheets
   API** → create a **service account** → create a **JSON key** for it.
2. Open your Meta-connected sheet and **Share** it (Viewer) with the service
   account's email (`something@project.iam.gserviceaccount.com`).
3. On the server, place the key and reference it:
   ```bash
   sudo -u crm nano /opt/crm/api/google-sa.json     # paste the JSON key
   sudo chmod 600 /opt/crm/api/google-sa.json
   # in .env add:
   # GOOGLE_APPLICATION_CREDENTIALS=/opt/crm/api/google-sa.json
   sudo systemctl restart crm
   ```
4. In **Admin → Ingestion**, edit your source: paste the **Sheet ID** (the long
   string in the sheet's URL between `/d/` and `/edit`) and the **worksheet tab
   name**. Common column headers (Full Name, Phone Number, Email, City,
   campaign_name…) are auto-detected; map anything unusual in the column-map
   box.
5. Press **Sync from Google Sheet**. Read the summary line: created /
   duplicates / quarantined. Check the Quarantine tab — rows with undialable
   numbers land there with the reason, fixable and replayable.

Once credentials are in `.env`, the server also syncs automatically every 5
minutes during the day (`INGEST_INTERVAL_MINUTES` to change). Re-syncing is
always safe — the same sheet row can never create a second lead.

**✓ check:** submit a **test lead through the real Meta form** with your own
phone number. Within 5 minutes it appears in a pilot caller's My Day. This
single check exercises Meta → Sheet → ingestion → distribution → caller screen.

---

## Phase 8 — Pilot (two weeks)

Rules of the pilot:

- 2 callers + 1 counsellor work **only** in the CRM. Everyone else unchanged.
- Point only a **portion** of lead volume at the pilot (a separate sheet/form
  if you can); the rest keeps flowing to the old process.
- The counsellor starts each morning from **Floor → leakage chips**. The goal
  each day is "Pipeline clean ✓".
- Every deal the pilot closes is booked in the CRM with its instalment
  schedule, and every payment recorded — this is what makes the thermometer
  real.
- Keep a shared note of frictions: a missing disposition, a confusing label, a
  step that takes too many clicks. These are cheap to fix now, expensive after
  forty people build habits.

**✓ exit criteria (all four, before full rollout):**
1. A week where leakage was cleared to zero every day.
2. Pilot callers log calls without keeping any side notebook or sheet.
3. At least one deal booked with instalments, and a payment recorded against it.
4. First-touch time for immediate leads consistently inside the SLA on the
   dashboard.

---

## Phase 9 — Full floor cutover (one Monday)

1. The weekend before: create all remaining users, assign teams and rotation,
   collect dialing SIM numbers.
2. Repoint **all** lead sources to the CRM sheet(s). Freeze the old
   spreadsheet: mark it read-only that morning.
3. Monday 09:15, whole floor, 30 minutes: everyone logs in, changes password,
   presses Start shift, works one lead end to end.
4. Announce the one rule that does more than any training: **from the first of
   next month, incentives are computed from CRM data only.** No side
   spreadsheets accepted. Adoption problems mostly evaporate when pay depends
   on the data being in there.
5. Turn scoring conversations on gently: scores exist from day one, but for the
   first month TLs use them for coaching only, not ranking.

---

## Phase 10 — Running it (ongoing)

**Weekly (5 min):** `sudo apt update && sudo apt -y upgrade` for security
patches; glance at `sudo journalctl -u crm --since yesterday | grep -i error`.

**Updating the app** when new code lands on the main branch:
```bash
cd /opt/crm && sudo -u crm git pull
cd api && sudo -u crm npm ci --omit=dev
sudo -u postgres CRM_DB=crm ./../db/migrate.sh   # applies only new migrations
sudo systemctl restart crm
```

**When someone leaves:** Admin → Users → Deactivate. Their live sessions die
that instant, and their leads are visible to the counsellor for reassignment
via transfer. Then check Admin → Security alerts for bulk-read alerts from
their final days — that is what the access log exists for.

**Monthly founder checklist:**
- Thermometer month-end: collected vs ₹7,00,000, and the pace trend.
- Dues queue: anything overdue > 30 days gets a decision, not another reminder.
- Broken promises per counsellor (collections screen) — the honest early
  warning on collection culture.
- Unverified-dial counts on the caller dashboard (meaningful once the Android
  app ships).

---

## What is deliberately NOT in this runbook

- **The Android call-log app** — server contract is live
  (`POST /device-logs/sync`); commission the app after answering
  open-questions.md question 2. Until then dials are self-reported.
- **The advisory-pipeline handoff** (`handoff_outbox` / `handoff_inbound`) —
  needs a decision on question 5. Until wired, process refunds and the
  matching incentive clawback manually.
- **Call recording / QA tooling** — a separate telephony decision; the CRM
  scores conduct signals (dispositions, callbacks, verified dials), not audio.
