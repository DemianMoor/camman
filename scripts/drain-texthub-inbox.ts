// One-shot drain of TextHub's inbound inbox via the NEW paginated API
// (`?inbox=true&page=N`), ingesting every STOP the live poller is currently
// starved on. TextHub switched the inbox from a flat ~200-most-recent list to a
// paginated, retained ~1,500-message window; our `*/15` poller reads only page 1
// and processes credentials sequentially under a 60s cap, so a high-volume
// account (txh2) starves the other (txh) — txh page 1 shows 200 uningested with
// ~1,300 more stranded on pages 2-8. This walks ALL pages and ingests them with
// the EXACT live-poller semantics.
//
// Idempotent & poller-aligned: each message is CLAIMED in texthub_inbound_events
// by (provider_id, provider_message_id) exactly like the poller, so (a) re-runs
// skip already-ingested messages and (b) once the durable paginated poller
// deploys it treats these as seen and never double-counts. opt_outs use
// source='sms_inbound' (identical to the poller), created_at = the STOP's real
// receipt time (TextHub Mountain wall-clock -> UTC via parseProviderReceivedAt),
// attributed to the single most-recent send in the 72h window.
//
// DEFAULT = DRY RUN (rolled back). Pass --apply to commit.
//   npx tsx scripts/drain-texthub-inbox.ts            # dry run
//   npx tsx scripts/drain-texthub-inbox.ts --apply    # commit
//   npx tsx scripts/drain-texthub-inbox.ts --provider=2   # limit to one provider id

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { sql as dsql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { isOptOutKeyword } from "@/lib/sends/opt-out-keywords";
import {
  OPT_OUT_ATTRIBUTION_WINDOW_HOURS,
  parseProviderReceivedAt,
  selectPollableCredentials,
} from "@/lib/sends/poll-opt-outs";
import { buildInboxUrl } from "@/lib/sends/texthub-inbox";
import { refreshReportRollup } from "@/lib/reporting/rollup";
import { recomputeStageTotalCost } from "@/lib/stages/total-cost";

function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const p = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return p ? p.split("=").slice(1).join("=") : undefined;
}

// NANP 10/11-digit -> E.164 +1XXXXXXXXXX, matching the poller's libphonenumber
// output for these inputs (libphonenumber can't load under tsx; TextHub inbox
// phones are already E.164 so this is a faithful equivalent — the phone-equality
// join to stage_sends is the correctness check).
function normalizePhone(raw: string): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

interface InboxMsg {
  id: string;
  message: string;
  phone: string;
  received_at: string | null;
}

// Walk every page of one credential's inbox (newest-first). Safety cap at 60
// pages (~12k msgs) so a runaway total_pages can't loop forever.
async function fetchAllPages(apiKey: string): Promise<InboxMsg[]> {
  const out: InboxMsg[] = [];
  const base = buildInboxUrl(apiKey); // already has ?api_key=&inbox=true
  let page = 1;
  let totalPages = 1;
  const MAX_PAGES = 60;
  do {
    const res = await fetch(`${base}&page=${page}`, { method: "GET" });
    const body: { total_pages?: number; data?: unknown } = await res.json();
    totalPages = typeof body.total_pages === "number" ? body.total_pages : 1;
    const data = Array.isArray(body.data) ? body.data : [];
    for (const raw of data) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      if (r.id == null || r.phone == null) continue;
      out.push({
        id: String(r.id),
        message: typeof r.message === "string" ? r.message : "",
        phone: String(r.phone),
        received_at: r.received_at != null ? String(r.received_at) : null,
      });
    }
    page++;
  } while (page <= totalPages && page <= MAX_PAGES);
  return out;
}

interface StagedRow {
  provider_message_id: string;
  phone: string | null;
  is_stop: boolean;
  anchor_iso: string; // UTC
  raw_body: string;
}

type Exec = { execute: (q: SQL) => Promise<unknown> };

