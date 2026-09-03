import "./_env-preload";

import postgres from "postgres";

import { db } from "@/db/client";
import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import {
  computeTxrMessagesWindow,
  pollTxrMessages,
  type TxrMessageRow,
  type TxrMessagesPage,
} from "@/lib/sends/textrequest-messages-poll";
import { decryptCredentialKey } from "@/lib/sends/provider-credential";
import { textrequestBaseUrl } from "@/lib/sends/providers/textrequest";

// Recovery drain for Text Request INBOUND (STOP) messages that the live poller
// never saw because the sending number carried no `dashboard_id` — with none,
// resolveTxrPollTargets skips the dashboard entirely and no per-dashboard
// `msg_received` hook was ever registered, so opt-out intake is silently dark
// while sends and DLRs (account- and credential-scoped) work perfectly.
//
//   npx tsx --conditions=react-server scripts/drain-textrequest-inbound.ts --dashboards=68804,68805 --hours=12
//   npx tsx --conditions=react-server scripts/drain-textrequest-inbound.ts --dashboards=68804,68805 --hours=12 --apply
//
// Dry-run by default: reports how many inbound rows are in the window, how many
// are opt-out keywords, and how many are ALREADY captured. `--apply` delegates
// to the production `pollTxrMessages` with the walk scoped to these dashboards'
// inbound direction, so suppression, stage attribution and cross-channel
// idempotency (UNIQUE(provider_id, provider_uuid)) are byte-identical to a cron
// tick — no second implementation to drift.
//
// Bind `dashboard_id` on the number and register the hooks FIRST; this only
// recovers the backlog, it does not fix the cause. Run with
// `--conditions=react-server` (the module graph reaches `server-only`).

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dashboards = (args.find((a) => a.startsWith("--dashboards="))?.split("=")[1] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const hours = Number(args.find((a) => a.startsWith("--hours="))?.split("=")[1] ?? 12);

// Verbatim copy of the poller's private realFetchTxrMessages. Copied rather than
// re-derived so the request contract (documented `start_date`/`end_date`, the
// enum-validated `sort`, `message_direction`) cannot drift from the live poll.
async function fetchPage(opts: {
  apiKey: string;
  dashboardId: string;
  window: { start_date: string; end_date: string };
  page: number;
  pageSize: number;
  direction?: "S" | "R";
  sort?: "desc";
}): Promise<TxrMessagesPage> {
  try {
    const u = new URL(`${textrequestBaseUrl()}/dashboards/${encodeURIComponent(opts.dashboardId)}/messages`);
    u.searchParams.set("start_date", opts.window.start_date);
    u.searchParams.set("end_date", opts.window.end_date);
    u.searchParams.set("page", String(opts.page));
    u.searchParams.set("page_size", String(opts.pageSize));
    if (opts.direction) u.searchParams.set("message_direction", opts.direction);
    if (opts.sort) u.searchParams.set("sort", opts.sort);
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { "x-api-key": opts.apiKey, Accept: "application/json" },
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const raw = await res.text();
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { ok: false, error: "non-JSON response" };
    }
    const items = Array.isArray(parsed.items) ? (parsed.items as TxrMessageRow[]) : [];
    const meta = (parsed.meta ?? null) as { total_items?: number } | null;
    return {
      ok: true,
      items: items.filter((m) => m && typeof m.message_id === "string"),
      totalItems: meta?.total_items ?? items.length,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}

async function main() {
  if (dashboards.length === 0) {
    console.error("--dashboards=<id,id> is required");
    process.exit(1);
  }
  const want = new Set(dashboards);
  const sql = postgres(process.env.DATABASE_URL!, { prepare: false, max: 2 });
  const window = computeTxrMessagesWindow(new Date(), hours);
  console.log(`window ${window.start_date} -> ${window.end_date} (${hours}h)`);
  console.log(`dashboards: ${dashboards.join(", ")} · mode: ${APPLY ? "APPLY" : "dry-run"}`);

  const creds = await sql`
    select pc.id, pc.api_key, pc.api_key_encrypted
    from provider_credentials pc join sms_providers p on p.id = pc.provider_id
    where p.sms_provider_id = 'txr'`;

  // Dry-run: report the backlog without writing.
  for (const c of creds) {
    const apiKey = decryptCredentialKey(c as { api_key: string | null; api_key_encrypted: string | null });
    if (!apiKey) continue;
    for (const dashboardId of dashboards) {
      const page = await fetchPage({ apiKey, dashboardId, window, page: 0, pageSize: 1000, direction: "R", sort: "desc" });
      if (!page.ok) {
        console.log(`  dashboard ${dashboardId}: fetch failed — ${page.error}`);
        continue;
      }
      const ids = page.items.map((m) => m.message_id);
      const stops = page.items.filter((m) => isOptOutKeyword(m.body ?? ""));
      const captured = ids.length
        ? await sql`select count(*)::int as n from textrequest_inbound_events where provider_uuid = any(${ids})`
        : [{ n: 0 }];
      console.log(
        `  dashboard ${dashboardId}: inbound_in_window=${page.totalItems} fetched=${ids.length} ` +
          `opt_out_keywords=${stops.length} already_captured=${captured[0].n}`,
      );
    }
  }

  if (!APPLY) {
    console.log("dry-run only — re-run with --apply to ingest");
    await sql.end();
    return;
  }

  // Delegate to the production poller, with the walk scoped to these
  // dashboards' INBOUND direction. Everything outside the scope returns an
  // empty page, so no outbound DLR re-reconciliation is triggered.
  const result = await pollTxrMessages(db, {
    lookbackHours: hours,
    fetchMessages: async (opts) => {
      if (opts.direction !== "R" || !want.has(opts.dashboardId)) {
        return { ok: true, items: [], totalItems: 0 };
      }
      return fetchPage(opts);
    },
  });
  console.log(JSON.stringify(result, null, 2));
  await sql.end();
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
