# Go live — first-time server setup

This takes the v2 CRM from the repository to a working https://crm.yourdomain
that Sanya, Harsh and Aisha can sign into. Follow it top to bottom on a fresh
server; every block is copy-paste, and each phase says what you should see
before moving on. Total time: about an hour, most of it waiting for `apt`.

Nothing from the old build carries over — v2 starts from an empty database
by design (the product was reset while unused).

---

## Phase 0 — the three things to have ready

1. **A server.** Any small cloud VPS running **Ubuntu 24.04 LTS**: 1 vCPU,
   2 GB RAM, 25 GB disk is plenty for a four-person floor (₹400–800/month at
   DigitalOcean, Hetzner, AWS Lightsail, or any Indian provider). You need
   SSH access as root.
2. **A domain or subdomain** for the CRM, e.g. `crm.yourcompany.in`, with an
   **A record** pointing at the server's IP. HTTPS is then automatic.
3. **The admin email + a temporary password** you'll bootstrap with (10+
   characters; you change it at first sign-in).

Everything below is typed on the server over SSH, as root.

---

## Phase 1 — install the platform (~10 min)

```bash
apt update && apt upgrade -y
apt install -y git postgresql postgresql-contrib curl ufw
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
node --version   # should print v22.x
```

Caddy (the web server that handles HTTPS for you):

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

Basic firewall — SSH and the web, nothing else:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

---

## Phase 2 — the code (~2 min)

```bash
git clone https://github.com/5Circles-1/CRM.git /opt/crm
adduser --system --group --shell /bin/bash --home /opt/crm --no-create-home crm
chown -R crm:crm /opt/crm
```

> If the repository is ever made **private** (recommended — see the note at
> the end), the server needs a read-only deploy key:
> `ssh-keygen -t ed25519 -f /opt/crm/.ssh/id_ed25519 -N ''` (as the crm
> user, with `/opt/crm/.ssh` owned by crm, mode 700), add the `.pub` at
> GitHub → repo → Settings → Deploy keys, and switch the remote:
> `sudo -u crm git -C /opt/crm remote set-url origin git@github.com:5Circles-1/CRM.git`

---

## Phase 3 — the database (~2 min)

```bash
sudo -u postgres createdb crm
sudo -u postgres CRM_DB=crm /opt/crm/db/migrate.sh
```

You should see each migration apply, ending `==> up to date (5 applied this run)`.

Now the login role the app connects as. It inherits `crm_app` — row-level
security applies to it, which the server verifies at boot:

```bash
APP_DB_PASSWORD=$(openssl rand -hex 24)
sudo -u postgres psql -c "create role crm_api login password '${APP_DB_PASSWORD}' in role crm_app;"
sudo -u postgres psql -d crm -c "grant usage on schema crm to crm_api;"
echo "DB password (goes into .env in Phase 5): ${APP_DB_PASSWORD}"
```

---

## Phase 4 — dependencies + the first admin (~5 min)

```bash
cd /opt/crm/api
sudo -u crm npm ci --omit=dev
```

Create your admin account and the System service account (replace the three
values; keep the single quotes around the password):

```bash
sudo -u postgres env DATABASE_URL="postgresql://postgres@/crm?host=/var/run/postgresql" \
  node --experimental-strip-types src/tools/bootstrap.ts \
  --admin-email you@yourcompany.in \
  --admin-name "Your Name" \
  --admin-password 'a-long-temporary-password'
```

It prints a line like `SERVICE_USER_ID=xxxxxxxx-....` — **copy it**, it goes
into `.env` next. (Safe to re-run if you mistyped something.)

---

## Phase 5 — the environment file (~2 min)

```bash
cat > /opt/crm/api/.env <<EOF
DATABASE_URL=postgresql://crm_api:${APP_DB_PASSWORD}@localhost:5432/crm
SERVICE_USER_ID=paste-the-uuid-from-phase-4
PORT=8080
HOST=127.0.0.1
LOG_LEVEL=info
EOF
chown crm:crm /opt/crm/api/.env && chmod 600 /opt/crm/api/.env
nano /opt/crm/api/.env    # paste the real SERVICE_USER_ID, check the password line
```

(`HOST=127.0.0.1` because only Caddy on this machine talks to the app
directly; the outside world only ever reaches Caddy, over HTTPS.)

---

## Phase 6 — run it as a service (~2 min)

```bash
cp /opt/crm/deploy/crm.service /etc/systemd/system/crm.service
systemctl daemon-reload
systemctl enable --now crm
sleep 2 && curl -s localhost:8080/health
```

