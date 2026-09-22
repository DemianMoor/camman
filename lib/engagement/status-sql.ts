import { sql, type SQL } from "drizzle-orm";

// =============================================================================
// THE lifecycle rules (spec §3.2) as SQL. The job (lib/engagement/refresh.ts),
// the settings preview (PR 2) and scripts/test-engagement-db.ts all evaluate
// status through evaluationSelectSql — a threshold comparison is never retyped
// anywhere else.
//
// Rules, first match wins:
//   1 hot         last_click_at >= asOf - hot_days
//   2 warm        last_click_at >= asOf - warm_days
//   3 new         msgs_total = 0
//   4 suppressed  previous status suppressed (sticky; only rules 1-2 leave it)
//   5 suppressed  previous status freeze AND rule 6 still holds AND the first
//                 in-freeze message is >= suppress_after_days old AND at least
//                 suppress_min_freeze_messages were sent while in freeze
//   6 freeze      msgs_since_click >= freeze_after_messages
//   7 cold        otherwise
//
// THE FREEZE CLOCK. freeze_entered_at is stamped when a contact ENTERS freeze
// (the evaluation instant) and carried while it stays. freeze_started_at and
// freeze_msgs are the first, and the count, of the messages sent AFTER
// freeze_entered_at — which is why a backfilled freeze contact can never be
// suppressed at launch: its clock starts at the backfill instant, so no message
// sent before then counts. Leaving freeze (a click, or a raised threshold)
// clears all three; suppressed keeps them for the record.
//
// NULL-SAFETY. `last_click_at >= …` is NULL for a contact that never clicked, so
// rules 1-2 fall through rather than matching — the same for the freeze-clock
// comparisons in rule 5.
// =============================================================================

const col = (alias: string, name: string): SQL => sql.raw(`${alias}.${name}`);

function statusSql(a: string, asOf: SQL): SQL {
  const c = (n: string) => col(a, n);
  return sql`(CASE
    WHEN ${c("last_click_at")} >= ${asOf} - make_interval(days => ${c("hot_days")}) THEN 'hot'
    WHEN ${c("last_click_at")} >= ${asOf} - make_interval(days => ${c("warm_days")}) THEN 'warm'
    WHEN ${c("msgs_total")} = 0 THEN 'new'
    WHEN ${c("prev_status")} = 'suppressed' THEN 'suppressed'
    WHEN ${c("msgs_since_click")} >= ${c("freeze_after_messages")}
     AND ${c("prev_status")} = 'freeze'
     AND ${c("calc_freeze_started_at")} <= ${asOf} - make_interval(days => ${c("suppress_after_days")})
     AND ${c("calc_freeze_msgs")} >= ${c("suppress_min_freeze_messages")} THEN 'suppressed'
    WHEN ${c("msgs_since_click")} >= ${c("freeze_after_messages")} THEN 'freeze'
    ELSE 'cold'
  END)`;
}

function freezeClockSql(a: string, asOf: SQL): { entered: SQL; started: SQL; msgs: SQL } {
  const c = (n: string) => col(a, n);
  const inFreeze = sql`${c("next_status")} IN ('freeze', 'suppressed')`;
  const wasInFreeze = sql`${c("prev_status")} IN ('freeze', 'suppressed')`;
  return {
    entered: sql`(CASE WHEN ${inFreeze} THEN
                    CASE WHEN ${wasInFreeze} THEN coalesce(${c("prev_freeze_entered_at")}, ${asOf}) ELSE ${asOf} END
                  END)`,
    started: sql`(CASE WHEN ${inFreeze} AND ${wasInFreeze} THEN ${c("calc_freeze_started_at")} END)`,
    msgs: sql`(CASE WHEN ${inFreeze} AND ${wasInFreeze} THEN ${c("calc_freeze_msgs")} ELSE 0 END)`,
  };
}

function reasonSql(a: string, initialReason: "backfill" | "first_seen"): SQL {
  const prev = col(a, "prev_status");
  const next = col(a, "next_status");
  return sql`(CASE
    WHEN ${prev} IS NULL THEN ${initialReason}::text
    WHEN ${next} = 'hot' THEN 'human_click'
    WHEN ${next} = 'warm' AND ${prev} = 'hot' THEN 'click_aged_warm'
    WHEN ${next} = 'warm' THEN 'human_click'
    WHEN ${prev} IN ('hot', 'warm') THEN 'click_aged_cold'
    WHEN ${prev} = 'new' THEN 'first_message'
    WHEN ${next} = 'suppressed' THEN 'freeze_expired'
    WHEN ${next} = 'freeze' THEN 'freeze_threshold'
    WHEN ${prev} = 'freeze' AND ${next} = 'cold' THEN 'threshold_change'
    ELSE 'recount'
  END)`;
}

