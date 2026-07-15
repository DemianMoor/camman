import { NextResponse, type NextRequest } from "next/server";

import { db } from "@/db/client";
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
// Pin to Frankfurt (eu-central-1), co-located with Supabase, so the thousands
// of sequential DB round-trips this job makes don't cross the Atlantic (~90ms
// each). Per-route only — do NOT set a global region; US-facing routes such as
// the /r/[code] redirect must stay in the US region.
export const preferredRegion = "fra1";

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

  // Clicker propagation (clicks → `clickers`) moved to its own cron in W1.1
  // (/api/cron/propagate-clickers) so a heavy scoring run here can no longer
  // starve it of this function's 60s budget. This route now does scoring only.

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
  });
}
