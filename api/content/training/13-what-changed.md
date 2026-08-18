---
title: What changed recently
audience: all
order: 13
summary: Everything added or changed in the last release, why, and what it means for your day.
---

Read this once. Each entry says what changed, why, and what you should do
differently — if anything.

## The CRM now tells you when leads stop arriving

**What changed.** The Floor tab has a **lead intake** check at the very top.
While everything is flowing it is one quiet line. The moment a source stops
importing — sheet disconnected, credentials missing, tab renamed, every row
rejected — it turns into a red panel naming the source, the reason and the
fix, with an **Import the sheet now** button for admins and ops. Admins also
get a notification within the hour when nothing has arrived while the floor
is open.

**Why.** Leads sat in the Meta sheet for two days and never reached the CRM,
and every screen just looked quiet. "No fresh leads" and "the importer has
stopped" must never look the same again.

**What it means for you.** If Fresh leads is empty, look at the top of
**Floor**. It will either say intake is healthy — in which case the sheet
genuinely has nothing new — or tell you exactly what broke.

## Four new products

**What changed.** Swing Advisory, Trader Advisory, Pro Advisory and Grow+ are
sellable everywhere a product is chosen. They are priced per deal, so the
amount the counsellor enters is the amount that counts.

## Total and down payment, so part payments get chased

**What changed.** Adding a client by hand now asks for two numbers — the
**total** fee agreed and the **down payment** received now — and the client
book shows **Total / Paid / Due** as separate columns, with the date the
balance falls due.

**Why.** One number meant a man who paid ₹3,000 of a ₹30,000 programme was
recorded as a ₹3,000 client, fully paid. The ₹27,000 still owed existed
nowhere — not on the client book, not in the dues queue, not in anyone's
collection target. It could only be chased from memory.

**What it means for you.** Any balance now becomes a **real instalment**: it
appears on **Outstanding payments**, goes overdue if it slips, and is
collected with the ordinary punch-in. Paid in full? Type the total and the
down payment follows it — still one number, as before. And ✎ Edit carries the
same two fields, so correcting either one moves the balance with it.

## Attendance hours are honest now

**What changed.** A shift nobody ended used to keep counting — through the
evening, through the night, through days the person was absent — and then
blocked their next **Start shift** with "already logged in", so their actual
present days were never even recorded. That is how someone could show 6/10
days present with a 15-hour daily average.

Now hours can only be earned on the day they belong to. A forgotten shift is
closed automatically at the last thing the person actually did that day, and
pressing **Start shift** the next morning always works and always counts that
day as present. The old inflated records have been corrected the same way.

**What it means for you.** Press **End shift** when you leave — that is still
the honest record, and the system notes who forgot. But forgetting now costs
one stray minute, not a 24-hour day.

## One person, one live lead — the duplicates are gone

**What changed.** The floor spotted the same person in both teams' books, and
they were right. Three doors let it happen, and all three are now closed:

1. A lead **parked in re-tap or nurture for months** counted as "too old" by
   the duplicate check, so when that person filled the Meta form again a
   brand-new lead was created — and distribution often handed the copy to the
   other team. A still-live lead now absorbs a re-enquiry at **any** age, gets
   marked *immediate*, and comes back out of the parked pool.
2. **Previous-month uploads** only checked for duplicates inside the same
   month. The same person in January's sheet (uploaded for one team) and
   February's sheet (uploaded for the other) became two live leads. Uploads
   now check against every live lead, whichever team or month holds it.
3. The database itself never forbade duplicates. Now it does: **at most one
   live lead per phone number**, enforced by the schema, so no bug, race or
   import can ever recreate the problem.

**What it means for you.** Duplicates that already existed have been merged:
the copy with the real call history was kept and the other closed as a
duplicate, with a note in both leads' histories saying exactly what happened
and which record survived. Nothing was deleted — the closed copy's calls are
still readable on its own timeline. If a lead you were working suddenly shows
"Duplicate of another lead record", the same person is alive in the other
row; find them by phone in **Find lead**. Someone whose every old lead is
closed (lost, won, invalid) still becomes a fresh lead when they enquire
again — history never blocks a genuine return.

