import { sql as drizzleSql } from "drizzle-orm";

import {
  campaign_stages,
  keitaro_stage_results,
  stage_sends,
} from "@/db/schema";

// Read-time derivation of a stage's "true" send / delivered / sales numbers.
//
// WHY THIS EXISTS: campaign_stages.sms_count / delivered_count / sales_count are
// NOT authoritative on their own. They are the MANUAL/CSV entry store — operators
// hand-enter them via the manual-results form, and CSV import adds to them. But
// API/tracked stages send through the per-recipient `stage_sends` table (one row
// per recipient, status='sent' when dispatched) and leave those columns at 0;
// likewise real sales land in `keitaro_stage_results`, not sales_count (the
// Keitaro poll deliberately never touches sales_count — see lib/keitaro/poll.ts).
//
// So the value shown on ANY screen or report is the COMBINATION of the manual
// column and the live source-table count, taken as the larger of the two
// (GREATEST / Math.max). This dedupes the overlap when a stage is both tracked
// and manually tallied, while surfacing whichever source saw more. It mirrors the
// two combine rules already in the codebase: combineSales() in lib/stage-results
// and the GREATEST(sms_count, sent) inside lib/stages/total-cost.
//
// There is NO delivery feedback (no DLR polling — see CLAUDE.md §12), so for
// tracked stages the count of status='sent' rows is the best proxy for both
// "sent" and "delivered".
//
// These fragments correlate on campaign_stages.id, so any query using them MUST
// have campaign_stages in its FROM/scope.

// Live count of per-recipient messages actually dispatched for the stage
// (stage_sends.status='sent'). Also the delivered proxy (no DLR).
export const stageSentCountSql = drizzleSql<number>`(
  SELECT count(*) FROM ${stage_sends} ss
   WHERE ss.stage_id = ${campaign_stages.id} AND ss.status = 'sent'
)::int`;

// Keitaro conversions attributed to the stage, summed across stat_dates.
// (Keitaro's `sales` metric = leads + sales for this account — see schema.)
export const stageKeitaroSalesSql = drizzleSql<number>`COALESCE((
  SELECT sum(ksr.sales) FROM ${keitaro_stage_results} ksr
   WHERE ksr.stage_id = ${campaign_stages.id}
), 0)::int`;

// Displayed SMS sent = max(manual tally, real dispatched rows).
export const effectiveSmsCountSql = drizzleSql<number>`GREATEST(${campaign_stages.sms_count}, ${stageSentCountSql})`;

// Displayed delivered = max(manual tally, dispatched rows). No DLR ⇒ delivered
// proxies to sent.
export const effectiveDeliveredCountSql = drizzleSql<number>`GREATEST(${campaign_stages.delivered_count}, ${stageSentCountSql})`;

// Displayed sales = max(manual tally, Keitaro conversions). Mirrors combineSales.
export const effectiveSalesCountSql = drizzleSql<number>`GREATEST(${campaign_stages.sales_count}, ${stageKeitaroSalesSql})`;

// "This stage has dispatched messages" — used to widen stageHasResults so
// tracked stages (sms_count = 0) are no longer invisible on the dashboard.
export const stageHasSentRowsSql = drizzleSql`EXISTS (
  SELECT 1 FROM ${stage_sends} ss
   WHERE ss.stage_id = ${campaign_stages.id} AND ss.status = 'sent'
)`;

// "This stage has Keitaro results" — same purpose for sales/click data that only
// lives in keitaro_stage_results.
export const stageHasKeitaroResultsSql = drizzleSql`EXISTS (
  SELECT 1 FROM ${keitaro_stage_results} ksr
   WHERE ksr.stage_id = ${campaign_stages.id}
)`;