/**
 * Earliest instant at which this row's status changes with NO new send and NO
 * new click. The incremental run re-evaluates rows whose instant has passed, so
 * hot → warm, warm → cold and freeze → suppressed happen on time without
 * recounting anybody. NULL means only an event can move this contact.
 */
function timeDueSql(a: string): SQL {
  const c = (n: string) => col(a, n);
  return sql`(CASE ${c("next_status")}
    WHEN 'hot' THEN ${c("last_click_at")} + make_interval(days => ${c("hot_days")})
    WHEN 'warm' THEN ${c("last_click_at")} + make_interval(days => ${c("warm_days")})
    WHEN 'freeze' THEN CASE
      WHEN ${c("freeze_started_at")} IS NOT NULL AND ${c("freeze_msgs")} >= ${c("suppress_min_freeze_messages")}
      THEN ${c("freeze_started_at")} + make_interval(days => ${c("suppress_after_days")})
    END
  END)`;
}

/** The contact_engagement columns the job compares to decide whether a row changed. */
export const ENGAGEMENT_VALUE_COLUMNS = [
  "status",
  "msgs_total",
  "msgs_since_click",
  "msgs_7d",
  "msgs_14d",
  "msgs_30d",
  "msgs_90d",
  "first_sent_at",
  "last_sent_at",
  "first_click_at",
  "last_click_at",
  "freeze_entered_at",
  "freeze_started_at",
  "freeze_msgs",
  "freeze_cadence_days",
  "thresholds",
  "time_due_at",
] as const;

/**
 * The whole evaluation as ONE SELECT over `input` — a parenthesised relation
 * exposing: contact_id, prev_status, prev_status_changed_at,
 * prev_freeze_entered_at, msgs_total, msgs_since_click, msgs_7d, msgs_14d,
 * msgs_30d, msgs_90d, first_sent_at, last_sent_at, first_click_at,
 * last_click_at, calc_freeze_started_at, calc_freeze_msgs, hot_days, warm_days,
 * freeze_after_messages, freeze_cadence_days, suppress_after_days,
 * suppress_min_freeze_messages, override_group_ids.
 *
 * `asOf` is the evaluation instant: the job passes the transaction's now(), and
 * the tests pass a fixed timestamp so every boundary is exact.
 * `initialReason` is the transition reason recorded for a contact that has no
 * row yet ("backfill" for the one-off backfill, "first_seen" afterwards).
 */
export function evaluationSelectSql(
  input: SQL,
  asOf: SQL,
  initialReason: "backfill" | "first_seen",
): SQL {
  const clock = freezeClockSql("s", asOf);
  return sql`
    SELECT k.contact_id, k.prev_status, k.prev_status_changed_at, k.reason,
           k.next_status AS status,
           k.msgs_total, k.msgs_since_click, k.msgs_7d, k.msgs_14d, k.msgs_30d, k.msgs_90d,
           k.first_sent_at, k.last_sent_at, k.first_click_at, k.last_click_at,
           k.freeze_entered_at, k.freeze_started_at, k.freeze_msgs,
           k.freeze_cadence_days::smallint AS freeze_cadence_days, k.thresholds,
           ${timeDueSql("k")} AS time_due_at
    FROM (
      SELECT s.*,
             ${clock.entered} AS freeze_entered_at,
             ${clock.started} AS freeze_started_at,
             ${clock.msgs} AS freeze_msgs,
             ${reasonSql("s", initialReason)} AS reason,
             jsonb_build_object(
               'hot_days', s.hot_days,
               'warm_days', s.warm_days,
               'freeze_after_messages', s.freeze_after_messages,
               'freeze_cadence_days', s.freeze_cadence_days,
               'suppress_after_days', s.suppress_after_days,
               'suppress_min_freeze_messages', s.suppress_min_freeze_messages,
               'override_group_ids', to_jsonb(s.override_group_ids)
             ) AS thresholds
      FROM (SELECT e.*, ${statusSql("e", asOf)} AS next_status FROM ${input} e) s
    ) k`;
}
