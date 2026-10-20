// scripts/export-t1-corpus.ts — READ-ONLY export of recently SENT bodies plus
// the inputs that rebuild them, for scripts/verify-t1-format-identity.ts
// (P1 of docs/superpowers/plans/2026-10-19-message-personalization-formats.md).
//
// ⚠️ Runs against whatever DATABASE_URL .env.local holds — production. It is
// SELECT-only inside a READ ONLY transaction, so Postgres itself refuses any
// write. Window = the last N days of sent rows (default 3): a windowed read,
// not full history (stage_sends is ~2 GB).
//
//   npx tsx scripts/export-t1-corpus.ts <out.json> [days] [sinceIso]
// `sinceIso` keeps only rows CREATED (rendered) at/after that instant — the
// post-deploy smoke: a regular row is rendered at Prepare, so "sent after the
// deploy" alone could still be a pre-deploy body.
import "./_env-preload";
import { writeFileSync } from "node:fs";
import postgres from "postgres";

const out = process.argv[2];
const days = Number(process.argv[3] ?? 3);
const since = process.argv[4] ? new Date(process.argv[4]) : null;
if (since && Number.isNaN(+since)) {
  console.error("sinceIso must be an ISO timestamp");
  process.exit(2);
}
if (!out || !Number.isFinite(days) || days <= 0) {
  console.error("usage: npx tsx scripts/export-t1-corpus.ts <out.json> [days]");
  process.exit(2);
}

const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

async function main() {
  const t0 = Date.now();
  const result = await client.begin("read only", async (tx) => {
    await tx`SET LOCAL statement_timeout = '120s'`;
    // One row per sent message. Inputs are the ones the senders read:
    //   brand        campaigns.brand_id → brands.name (current)
    //   creative     links.creative_id (the creative AT MINT) — else the stage's
    //   link         https://<domain>/r/<code> for tracked rows, else stage.short_url
    //   footer       number > provider > stage (resolveOptOutFooter); provider is
    //                the stage's for regular, the number's account for drip.
    const rows = await tx`
      SELECT ss.stage_id,
             c.type                         AS campaign_type,
             c.link_mode,
             b.name                         AS brand_name,
             COALESCE(lcr.text, scr.text)   AS creative_text,
             CASE WHEN l.id IS NOT NULL THEN 'https://' || sd.domain || '/r/' || l.code
                  ELSE s.short_url END      AS link_url,
             s.stop_text,
             pp.opt_out_footer              AS phone_footer,
             CASE WHEN c.type = 'drip' THEN dprov.opt_out_footer ELSE sprov.opt_out_footer END AS provider_footer,
             CASE WHEN c.type = 'drip' THEN dprov.adapter_code  ELSE sprov.adapter_code  END AS adapter_code,
             ss.sent_at,
             ss.created_at,
             ss.message_format_id,
             ss.format_custom,
             ss.rendered_text
      FROM stage_sends ss
      JOIN campaigns c        ON c.id = ss.campaign_id
      JOIN campaign_stages s  ON s.id = ss.stage_id
      LEFT JOIN brands b      ON b.id = c.brand_id
      LEFT JOIN links l       ON l.id = ss.link_id
      LEFT JOIN short_domains sd ON sd.id = l.short_domain_id
      LEFT JOIN creatives lcr ON lcr.id = l.creative_id
      LEFT JOIN creatives scr ON scr.id = s.creative_id
      LEFT JOIN provider_phones pp ON pp.id = ss.provider_phone_id
      LEFT JOIN sms_providers sprov ON sprov.id = s.sms_provider_id
      LEFT JOIN sms_providers dprov ON dprov.id = pp.provider_id
      WHERE ss.status = 'sent'
        AND ss.sent_at >= now() - make_interval(days => ${days})
        AND (${since ? since.toISOString() : null}::timestamptz IS NULL OR ss.created_at >= ${since ? since.toISOString() : null}::timestamptz)
      ORDER BY ss.sent_at
    `;
    return rows;
  });
  writeFileSync(out, JSON.stringify({ exported_at: new Date().toISOString(), days, since: since?.toISOString() ?? null, rows: result }));
  console.log(`exported ${result.length.toLocaleString()} sent rows (last ${days}d) to ${out} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => client.end());
