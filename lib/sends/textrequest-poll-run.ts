import type { db } from "@/db/client";
import { pollTxrOptedOutContacts } from "@/lib/sends/textrequest-contacts-poll";
import { checkTxrWebhookHealth } from "@/lib/sends/textrequest-hooks";
import { pollTxrMessages, type TxrMessagesPollResult } from "@/lib/sends/textrequest-messages-poll";
import {
  beginTxrPollRun,
  checkTxrPassAges,
  finishTxrPollRun,
  type TxrPassCheck,
  type TxrRunStart,
} from "@/lib/sends/textrequest-poll-health";

// One tick of /api/cron/textrequest-poll (ClickUp 869fcqhcu). Lives here, not in
// the route, so scripts/test-textrequest-poll-run.ts can drive it with stub
// steps — including a bookkeeping step that throws.
//
// ⚠️ EVERY STEP IS ISOLATED, the run-health bookkeeping included. The order is
// compliance first: inbound STOP walks → contacts opt-out poll → webhook health
// → outbound receipts. `begin`/`finish` only feed alerts; if either throws (a
// cron_locks hiccup, a Telegram timeout) the compliance steps must still run.
// A throw costs at worst one missed or duplicated "did not finish" alert.

export type StepResult<T> = { ok: true; ms: number; result: T } | { ok: false; ms: number; error: string };

export async function step<T>(name: string, fn: () => Promise<T>): Promise<StepResult<T>> {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - t0, result };
  } catch (e) {
    console.error(`[textrequest-poll] step ${name} threw:`, e);
    return { ok: false, ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface TxrPollSteps {
  begin: () => Promise<TxrRunStart>;
  inbound: () => Promise<TxrMessagesPollResult>;
  contacts: () => Promise<unknown>;
  health: () => Promise<unknown>;
  outbound: () => Promise<TxrMessagesPollResult>;
  passCheck: (dashboards: string[]) => Promise<TxrPassCheck[]>;
  finish: () => Promise<{ recovered: boolean }>;
}

export function defaultTxrPollSteps(
  database: typeof db,
  o: { orgId?: string; deadlineAt: number },
): TxrPollSteps {
  return {
    begin: () => beginTxrPollRun(database),
    inbound: () => pollTxrMessages(database, { orgId: o.orgId, directions: ["R"] }),
    contacts: () => pollTxrOptedOutContacts(database, { orgId: o.orgId }),
    health: () => checkTxrWebhookHealth(database, { orgId: o.orgId }),
    outbound: () =>
      pollTxrMessages(database, { orgId: o.orgId, directions: ["S"], deadlineAt: o.deadlineAt }),
    passCheck: (dashboards) => checkTxrPassAges(database, dashboards),
    finish: () => finishTxrPollRun(database),
  };
}

export async function runTxrPollTick(
  steps: TxrPollSteps,
  o: { cron: boolean; startedAt: number; log?: (line: string) => void },
) {
  // Bookkeeping only for the CRON run: manual runs bypass the lease and must not
  // read as a dead cron run.
  const begin = o.cron ? await step("begin", steps.begin) : null;
  const inbound = await step("inbound", steps.inbound);
  const contacts = await step("contacts", steps.contacts);
  const health = await step("health", steps.health);
  const outbound = await step("outbound", steps.outbound);
  const dashboards = [
    ...new Set([inbound, outbound].flatMap((r) => (r.ok ? r.result.walks.map((w) => w.dashboard_id) : []))),
  ];
  const passes = o.cron ? await step("pass-check", () => steps.passCheck(dashboards)) : null;
  const finish = o.cron ? await step("finish", steps.finish) : null;
  // ONE line per run, so the run history is countable from the request logs
  // (the 24 h verification counts these: every step must say ok). Per-step ms
  // is there to watch the unbudgeted inbound step.
  (o.log ?? console.log)(
    JSON.stringify({
      txr_poll_run: {
        cron: o.cron,
        ms: Date.now() - o.startedAt,
        begin: begin?.ok ?? null,
        inbound: inbound.ok,
        inbound_ms: inbound.ms,
        inbound_seen: inbound.ok ? inbound.result.inbound_seen : null,
        inbound_captured: inbound.ok ? inbound.result.inbound_captured : null,
        contacts: contacts.ok,
        contacts_ms: contacts.ms,
        health: health.ok,
        health_ms: health.ms,
        outbound: outbound.ok,
        outbound_ms: outbound.ms,
        outbound_complete: outbound.ok ? outbound.result.outbound_gaps.length === 0 : false,
        gaps: outbound.ok ? outbound.result.outbound_gaps.length : null,
        captured: outbound.ok ? outbound.result.captured : null,
        finish: finish?.ok ?? null,
      },
    }),
  );
  return { begin, inbound, contacts, health, outbound, passes, finish };
}