## The two money tabs, renamed

**What changed.** The client book (everyone who has paid, with the checkpoints)
is now called **Collections**. The dues queue (instalments, promises, the
punch-in) is now called **Outstanding payments**. Nothing moved — the pages,
their links and everything on them work exactly as before; only the names
swapped to match how the floor actually talks.

## Clients can be corrected — and buy more than one product

**What changed.** Every row on Collections has an **Edit** button. Name and
phone can be corrected on any client; product, amount, **paid date**, mode,
reference, who converted them and the lead source can be corrected on
hand-entered clients. And the same person
can now hold deals for **different products** — a Traders Discovery client
upgrading to Advisory is a second entry with the new product, not an error.
Only the **same** product twice is refused, because that is a double-entry.

**Why.** Typos happen at the desk, and until now fixing one meant asking a
developer. Upgrades happen too, and the CRM flatly refused to record them.

**What it means for you.** Fix mistakes yourself, the moment you see them —
but know that nothing is silently rewritten: every correction is stamped into
the client's history with what it was, what it became, and your name. Money
that went through the CRM's own recorded flow still cannot be edited — that
is an audit record for a SEBI-registered firm, and it stays one.

## Far fewer popups

**What changed.** Eight kinds of alert used to interrupt you. Now only two do:
a **callback that is due**, and one a few minutes **before** it is due.

**Why.** A popup every few minutes trains people to dismiss without reading,
and then a genuine callback gets clicked away with everything else.

**What it means for you.** Nothing is suppressed. Every other alert still
appears in the 🔔 bell, still counts in the badge, and still has a row on the
**Alerts** tab. You now go to them rather than being interrupted by them — so
**check the bell yourself** at the start of the day, after lunch, and before you
leave.

## A new Alerts tab

**What changed.** Everything waiting on you, grouped by what is wrong, on one
page you can actually work through. The bell shows a summary and the most
urgent twelve; this tab has all of it.

**What it means for you.** Tap any name to open the lead. If you genuinely
cannot get to something today, reschedule it — 1 hour, 3 hours, or tomorrow
morning. That decision is written into the lead's own history.

**What you cannot do:** simply mark a lead alert as "read". An overdue
follow-up is a promise to a customer; the only honest ways to clear it are to
work it or to move it.

## A new Fresh leads tab

**What changed.** Every lead **nobody has ever spoken to**, in one list,
flagged **in time** / **late** / **badly late**.

**Why.** This is the most recoverable money on the floor and it was the easiest
thing to overlook — especially leads sitting with **no caller at all**, which
appear in nobody's personal pipeline.

**What it means for you.** Start your day here and work it to empty. A late
fresh lead is never hidden or re-labelled: it stays on this list until somebody
actually calls. Counsellors, admins, ops and the founder can switch to **Whole
floor** to see leads nobody owns.

## A new Re-tap tab, and no more nagging about no-answers

**What changed.** After **{{setting:alert.na_quiet_after_attempts}} no-answers
in a row**, a lead goes **quiet**: it stops raising alerts and moves to the
**Re-tap** tab. Once every **{{setting:retap.reminder_days}} days** you get
**one** notification saying how many are waiting — never one per lead.

**Why.** A handful of people who never pick up were generating a hundred red
alerts between them.

**What it means for you.** Quiet does not mean lost. The lead keeps its next
action, is still yours, still appears in Find lead, and still counts in every
leakage figure. Work the Re-tap tab as a batch, longest silence first. A
WhatsApp often restarts one of these when a call will not.

## The lead history stopped repeating itself

**What changed.** A lead waiting with no caller used to record "held for shift
start" in its own history **every single minute**. Some leads had hundreds of
identical rows. That is fixed: a hold is now recorded once, and again only if
the situation genuinely changes.

**What it means for you.** Lead timelines are readable again. Older duplicate
rows are still there — history is never deleted here — but they are folded into
one line with a count.

## Lead flow now tells you *why*