interface CredResult {
  credential_id: number;
  provider_id: number;
  fetched: number;
  newly_claimed: number;
  suppressed: number;
  attributed: number;
  unattributed: number;
  ignored: number;
  invalid_phone: number;
  affectedStages: number[];
}

async function drainCredential(
  tx: Exec,
  cred: { credential_id: number; org_id: string; provider_id: number },
  msgs: InboxMsg[],
  apply: boolean,
): Promise<CredResult> {
  const rows: StagedRow[] = msgs.map((m) => {
    const is_stop = isOptOutKeyword(m.message);
    const phone = normalizePhone(m.phone);
    const anchor = parseProviderReceivedAt(m.received_at) ?? new Date();
    return {
      provider_message_id: m.id,
      phone,
      is_stop,
      anchor_iso: anchor.toISOString(),
      raw_body: JSON.stringify(m),
    };
  });

  await tx.execute(dsql`
    CREATE TEMP TABLE _inbox (
      provider_message_id text NOT NULL,
      phone text,
      is_stop boolean NOT NULL,
      anchor timestamptz NOT NULL,
      raw_body text
    ) ON COMMIT DROP
  `);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const values = dsql.join(
      slice.map(
        (r) =>
          dsql`(${r.provider_message_id}, ${r.phone}, ${r.is_stop}, ${r.anchor_iso}::timestamptz, ${r.raw_body})`,
      ),
      dsql`, `,
    );
    await tx.execute(dsql`INSERT INTO _inbox (provider_message_id, phone, is_stop, anchor, raw_body) VALUES ${values}`);
  }
  await tx.execute(dsql`ANALYZE _inbox`);

  // Claim every message id exactly as the poller does. ON CONFLICT skips ids the
  // poller (or a prior drain) already ingested. Only newly-claimed rows proceed.
  await tx.execute(dsql`
    CREATE TEMP TABLE _claimed ON COMMIT DROP AS
    WITH ins AS (
      INSERT INTO texthub_inbound_events
        (org_id, credential_id, provider_id, method, raw_body, provider_received_at,
         provider_message_id, result)
      SELECT ${cred.org_id}, ${cred.credential_id}, ${cred.provider_id}, 'drain',
             i.raw_body, i.anchor, i.provider_message_id, 'pending'
      FROM _inbox i
      ON CONFLICT (provider_id, provider_message_id)
        WHERE provider_message_id IS NOT NULL DO NOTHING
      RETURNING id, provider_message_id
    )
    SELECT ins.id AS event_id, i.provider_message_id, i.phone, i.is_stop, i.anchor
    FROM ins JOIN _inbox i USING (provider_message_id)
  `);

  const claimedCount = ((await tx.execute(dsql`SELECT count(*)::int AS n FROM _claimed`)) as unknown as { n: number }[])[0].n;

  // Upsert contacts for newly-claimed STOPs with a valid phone.
  await tx.execute(dsql`
    INSERT INTO contacts (org_id, phone_number)
    SELECT DISTINCT ${cred.org_id}::uuid, phone FROM _claimed
    WHERE is_stop AND phone IS NOT NULL
    ON CONFLICT (org_id, phone_number) DO UPDATE SET updated_at = now()
  `);

  // Insert org-wide opt_outs (source sms_inbound) for those STOPs — one per
  // claimed message, matching the poller (repeated STOPs => repeated rows).
  // Keep the new ids in a temp table (not a JS array) so downstream joins avoid
  // the `= ANY(tuple)` param pitfall.
  await tx.execute(dsql`
    CREATE TEMP TABLE _new_oo ON COMMIT DROP AS
    WITH ins AS (
      INSERT INTO opt_outs (org_id, contact_id, phone_number, source, created_at)
      SELECT ${cred.org_id}::uuid, c.id, cl.phone, 'sms_inbound', cl.anchor
      FROM _claimed cl
      JOIN contacts c ON c.org_id = ${cred.org_id} AND c.phone_number = cl.phone
      WHERE cl.is_stop AND cl.phone IS NOT NULL
      RETURNING id
    )
    SELECT id FROM ins
  `);
  const suppressed = ((await tx.execute(dsql`SELECT count(*)::int AS n FROM _new_oo`)) as unknown as { n: number }[])[0].n;

  // Attribute each new opt_out to the SINGLE most-recent send in the 72h window
  // (ORDER BY sent_at DESC, stage_id DESC, id DESC — identical to
  // latestSendForAttribution). Scoped to the just-inserted ids via _new_oo.
  await tx.execute(dsql`
    CREATE TEMP TABLE _attr ON COMMIT DROP AS
    WITH ins AS (
      INSERT INTO opt_out_attributions
        (org_id, opt_out_id, stage_send_id, stage_id, campaign_id, created_at)
      SELECT DISTINCT ON (oo.id)
             oo.org_id, oo.id, ss.id, ss.stage_id, ss.campaign_id, oo.created_at
      FROM opt_outs oo
      JOIN _new_oo n ON n.id = oo.id
      JOIN stage_sends ss
        ON ss.org_id = oo.org_id
       AND ss.phone = oo.phone_number
       AND ss.status = 'sent'
       AND ss.sent_at IS NOT NULL
       AND ss.sent_at >= oo.created_at - (${OPT_OUT_ATTRIBUTION_WINDOW_HOURS} * interval '1 hour')
       AND ss.sent_at <= oo.created_at + interval '5 minutes'
      ORDER BY oo.id, ss.sent_at DESC, ss.stage_id DESC, ss.id DESC
      ON CONFLICT (opt_out_id, stage_id) DO NOTHING
      RETURNING stage_id
    )
    SELECT stage_id FROM ins
  `);
  const attributedCount = ((await tx.execute(dsql`SELECT count(*)::int AS n FROM _attr`)) as unknown as { n: number }[])[0].n;
  const affectedStages = (
    (await tx.execute(dsql`SELECT DISTINCT stage_id FROM _attr`)) as unknown as { stage_id: number }[]
  ).map((r) => r.stage_id);

  // Mark event results (suppressed / ignored / invalid_phone) for claimed rows.
  await tx.execute(dsql`
    UPDATE texthub_inbound_events e
    SET result = CASE
        WHEN cl.is_stop AND cl.phone IS NOT NULL THEN 'suppressed'
        WHEN cl.is_stop AND cl.phone IS NULL THEN 'invalid_phone'
        ELSE 'ignored' END,
        processed_at = now()
    FROM _claimed cl
    WHERE e.id = cl.event_id
  `);

  // Recompute per-stage counters from the FULL junction (idempotent), mirror
  // opt_out_count upward — same as backfill-optout-attributions.ts. Uses _attr
  // (temp table join) rather than a JS array.
  if (affectedStages.length > 0) {
    await tx.execute(dsql`
      UPDATE campaign_stages cs
      SET inbound_opt_out_count = agg.n
      FROM (
        SELECT cs2.id AS stage_id, count(oa.id)::int AS n
        FROM campaign_stages cs2
        LEFT JOIN opt_out_attributions oa ON oa.stage_id = cs2.id
        WHERE cs2.id IN (SELECT DISTINCT stage_id FROM _attr)
        GROUP BY cs2.id
      ) agg
      WHERE cs.id = agg.stage_id AND cs.inbound_opt_out_count <> agg.n
    `);
    await tx.execute(dsql`
      UPDATE campaign_stages cs
      SET opt_out_count = cs.inbound_opt_out_count
      WHERE cs.id IN (SELECT DISTINCT stage_id FROM _attr)
        AND cs.inbound_opt_out_count > cs.opt_out_count
    `);
    for (const stageId of affectedStages) {
      await recomputeStageTotalCost(tx as never, stageId);
    }
    await tx.execute(dsql`DROP TABLE IF EXISTS _attr`);
    await tx.execute(dsql`DROP TABLE IF EXISTS _new_oo`);
  } else {
    await tx.execute(dsql`DROP TABLE IF EXISTS _attr`);
    await tx.execute(dsql`DROP TABLE IF EXISTS _new_oo`);
  }

  const attributed = { length: attributedCount } as { length: number };
  const invalid = ((await tx.execute(
    dsql`SELECT count(*)::int AS n FROM _claimed WHERE is_stop AND phone IS NULL`,
  )) as unknown as { n: number }[])[0].n;
  const ignored = ((await tx.execute(
    dsql`SELECT count(*)::int AS n FROM _claimed WHERE NOT is_stop`,
  )) as unknown as { n: number }[])[0].n;

  // Drop temp tables so the next credential in the same connection can recreate.
  await tx.execute(dsql`DROP TABLE IF EXISTS _claimed`);
  await tx.execute(dsql`DROP TABLE IF EXISTS _inbox`);

  return {
    credential_id: cred.credential_id,
    provider_id: cred.provider_id,
    fetched: msgs.length,
    newly_claimed: claimedCount,
    suppressed,
    attributed: attributed.length,
    unattributed: suppressed - attributed.length,
    ignored,
    invalid_phone: invalid,
    affectedStages,
  };
}

