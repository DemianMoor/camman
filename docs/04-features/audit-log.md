# Feature — Audit log & alerting

_Last updated: 2026-09-03_

ClickUp 869et3vm1 Phase 4. Owner-only audit feed, a login-from-new-IP alert, and
a daily digest. No migration — `audit_log` shipped in 0175.

## 1. `/settings/audit`

Owner-only ([`audit.view`](../../lib/permissions.ts), owner alone). Newest
first, 50 per page, filterable by actor, action and date range. **No export** —
the brief did not ask for one, and an export of this table would need its own
access decision rather than inheriting the page's.

Three layers deny the operator, deliberately, because a record *of* someone is
the thing they would most want to reach: the `/settings` layout guard, the
page's own `can(role, "audit.view")`, and the API's independent check.

**Action filter takes prefixes.** `auth.`, `user.`, `guardrail.` select whole
families, because that is how an owner thinks about them ("show me every
guardrail event"), and the concrete actions are listed underneath from
`SELECT DISTINCT action` rather than a hardcoded union that would drift.

**`to` is inclusive.** A date input yields midnight; the filter pushes it to the
end of that day, because picking "3 Sep" and getting nothing from 3 Sep is a bug
in the reader's eyes even when it is defensible in the query's.

Actor emails come from the Supabase Admin API, not a join — `auth.users` is
Supabase-managed. Best-effort: if it is unavailable the actor column degrades to
a raw id instead of the screen failing.

## 2. Login from a new IP

`recordLogin` raises `auth.login_new_ip` the first time an `(actor, ip)` pair
appears in `audit_log`, and now **also posts to Telegram**. Phase 2 wrote the row
and stopped there, which meant the single event most worth interrupting someone
about was only discoverable by going to look for it.

⚠️ **A prompt for a human, never a control.** The address comes from
`x-forwarded-for`, whose left-hand entries are client-controlled, so anyone able
to spoof it can equally suppress the alert. Nothing gates on it.

The audit row is written **before** the Telegram call, and the call's result is
ignored — a Telegram outage must never cost the durable record.

## 3. Daily digest

`/api/cron/audit-digest`, **09:00 ET (13:00 UTC)** — after the previous ET day
has closed, so the window it reports is complete. One message per org: per-actor
action counts, guardrail events, and the pending deletion queue.

⚠️ **Off the send path.** It reads `audit_log` and `deletion_requests` only, and
never touches `stage_sends`, materialize or the drain.

**A quiet day sends nothing.** No activity and an empty queue means no message —
a daily "nothing happened" ping trains people to ignore the channel the real
alerts are competing with.

## 4. Audit coverage

[`scripts/test-audit-coverage.ts`](../../scripts/test-audit-coverage.ts) checks
two things, because either alone misleads:

1. **Static** — every declared guardrail event is actually raised somewhere. A
   declared event nobody emits is a hole no database inspection can reveal,
   because its absence looks exactly like "it hasn't happened yet".
2. **Live** — a real sample row for each event that has occurred.

It also asserts `writeAuditLog` precedes `notifyTelegram` in the notify path.

An event with no live row is reported as **not yet observed**, not as a failure —
several fire only at volumes this environment has never reached, and failing on
that would be a guard that goes red for being correct.