**What changed.** The Floor tab used to say "83 leads waiting with no caller"
while two callers were visibly working. Both were true: the waiting leads
belonged to the other team. It now names the team and the exact blocker —
nobody on shift, everyone on the floor restricted, no callers in the team, or
leads belonging to no team at all.

**What it means for you.** Counsellors and admins: each reason names the fix.
Admins also get a **Hand out now** button.

## A daily brief

**What changed.** At 09:30, 16:00 and 20:30 you get a short brief with your own
numbers. Callers: leads in hand, untouched, callbacks, dial target. Counsellors:
what is left to collect this month, working days remaining, the run-rate that
requires, and the pace you are actually running. The 16:00 one stays silent if
you are on pace. There is also a **Today** strip across the top of every screen.

## The client book: three checkpoints, and manual entry

**What changed.** The register (now the **Collections** tab) has **three**
one-way ticks — **added to the client group**, **KYC done**, **MITC signed** —
with a *Paperwork open* filter. There is also **Add a client** for someone who
paid outside the CRM.

**What it means for you.** Anyone who pays *through* the CRM still appears
automatically; you never need the button for them.

## Mentors

**What changed.** Every paying client, whatever product they bought, with a
computed health chip and three-tap touchpoint logging. Clients whose paperwork
is unfinished carry a *paperwork open* chip.

## Events

**What changed.** A tab for seminars and webinars with a roster. Importing
leads **copies** them — the original keeps its owner, stage and history — which
is why both teams can work the same roster.

## Training, and this academy

**What changed.** All of this documentation now lives inside the CRM instead of
in a document nobody opens. Modules are role-aware, searchable, and quote the
system's **live** settings, so training cannot drift from reality. There is a
glossary of every screen element and a dictionary of **every term**.

**What it means for you.** Finish your track. The banner on the Training tab
tells you what you still owe, and a module that changes asks to be read again.

## Leads by hand, payments by hand

**What changed.** Counsellors, admins and ops can now **Add lead** (on Find
lead and Fresh leads) for phone-ins, walk-pasts and referrals — fair
distribution by default, a named caller when the person asked for someone. And
Outstanding payments has **Punch in a payment**: type the client, the amount
and the mode; the CRM does the instalment arithmetic and refuses overpayments.

**And when the payer is brand new:** the punch-in no longer sends you to
another tab. **Punch in for a new client** opens the Add-a-client form right
there, prefilled with what you typed. **The form also checks the book as you
type the phone number** — if the person already exists it says so on the
spot, shows what is open and with whom, and offers to record the payment
against the existing deal in one click, instead of refusing a fully-typed
form at the end. Every hand-entered client now records
**who converted them** — the named counsellor gets the deal, on their team,
and chases the instalments, not whoever did the typing — and **what the lead
source was**. Both show as columns on the Collections tab.

**What it means for you.** Nothing lands on sticky notes any more. If it rang,
walked in, or paid — it goes straight in the CRM, at the moment it happens.
And an admin punching in a counsellor's sale credits the counsellor, by name.

## Everything else

- **Dark mode** is complete — the ◐ button top-right. White bands on dark
  screens are fixed.
- The **browser tab** shows the plain product name again, with no count.
- **Searching a name** in Find lead returns matches instead of your whole book.
- Auto-logout after an hour never costs you time — your shift ends at your last
  real action.

```quiz
[
  {
    "q": "Fewer popups — does that mean some alerts are now hidden?",
    "options": ["Yes, low-priority ones are dropped", "No — everything is still in the bell and the Alerts tab; only the interrupting stopped"],
    "answer": 1,
    "why": "Being nagged about a lead and losing a lead are different problems."
  },
  {
    "q": "A fresh lead passes its deadline. Where does it go?",
    "options": ["It stays on the Fresh leads tab, flagged", "It is moved to Overdue", "It is closed"],
    "answer": 0,
    "why": "It stays until somebody actually calls the person."
  },
  {
    "q": "Which screen should you start your day on?",
    "options": ["Dashboards", "Fresh leads, then the bell", "Performance"],
    "answer": 1,
    "why": "Nobody has ever spoken to those people, and the bell is what is already owed."
  }
]
```