async function main() {
  const apply = flag("apply");
  const onlyProvider = arg("provider") ? Number(arg("provider")) : null;
  const rollupDays = Number(arg("rollup-days") ?? "7");
  console.log(`=== TextHub inbox DRAIN — ${apply ? "APPLY" : "DRY RUN"} ===`);

  const pg = postgres(process.env.DATABASE_URL!, { prepare: false, max: 1 });
  const db = drizzle(pg);
  try {
    let creds = await selectPollableCredentials(db as never);
    if (onlyProvider != null) creds = creds.filter((c) => c.provider_id === onlyProvider);
    console.log(`  credentials: ${creds.map((c) => `${c.credential_id}(p${c.provider_id})`).join(", ")}`);

    // Fetch OUTSIDE the transaction (network), then mutate inside it.
    const fetched: { cred: (typeof creds)[number]; msgs: InboxMsg[] }[] = [];
    for (const cred of creds) {
      const msgs = await fetchAllPages(cred.api_key);
      console.log(`  cred ${cred.credential_id} (p${cred.provider_id}): fetched ${msgs.length} messages across all pages`);
      fetched.push({ cred, msgs });
    }

    const results: CredResult[] = [];
    try {
      await db.transaction(async (tx) => {
        for (const { cred, msgs } of fetched) {
          results.push(await drainCredential(tx as Exec, cred, msgs, apply));
        }
        if (!apply) throw new Error("__dry_run_rollback__");
      });
    } catch (e) {
      if (!(e instanceof Error) || e.message !== "__dry_run_rollback__") throw e;
    }

    console.log(`\n  ${apply ? "WROTE" : "WOULD WRITE"}:`);
    for (const r of results) {
      console.log(
        `    cred ${r.credential_id} (p${r.provider_id}): fetched=${r.fetched} newly_claimed=${r.newly_claimed} ` +
          `suppressed=${r.suppressed} (attributed=${r.attributed}, unattributed=${r.unattributed}) ` +
          `ignored=${r.ignored} invalid_phone=${r.invalid_phone} stages=${r.affectedStages.length}`,
      );
    }

    if (apply) {
      const affected = [...new Set(results.flatMap((r) => r.affectedStages))];
      if (affected.length > 0) {
        console.log(`\n  Refreshing reports rollup (recomputeSinceDays=${rollupDays}) ...`);
        const roll = await refreshReportRollup(db as never, { recomputeSinceDays: rollupDays });
        console.log(`  rollup: ${JSON.stringify(roll)}`);
      }
      console.log(`\n  DONE. Re-run without --apply to confirm newly_claimed=0 (idempotency).`);
    } else {
      console.log(`\n  Dry run only — nothing written. Re-run with --apply to commit.`);
    }
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Drain crashed:", err);
  process.exit(1);
});