You should see `{"ok":true}`. If not: `journalctl -u crm -n 50 --no-pager`
— the most common cause is a typo in `.env`, and the error says so (the
server refuses to start on a wrong database role on purpose).

---

## Phase 7 — HTTPS and the domain (~3 min)

```bash
cp /opt/crm/deploy/Caddyfile /etc/caddy/Caddyfile
sed -i 's/crm.yourcompany.in/crm.YOURDOMAIN.in/' /etc/caddy/Caddyfile
systemctl reload caddy
```

Give the A record a few minutes if you just created it, then open
**https://crm.yourdomain.in** in a browser. You should see the sign-in
screen. Sign in with the Phase-4 email and password — it immediately makes
you set your real password.

---

## Phase 8 — nightly backups (~1 min)

```bash
mkdir -p /var/backups/crm && chown postgres:postgres /var/backups/crm
echo "30 21 * * * /opt/crm/deploy/backup.sh" | sudo -u postgres crontab -
```

(21:30 UTC = 03:00 IST.) A backup on the server it protects is not a backup —
sync `/var/backups/crm` somewhere else too (object storage, another machine,
even a laptop that pulls it weekly).

---

## Phase 9 — set up the floor (in the app, ~5 min)

1. **Admin → Team → + Add person**: Sanya (Caller), Harsh (Caller), Aisha
   (Follow-up), each with a temporary password — they set their own at first
   sign-in, from any browser or phone.
2. Test the pipeline end to end: **Leads → + Add lead** with your own phone
   number → it lands on a caller → log a call as Qualified → watch it pass
   to Aisha → mark Invite sent → Converted. The Dashboard counts each step.

---

## Phase 10 — connect the Google Sheets (Meta + ChatGPT) (~15 min)

The importer reads each source's Google Sheet every 5 minutes. It needs a
Google **service account** (a robot Google identity) once:

1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (any name, e.g. "5C CRM").
2. **APIs & Services → Library** → search **Google Sheets API** → Enable.
3. **APIs & Services → Credentials → Create credentials → Service account**
   → any name → Done (no roles needed).
4. Open the service account → **Keys → Add key → Create new key → JSON** —
   a `.json` file downloads.
5. Put it on the server (from your computer):
   ```bash
   scp Downloads/your-key-file.json root@crm.YOURDOMAIN.in:/opt/crm/api/google-sa.json
   ```
   then on the server:
   ```bash
   chown crm:crm /opt/crm/api/google-sa.json && chmod 600 /opt/crm/api/google-sa.json
   echo 'GOOGLE_APPLICATION_CREDENTIALS=/opt/crm/api/google-sa.json' >> /opt/crm/api/.env
   systemctl restart crm
   ```
6. **Share each lead sheet with the robot.** This is the step everyone
   forgets:
   ```bash
   bash /opt/crm/db/google-address.sh
   ```
   prints the address (ends in `.iam.gserviceaccount.com`). In Google
   Sheets: Share → paste it → Viewer → untick "Notify people" → Send. Do
   this on the Meta sheet and the ChatGPT sheet.
7. In the CRM: **Admin → Sources → Edit** on Meta — paste the sheet's
   browser URL and the tab name — then **Sync now**. Same for ChatGPT.
   After that it is automatic every 5 minutes; leads distribute to Sanya
   and Harsh as they land.

If leads ever stop arriving, `bash /opt/crm/db/diagnose.sh` on the server
answers why, read-only.

> The Meta side itself (lead form → sheet) stays whatever you use today —
> Meta's sheet export or a Make/Zapier scenario appending rows. The CRM only
> needs the rows to land in the sheet; headers like "Full Name" / "Phone
> Number" / "Email" / "City" are recognised automatically.

---

## Phase 11 — updates from now on

By hand, any time:

```bash
sudo /opt/crm/deploy/update.sh
```

Or let GitHub do it: repo → **Settings → Secrets and variables → Actions** →
add secret `DEPLOY_HOST` (the server address) and `DEPLOY_SSH_KEY` (a private
key that can SSH in as root — generate a dedicated pair, put the `.pub` line
in the server's `/root/.ssh/authorized_keys`). From then on **every merge to
the default branch updates the live server by itself**, running the same
`update.sh` (fast-forward pull, migrations applied exactly once, restart,
health check).

---

## One security note

The GitHub repository is currently **public**. The code contains no secrets
(credentials live only in `/opt/crm/api/.env` on the server), but an internal
CRM's source being world-readable is an unnecessary gift. Consider repo →
Settings → General → Danger zone → **Change visibility → Private**; if you
do, set up the deploy key from Phase 2's note so the server can still pull.
