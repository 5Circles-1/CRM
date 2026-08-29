# Callyzer integration — proposal

**Status: proposal only. Nothing in this document is implemented.**
Written 29 Aug 2026 against Callyzer API **v2.2** (change log dated 1 Jun 2026),
base URL `https://api1.callyzer.co/api/v2.2/`.

---

## 1. The short answer

**Yes, and it fits better than it has any right to.**

Callyzer is a call-log collector: an Android app (*Callyzer Biz*) on each
caller's handset reads the device call log — and optionally the recordings —
and syncs it to Callyzer's cloud, which exposes it over a REST API and a
webhook.

This CRM already has exactly that hole, and already has the table that fills
it. `crm.device_call_logs` exists (migration 0006) and is filled today by the
in-house Android companion app through `POST /device-logs/sync`. Everything
downstream — `call_attempts.is_verified`, the log-call form's device-call
pre-fill, honest dial counts, the fabricated-activity QA signal — hangs off
that one table.

**So Callyzer is not a new subsystem. It is a second writer to a table that
already exists, with a mapping that is very nearly one-to-one.**

The single most important recommendation in this document is therefore about
what *not* to do:

> **Use Callyzer as a sensor, never as a second CRM.**
>
> Callyzer also ships Lead APIs (`/lead/save`, `/lead/capture`,
> `/lead/bulksave`, `/lead/get`), lead distribution, and its own lead statuses.
> Do not connect any of them. Lead ownership, the fairness engine, the ACE
> share, RLS and the "an open lead always has a `next_action_at`" guarantee are
> the load-bearing parts of this build. A second system distributing leads and
> holding a second copy of lead status would fight all of them, and the two
> would drift within a week. Callyzer's job is to answer one question: *did
> this call really happen, and for how long?*

---

## 2. What Callyzer actually gives us

### Authentication
Admin generates a token in the Callyzer dashboard under
**Connectors → API & Webhook → API Config → Generate API Access Key**.
It is sent as `Authorization: Bearer <token>`. It is a long-lived account-wide
token, not per-user and not OAuth — so it must be treated like a database
password: environment variable only, never in the repo, rotated on staff exit.

### Employee identity
An employee is keyed on their **registered mobile number**
(`emp_country_code` + `emp_number`), with optional `emp_code` and `emp_tags`.
Registration is: admin issues a **Device Connect Code** (`XXX-XXX-XXX`), the
employee installs *Callyzer Biz*, enters the code, picks the SIM to track,
verifies the number, and grants overlay + autostart permissions.

`GET /employee/get` returns each employee's `emp_name`, `emp_code`,
`emp_country_code`, `emp_number`, `emp_tags`, `app_version`, `registered_at`,
`last_call_at`, `last_sync_req_at`.

`app_version` and `last_sync_req_at` are worth more than they look — they are
how we detect a handset that has quietly stopped syncing, which is the failure
mode that makes verification silently useless.

### The call log — the part we want
`POST /call-log/history`, and the webhook, both return the same row shape:

| Field | Type | Notes |
|---|---|---|
| `id` | String | Stable unique id of the call log row |
| `emp_name`, `emp_code`, `emp_country_code`, `emp_number`, `emp_tags` | | who dialled |
| `client_name`, `client_country_code`, `client_number` | String | who they dialled |
| `duration` | Integer | seconds |
| `call_type` | String | `Incoming` / `Outgoing` / `Missed` / `Rejected` |
| `call_date` | String | `yyyy-mm-dd` |
| `call_time` | String | 24-hour |
| `note` | String | note typed in the Callyzer app |
| `call_recording_url` | String | on Callyzer's media host |
| `crm_status` | String | Callyzer's own lead status — **ignore** |
| `reminder_date`, `reminder_time` | String | Callyzer's own reminder — **ignore** |
| `synced_at`, `modified_at` | String | `yyyy-mm-dd hh:mm:ss Z` |
| `lead_id` | String | Callyzer's lead id — **ignore** |
| `call_method` | String | `PhoneCall` / `WhatsAppCall` |
| `call_mode` | String | `Voice` / `Video` |

