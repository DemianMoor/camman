import { sql as drizzleSql } from "drizzle-orm";

import { campaign_stages } from "@/db/schema";

// Shared dashboard rollup predicates for campaign_stages.
//
// History: the dashboard used to gate every rollup on `sent_at IS NOT NULL`.
// But neither way of recording results sets sent_at — manual entry
// (manual-results route) and CSV import (import route) only write the
// aggregate counters, and operators routinely mark a stage `success`/`failed`
// directly without walking it through the `sent` status (which is the only
// transition that stamps sent_at). The result: most real result data was
// invisible on the dashboard. We now include any stage that carries recorded
// results, regardless of how it got there. See the dashboard route files.

// A stage "has results" when any result counter or cost has been recorded.
export const stageHasResults = drizzleSql`(
  ${campaign_stages.sms_count} > 0
  or ${campaign_stages.delivered_count} > 0
  or ${campaign_stages.opt_out_count} > 0
  or ${campaign_stages.click_count} > 0
  or ${campaign_stages.late_click_count} > 0
  or ${campaign_stages.scrubbed_count} > 0
  or ${campaign_stages.bounced_count} > 0
  or ${campaign_stages.sales_count} > 0
  or ${campaign_stages.total_cost} > 0
)`;

// Effective report date used for range filtering + daily bucketing. Prefer the
// scheduled or actual send time; fall back to the last status change (e.g. the
// moment the stage was marked `success` after an import) and finally creation,
// so a stage that was never walked through `sent` still lands on a sensible day.
export const stageEffectiveDate = drizzleSql`coalesce(
  ${campaign_stages.scheduled_at},
  ${campaign_stages.sent_at},
  ${campaign_stages.status_changed_at},
  ${campaign_stages.created_at}
)`;

// Archived stages are excluded from dashboard rollups.
export const stageNotArchived = drizzleSql`${campaign_stages.archived_at} is null`;
