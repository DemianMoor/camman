// The txr poll tick must run its compliance steps whatever the alert
// bookkeeping does (ClickUp 869fcqhcu, review item on PR #306).
//
// Pure: every step is a stub, no DB, no network, no Telegram.
// Run: npx tsx --conditions=react-server scripts/test-textrequest-poll-run.ts
import "./_env-preload";

import type { TxrMessagesPollResult } from "@/lib/sends/textrequest-messages-poll";
import { runTxrPollTick, type TxrPollSteps } from "@/lib/sends/textrequest-poll-run";

delete process.env.TELEGRAM_BOT_TOKEN;

let failed = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`${cond ? "✓" : "✗"} ${name}${cond ? "" : `  ${detail}`}`);
}

const emptyPoll = (dash: string): TxrMessagesPollResult => ({
  credentials_polled: 1, dashboards_polled: 1, fetched: 0, outbound_with_status: 0, captured: 0, dupe: 0,
  matched: 0, unmatched: 0, inbound_seen: 0, inbound_captured: 0, inbound_dupe: 0, inbound_suppressed: 0,
  truncated: false, sort_fallbacks: 0, error: null,
  walks: [{ dashboard_id: dash, direction: "R", kind: "window", from: "", to: "", pages_read: 0, complete: true, stopped: null }],
  outbound_gaps: [],
});

function stubs(ran: string[], throwing: Set<string>): TxrPollSteps {
  const s = <T>(name: string, value: T) => async () => {
    ran.push(name);
    if (throwing.has(name)) throw new Error(`${name} exploded (test)`);
    return value;
  };
  return {
    begin: s("begin", { previous_died: false, previous_started: null, alerted: false }),
    inbound: s("inbound", emptyPoll("d1")),
    contacts: s("contacts", {}),
    health: s("health", {}),
    outbound: s("outbound", emptyPoll("d1")),
    passCheck: async () => {
      ran.push("passCheck");
      if (throwing.has("passCheck")) throw new Error("passCheck exploded (test)");
      return [];
    },
    finish: s("finish", { recovered: false }),
  };
}

async function main() {
  const logs: string[] = [];
  const quiet = (l: string) => logs.push(l);
  // Silence the expected step-error output so the test reads cleanly.
  const err = console.error;
  console.error = () => {};
  try {
    // 1. begin throws: every compliance step still runs, in order.
    const ran1: string[] = [];
    const r1 = await runTxrPollTick(stubs(ran1, new Set(["begin"])), { cron: true, startedAt: Date.now(), log: quiet });
    check("begin threw and is reported as a failed step, not thrown", r1.begin?.ok === false, JSON.stringify(r1.begin));
    check("inbound STOP walk still ran after begin threw", ran1.includes("inbound") && r1.inbound.ok);
    check("contacts opt-out poll still ran after begin threw", ran1.includes("contacts") && r1.contacts.ok);
    check("webhook health still ran after begin threw", ran1.includes("health") && r1.health.ok);
    check("outbound, pass check and finish still ran", ["outbound", "passCheck", "finish"].every((x) => ran1.includes(x)));
    check(
      "compliance order: inbound → contacts → health → outbound",
      ran1.join() === "begin,inbound,contacts,health,outbound,passCheck,finish",
      ran1.join(),
    );
    const line1 = JSON.parse(logs[0] ?? "{}").txr_poll_run ?? {};
    check("the run log line says begin failed and the compliance steps ok",
      line1.begin === false && line1.inbound === true && line1.contacts === true && line1.health === true, logs[0]);

    // 2. finish and the pass check throw too: nothing escapes the tick.
    const ran2: string[] = [];
    let escaped: unknown = null;
    const r2 = await runTxrPollTick(stubs(ran2, new Set(["begin", "passCheck", "finish"])), {
      cron: true, startedAt: Date.now(), log: quiet,
    }).catch((e) => { escaped = e; return null; });
    check("a throwing finish/pass check never escapes the tick", escaped === null && r2 !== null, String(escaped));
    check("finish failure is reported", r2?.finish?.ok === false);

    // 3. A compliance step throwing does not stop the next one.
    const ran3: string[] = [];
    const r3 = await runTxrPollTick(stubs(ran3, new Set(["inbound", "contacts"])), { cron: true, startedAt: Date.now(), log: quiet });
    check("inbound and contacts threw, health and outbound still ran", r3.health.ok && r3.outbound.ok, ran3.join());

    // 4. Manual (session) run: no bookkeeping at all.
    const ran4: string[] = [];
    await runTxrPollTick(stubs(ran4, new Set()), { cron: false, startedAt: Date.now(), log: quiet });
    check("manual run does not touch begin / pass check / finish",
      !ran4.includes("begin") && !ran4.includes("passCheck") && !ran4.includes("finish"), ran4.join());
  } finally {
    console.error = err;
  }
  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