Request filters: `call_from`/`call_to` **or** `synced_from`/`synced_to` (UNIX
seconds, UTC; either pair mandatory, range **must be under 180 days**),
`call_types`, `duration_grt_than`/`duration_les_than`, `emp_numbers`,
`emp_tags`, `client_numbers`, `page_no`, `page_size` (**max 100**), and — new
and **mandatory** in v2.2 — `call_method` and `call_mode`.

### Webhook
**Connectors → API & Webhook → Webhook Config**. Fields: Webhook URL, a
**Secret** used to validate the call is really from Callyzer, a version
selector, a "skip excluded numbers" toggle, and up to 5 alert emails for
delivery failures.

Payload is an array of employees, each carrying a `call_logs[]` array of the
rows above.

### Limits and cost
- **Rate limit: one request per two seconds.** Over it returns `429` with a
  `Retry-After`. This is severe and shapes the design (see §6).
- Errors: `401` bad token, `400` bad body, `403` **subscription expired**.
- **API + Webhook is a paid add-on: ₹150 per phone number per month**, on top
  of the plan. Call-recording storage is ₹500 per 5 GB per month. A 15-day
  free trial covers 5 phone numbers.

---

## 3. The mapping — why this fits

`crm.device_call_logs` today:

```sql
user_id, device_row_key, counterparty_msisdn, direction,
started_at, duration_seconds, matched_lead_id, uploaded_at
```

| Callyzer | → | CRM | Note |
|---|---|---|---|
| `id` | → | `device_row_key` | prefixed `callyzer:` — namespaced so the in-house app and Callyzer can never collide or double-count |
| `emp_country_code` + `emp_number` | → | `user_id` | via a new mapping table |
| `client_country_code` + `client_number` | → | `counterparty_msisdn` | through `crm.normalise_phone()`, which already returns NULL for undialable input |
| `call_type` | → | `direction` | **exact one-to-one**: Incoming/Outgoing/Missed/Rejected already matches the existing CHECK constraint, lowercased |
| `duration` | → | `duration_seconds` | same unit |
| `call_date` + `call_time` | → | `started_at` | interpreted in **Asia/Kolkata** — see the trap in §6 |
| — | → | `matched_lead_id` | the existing phone-match logic, unchanged |

The `direction` enum matching Callyzer's `call_type` exactly is luck, but it is
the kind of luck worth banking: no translation table, no unmapped fourth value,
no silent data loss.

---

## 4. The changes, in order

### 4.1 Database — one new migration (`0062_callyzer.sql`)

**A. Employee mapping.** Callyzer knows people by phone number; the CRM knows
them by `uuid`. One table, admin-writable, audited:

```
crm.callyzer_employees
  user_id            uuid primary key references crm.users(id)
  emp_country_code   text not null default '91'
  emp_number         text not null            -- unique
  emp_code           text
  last_seen_synced_at timestamptz             -- from /employee/get
  app_version        text
  is_active          boolean not null default true
```

Unmapped `emp_number` values must **never** be dropped silently — that is the
same mistake as dropping an undialable phone number. They go to a quarantine
table with the raw payload, exactly as the sheet importer already does for bad
rows, and surface on the intake alarm.

**B. Widen `crm.device_call_logs`** (all nullable, so existing rows and the
in-house app are untouched):

```
source            text not null default 'device_app'
                  check (source in ('device_app','callyzer'))
recording_url     text
call_method       text          -- PhoneCall | WhatsAppCall
call_mode         text          -- Voice | Video
external_note     text          -- Callyzer's `note`
external_synced_at   timestamptz
external_modified_at timestamptz
```

