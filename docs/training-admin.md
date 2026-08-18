# Admin — how to run the CRM

> **The canonical training now lives inside the CRM**, under the **Training**
> tab: role-aware modules, a searchable UI glossary, a per-module check and a
> recorded acknowledgement, with the live configuration substituted into the
> text. Source: `api/content/training/`. This file remains for classroom and
> offline use — if the two ever disagree, the in-app module is correct.

You own the configuration, the people, and the numbers everyone else is
measured by. Most of your work is done in the first week and then rarely
touched.

Read the caller and counsellor guides first. Almost every question you will be
asked is answered in one of them.

---

## The first week

1. **Users** — create everyone with their real email and a temporary password
   they must change at first login. Put callers on a team; the team decides who
   they share leads with.
2. **Products** — the things you sell, with list prices.
3. **Settings** — set `finance.monthly_breakeven_inr` to 7,00,000. Leave the
   rest alone until you have a reason.
4. **Ingestion** — add each Google Sheet as a source. Set which team it feeds
   and whether it is `immediate` or `normal`.
5. Watch for a week before changing anything.

### Sources: two mistakes that cost a day each

- **Priority.** If every source is `immediate`, every lead has a 5-minute SLA
  and the urgent queue means nothing. Use `immediate` for the feed that really
  is urgent and `normal` for the rest.
- **Team pinning.** *Send these leads to* pins a sheet to one team. Leave it on
  "both teams, alternating" for a shared feed. Pin it when the sheet belongs to
  one desk.

If two active sources point at the same spreadsheet and tab, the CRM warns you
in amber. Do not ignore it: the same lead read twice is treated as a repeat
enquiry, which forces it to `immediate`. Wire the same sheet in twice and every
lead becomes urgent.

### The first sync reads the whole sheet

A sheet with six months of history puts six months of leads on the floor. If
that is not what you want, run the reset **after every source has synced once**:

```
sudo -u postgres psql -d crm -c "update crm.lead_sources set is_active = false;"
sudo /opt/crm/deploy/backup.sh
sudo -u postgres psql -d crm -f /opt/crm/db/ops/reset-leads.sql
sudo -u postgres psql -d crm -c "update crm.lead_sources set is_active = true;"
```

It clears the lead book but **keeps the record of which sheet rows were seen**,
so history stays out and new rows still arrive. A source that has never synced
has nothing recorded, which is why the order above matters.

---

## Users

Nothing is ever deleted. Someone who leaves is **deactivated** — their sessions
end immediately and their history stays attached to them.

When they come back, press **Reactivate** and set a new password. Do **not**
create a second account: their leads, calls, attendance and scores stay on the
first one, and you end up with one person split across two rows and two sets of
numbers.

If you see "An account with that email already exists", it is deactivated.
Reactivate it.

---

## Settings you will actually change

| Setting | Default | Change it when |
|---|---|---|
| `sla.untouched_reassign_minutes` | 0 (off) | Leads stay with their caller; a value above 0 would revive the old sweep |
| `alerts.poll_seconds` | 20 | Popups feel too frequent, or new leads appear too slowly |
| `alerts.popup_kinds` | callback due, own reminder | Something is interrupting that should sit quietly in the bell |
| `sla.retry_after_not_answered_minutes` | 180 | Callers are being nagged about dead numbers |
| `sla.retry_after_switched_off_minutes` | 240 | Same, for phones that are off |
| `sla.retry_after_will_call_back_minutes` | 2880 | Someone said they would ring us and we are chasing anyway |
| `finance.monthly_breakeven_inr` | — | Your cost base changes |
| `dial.min_talk_seconds_for_connect` | 30 | Almost never. This is what stops connect rates being fiction |

Every change is recorded with your name against it. "Who moved the dial target"
gets asked the day after payout, and the CRM can answer it.

**Do not raise the retry intervals to silence complaints without looking at
why.** If callers are being nagged hourly about dead numbers, the gap is the
right fix. If they are being nagged about live leads they have not called, the
gap is not the problem.

