import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
import { propagateTrackedClickers } from "@/lib/links/propagate-clickers";
import { scoreClicks, type ScoreMode } from "@/lib/links/score-clicks";

// Cron-triggered click scoring. Vercel Cron hits this on a schedule (see
// vercel.json) with `Authorization: Bearer <CRON_SECRET>`. Also callable
// manually with the same header (e.g. to kick a re-score after retuning).
//
// Modes:
//   default            — score pending rows (scored_at IS NULL)
//   ?mode=rescore      — re-score ALL rows (after weight changes; idempotent)
//   ?maxRows=N         — cap rows processed this invocation (default 2000)
//
// Node runtime (default) — needs fs/zlib for the MaxMind reader. The redirect
// lambda is deliberately untouched; the .mmdb lives only here.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET is not configured" },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;
  const mode: ScoreMode = sp.get("mode") === "rescore" ? "rescore" : "pending";
  const maxRowsRaw = Number(sp.get("maxRows"));
  const maxRows =
    Number.isFinite(maxRowsRaw) && maxRowsRaw > 0
      ? Math.min(20000, Math.floor(maxRowsRaw))
      : undefined;

  const result = await scoreClicks(db, { mode, maxRows });

  // After scoring, materialize freshly-scored clean (human) clicks into the
  // `clickers` engagement table so segment clicker rules see tracked clickers.
  // Idempotent + best-effort: a failure here must not fail the scoring run.
  let clickersInserted = 0;
  try {
    clickersInserted = (await propagateTrackedClickers(db)).inserted;
  } catch (err) {
    console.error("score-pending: propagateTrackedClickers failed", err);
  }

  // Surface enrichment health explicitly so a degraded run (e.g. MaxMind 429 /
  // missing key) is impossible to miss in the cron response — not just buried
  // in logs. `degraded: true` means NO rows were scored; they were left pending
  // (scored_at NULL) to be re-scored by a later healthy run.
  return NextResponse.json({
    mode,
    scored: result.scored,
    byClassification: result.byClassification,
    capped: result.capped,
    degraded: result.degraded,
    enrichment: result.enrichment,
    clickersInserted,
  });
}