**C. Ingest function** `crm.ingest_callyzer_logs(jsonb)` — `SECURITY DEFINER`,
because it runs from the scheduler and the webhook under the ops account and
must be able to match leads across every caller, which no invoker-rights
function can do. It does the normalisation, the `on conflict (user_id,
device_row_key) do update` (Callyzer rows can be *modified* after the fact —
a note or a recording arrives late — so this is an upsert, not the in-house
app's `do nothing`), and returns counts.

**D. Settings** — every tunable in `crm.settings`, as the house rule requires:

| Key | Default | Meaning |
|---|---|---|
| `callyzer.enabled` | `false` | ships off |
| `callyzer.base_url` | `https://api1.callyzer.co/api/v2.2/` | version pinned |
| `callyzer.backfill_hours` | `26` | reconcile window per run |
| `callyzer.count_whatsapp_calls` | `false` | see §5.4 |
| `callyzer.store_recording_url` | `true` | see §5.2 |
| `callyzer.timezone` | `Asia/Kolkata` | asserted, not assumed |

### 4.2 API — one new route file (`api/src/routes/callyzer.ts`)

- `POST /integrations/callyzer/webhook` — **unauthenticated by session,
  authenticated by the shared Secret**, compared in constant time. This is the
  one route in the product that a stranger can reach, so it must: reject on a
  bad secret before parsing, cap the body size, validate with `zod` exactly as
  every other route does, and write through `Database.withUser(serviceUserId)`
  like the scheduler — never outside the RLS session contract.
- `GET /integrations/callyzer/health` (counsellor/admin) — last webhook
  received, last backfill run, rows in quarantine, and any employee whose
  `last_sync_req_at` is stale. This feeds the existing intake-alarm pattern
  from 0047/0054/0058, which already knows how to name a failing source and
  stand itself down when it recovers.
- `POST /integrations/callyzer/backfill` (admin) — run the pull now.

### 4.3 A client and a job

- `api/src/integrations/callyzer/client.ts` — token from the environment, and
  **a request queue that enforces one request per two seconds** with
  exponential backoff on `429` honouring `Retry-After`. The rate limit is not
  a footnote; it is the main constraint on this integration.
- `api/src/jobs/` — one new scheduled job, `sync_callyzer_logs`, every 15
  minutes, paging `/call-log/history` on `synced_from`/`synced_to` over the
  last `callyzer.backfill_hours`. **This job is not optional.** Webhooks drop.
  A dropped webhook is a call that really happened being recorded as
  unverified, which corrupts precisely the number the CRM exists to keep
  honest — so the pull is the reconciler that makes the push safe to trust.

### 4.4 UI

Almost nothing, which is the point.

- **Admin → Ingestion** grows a Callyzer panel: connection state, last webhook,
  employee mapping table with an "unmapped numbers" list, and the health
  readout.
- **Admin → Users** grows a "Callyzer number" field on each caller.
- The log-call form and the lead page need **no change at all** — a Callyzer
  row is a `device_call_logs` row, so the existing pre-fill and the existing
  `is_verified` flip already work.
- One honest addition: where a device call is offered, show a 🎧 link when
  `recording_url` is present and the viewer is a counsellor or admin.

### 4.5 Tests
- Database: the mapping, the direction translation, idempotency on re-delivery,
  upsert-on-modify, IST interpretation of `call_date`/`call_time`, quarantine of
  an unmapped employee.
- API: webhook rejects a wrong secret, accepts a right one, is idempotent under
  duplicate delivery, and never writes outside `withUser`.
- The rate-limit queue, unit tested against a fake clock.

---

## 5. Decisions only the owner can make

### 5.1 Money
₹150 per phone number per month for the API + Webhook add-on, on top of the
plan, plus ₹500 per 5 GB per month if recordings are kept. For a six-person
floor that is roughly **₹900/month for the API alone**, before the plan and
before storage. The 15-day trial covers 5 numbers, which is enough to prove
the integration end to end before anything is committed.

### 5.2 Recordings
`call_recording_url` points at Callyzer's media host. Storing the URL is
cheap and makes real call-QA coaching possible — which is in this CRM's scope.
But it means client conversations sit on a third party's storage, and the
recording of a client is that client's personal data.

**Recommendation:** store the URL, never proxy or re-host the audio, gate it
behind counsellor/admin RLS, and do not show a caller the recordings of their
own calls (it turns coaching into surveillance theatre and invites tampering
requests). `callyzer.store_recording_url = false` must genuinely stop storing
it, not merely hide it.

### 5.3 Personal-SIM privacy — the one to think hardest about
Callyzer Biz syncs **the whole call log of the tracked SIM**, personal calls
included, and the Callyzer dashboard shows the admin all of it.

This CRM deliberately does not work that way. `crm.device_call_logs` stores
unmatched rows but *surfaces them nowhere*, and its comment says so
explicitly: unmatched personal calls exist "solely so dial totals can be
reconciled." RLS makes a caller's raw log visible only to them and to admin.

Connecting Callyzer does not change our side — but it does mean the employer
now has a second screen, outside this CRM, that shows every personal call on
a personal handset. That is a real change in what the company can see about
its staff, and it needs a written policy and the callers' informed consent
before the first handset is enrolled — not after. Callyzer's own "Exclude
Numbers" feature and the webhook's *Skip Exclude Numbers* toggle are the tools
for this; set the toggle to **No** so excluded numbers never reach us either.

### 5.4 WhatsApp calls
v2.2 introduced `call_method: WhatsAppCall` and `call_mode: Video`. The floor's
dial targets, `dial.min_talk_seconds_for_connect`, and every conversion rate
were all designed around phone calls. Counting WhatsApp voice as a dial changes
every one of those numbers overnight.

**Recommendation:** ship with `callyzer.count_whatsapp_calls = false` — store
the rows so nothing is lost, exclude them from dial counts — and turn it on
deliberately, with the targets re-baselined in the same change.

### 5.5 Keep or retire the in-house Android app
**Recommendation: keep both running for two weeks.** They write to the same
table with namespaced `device_row_key`s, so there is no double counting, and
the overlap is the only honest way to measure whether Callyzer actually
captures more than the app already does. Retire the app only if the answer is
yes — this is a monthly bill against something that already works.

---

## 6. Traps, named in advance

1. **Timezone.** `call_date` and `call_time` come with **no timezone**. The
   history response stamps `synced_at` as `2023-11-30 22:42:53 IST`, i.e. the
   *Callyzer account's* timezone — but the webhook payload's `synced_at` has no
   zone at all. If the Callyzer account is not set to Asia/Kolkata, every
   `started_at` we store is wrong, and because this CRM does daily rollups on
   `crm.ist_date()`, a wrong offset moves calls between business days. The
   integration must **assert** the account timezone at startup and refuse to
   ingest if it is not IST, rather than assume it.
2. **The rate limit is one request per two seconds.** At `page_size` 100, a
   180-day backfill for a busy floor is hours of paging. Backfill must be a
   queued, resumable job that records its cursor — never a loop inside a
   request handler.
3. **v2.2 made `call_method` and `call_mode` mandatory in requests.** A client
   written against v2.1 silently starts failing. Pin the version in the base
   URL and treat a version bump as a code change with tests.
4. **`403` means "your subscription expired"**, not "forbidden". It must raise
   the intake alarm by name — a lapsed invoice silently ending call
   verification is exactly the class of failure 0054/0058 were built for.
5. **Rows can be modified after delivery.** A note or a recording arrives late
   against an existing `id`. Upsert, do not insert-and-ignore.
6. **Never let Callyzer's `crm_status`, `reminder_date` or `lead_id` touch our
   leads.** They are a second, unreconciled opinion about the same client and
   they will drift from ours. Store them if useful for audit; act on none of
   them.

---

## 7. Effort

| Piece | Estimate |
|---|---|
| Migration 0062 (mapping, columns, ingest function, settings) | 0.5 day |
| Callyzer client + rate-limit queue | 0.5 day |
| Webhook route + secret validation + idempotency | 0.5 day |
| Backfill job + cursor + health endpoint | 0.5 day |
| Admin UI panel + user number field | 0.5 day |
| Tests (database, API, the queue) | 1 day |
| Trial setup, 5 handsets, two-week parallel run | ongoing, not dev time |

**≈ 3.5 development days**, plus the parallel run.

---

## 8. Recommendation

Take the **15-day free trial on 5 numbers** first, and before writing any code,
answer two questions with real data from the Callyzer dashboard alone:

1. Does Callyzer capture calls the in-house app is missing today? If it does
   not, the integration is a monthly bill for a lateral move.
2. Is the account timezone IST, and do `call_date`/`call_time` match the actual
   call times on a handset? If not, everything downstream is wrong and it is
   cheaper to find that out in week one.

If both answers are good, build it as scoped above — as a **sensor feeding
`crm.device_call_logs`**, with the Lead APIs left firmly alone.