---

## Performance

**Performance** shows every person on the floor. Sort by any column. Click
**Walked in** for who is actually bringing people through the door.

A dash in a percentage column means the denominator was zero — nobody is ranked
on a percentage of no calls.

### What to look at weekly

- **Talk time per caller.** The hardest number to fake and the most predictive.
- **Connect rate against talk time.** High connects with low talk time means
  short calls being logged as conversations.
- **Visits promised against walked in.** A big gap means promises are being
  recorded that never happen.
- **Job enquiries.** A rising count means your ads are reaching job seekers —
  a marketing problem, not a caller problem.
- **Interested against deals.** Interest that does not convert is a counsellor
  question, not a caller one.

---

## Security

Access is enforced by the database, not the application. A caller sees their
own leads; a counsellor sees their team; you see everything. A missing filter
in the app shows *too few* rows, never someone else's lead book.

**Security alerts** flags bulk reads and out-of-hours access. Look at it weekly.
Somebody reading four hundred leads in ten minutes is either exporting your
lead book or has a bug worth knowing about.

The audit log records every setting change, transfer, deal and password reset,
and it cannot be edited or deleted — by you either. That is deliberate.

---

## Backups

They run nightly at 03:00 IST. Check monthly:

```
ls -lh /var/backups/crm/
```

**Test a restore once a quarter.** A backup nobody has restored is a hope:

```
sudo -u postgres createdb crm_restore_test
sudo -u postgres pg_restore -d crm_restore_test $(ls -t /var/backups/crm/*.dump | head -1)
sudo -u postgres psql -d crm_restore_test -c "select count(*) from crm.leads;"
sudo -u postgres dropdb crm_restore_test
```

A non-zero count means your backups are real.

⚠️ **The backups live on the same server they protect.** Lose the droplet and
you lose both. Copying them somewhere else is the single most valuable
unfinished job on this system.

⚠️ **Never run `db/rebuild.sh` on the server.** It drops the database. It is a
development tool.

---

## 🟢 Green flags

- Pipeline leaks low and falling across the day
- Untouched counts low — every lead's owner is starting their list
- Talk time steady or rising
- Walk-ins converting better than phone-only leads
- Collections tracking at or above pace on the thermometer
- Quarantine near-empty — the sheets are clean
- Security alerts quiet

## 🔴 Red flags

- **Every lead `immediate`.** Your source priorities are wrong and the urgent
  queue is meaningless.
- **Two active sources on the same sheet and tab.** The CRM warns you in amber.
- **Ingestion runs failing.** Read the error — it names the tab or tells you to
  share the sheet with the service account.
- **Quarantine growing.** Phone numbers arriving unusable. A form problem.
- **Retry intervals raised repeatedly.** Someone is silencing a symptom.
- **Two accounts with the same person's name.** One is deactivated and someone
  made a new one instead of reactivating. Their history is split.
- **Bulk-access alerts.** Investigate the same day.
- **`ls /var/backups/crm/` empty or stale.** You have no backups. Nothing else
  on this list matters as much.
- **Nobody has ever tested a restore.** Same problem, one step later.

## Problems you will hit

| What you see | What it means | What to do |
|---|---|---|
| "Unable to parse range: 'X'" | The worksheet tab name is wrong | The error lists the real tabs. Set one in **Edit** on the source |
| "The caller does not have permission" | The sheet is not shared | Share it with the service account as Viewer |
| "An account with that email already exists" | It is deactivated | **Reactivate**, do not create a second |
| Leads arriving but nobody has them | No callers on shift | They park at team level and land at shift start |
| Popups too frequent | Poll interval or popup kinds | `alerts.poll_seconds`, `alerts.popup_kinds` |
| Conversion rates look wrong | Usually job enquiries logged as "not interested" | Coach the floor on the outcome list |
| The whole sheet imported at once | First sync reads everything | Reset — see the ordered steps above |
