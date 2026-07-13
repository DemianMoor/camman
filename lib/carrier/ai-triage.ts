import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";

import { db } from "@/db/client";
import { notifyTelegram } from "@/lib/alerts/telegram";

import { CARRIER_BUCKETS } from "../telnyx/map-carrier";
import { loadLookupSettings } from "../telnyx/settings";
import type { CarrierNorm } from "../telnyx/types";
import { applyCarrierMappings, type CarrierMappingWrite } from "./apply-mapping";
import { contactCountsByMatchKey } from "./queue-stats";
import type { CarrierBucket } from "../telnyx/assign-mapping";

// Async AI triage (brief §8). Drains carrier_classify_queue: batches distinct
// unresolved carrier strings to a fast Claude model, writes confident answers into
// carrier_mappings (so the resolver's exact-mapping step catches them forever after
// — one API call per distinct string, ever), and leaves the rest for human review.
// Runs under withCronLease (single-runner) from /api/cron/carrier-triage.

const MODEL = "claude-haiku-4-5"; // fast, low-cost; $1/$5 per 1M tokens
const BATCH_SIZE = 50; // distinct strings per API call (brief §8)
const HIGH_THRESHOLD = 0.85; // auto-accept confidence (brief §13.2)
const MAX_AI_ATTEMPTS = 3; // bounded retry before a string is parked for humans
const HIGH_VOLUME_CONTACTS = 250; // unresolved-string alert threshold (brief §13.3)

// The buckets the model may return. Kept identical to the live enum (decision:
// keep the existing six). 'Unmapped'/'Unidentified' are NOT valid answers.
const AI_BUCKETS = CARRIER_BUCKETS as readonly CarrierNorm[];

const SYSTEM_PROMPT = `You classify US phone-carrier names into a fixed set of buckets for an SMS system.

Buckets (return EXACTLY one of these strings):
- "AT&T"          — AT&T and its subsidiaries (Cingular, Pacific Bell, BellSouth, Ameritech, Southwestern Bell...)
- "T-Mobile"      — T-Mobile and its subsidiaries/legacy (MetroPCS, Omnipoint, Powertel, VoiceStream, SunCom, Sprint)
- "Verizon"       — Verizon and its subsidiaries (Cellco, Bell Atlantic Mobile, GTE, MCImetro)
- "Other Mobile"  — any OTHER mobile carrier or MVNO with a recognizable US mobile network (US Cellular, Cricket, Boost, Mint, TracFone/Straight Talk, regional carriers...)
- "VoIP"          — VoIP / CLEC / wholesale voice providers (Bandwidth, Twilio, Sinch, Level 3, Onvoy, Peerless, Inteliquent, Vonage, CenturyLink, cable IP-phone...)
- "Unknown"       — the name is a landline ILEC, is unrecognizable, or names no identifiable parent mobile network. Return "Unknown" rather than guessing.

Rules:
- Use world knowledge to resolve opaque legal-entity names to their parent network (e.g. "OMNIPOINT COMMUNICATIONS, INC." -> "T-Mobile", "CELLCO PARTNERSHIP" -> "Verizon").
- If a string names no recognizable parent network (a truly anonymous MVNO, or a landline company), return "Unknown". Do NOT guess.
- confidence is your 0.0–1.0 certainty in the bucket.`;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          match_key: { type: "string" },
          brand: { type: "string", enum: [...AI_BUCKETS] },
          confidence: { type: "number" },
        },
        required: ["match_key", "brand", "confidence"],
      },
    },
  },
  required: ["results"],
} as const;

type QueueRow = {
  match_key: string;
  raw_example: string;
};

interface AiVerdict {
  brand: string;
  confidence: number;
}

export interface TriageSummary {
  newlyMapped: number;
  needHuman: number;
  apiCalls: number;
  stoppedReason?: string;
}

function isBucket(b: string): b is CarrierBucket {
  return (AI_BUCKETS as readonly string[]).includes(b);
}

export async function runCarrierTriage(): Promise<TriageSummary> {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Not an incident — the feature just isn't configured yet.
    return { newlyMapped: 0, needHuman: 0, apiCalls: 0, stoppedReason: "no_api_key" };
  }

  const settings = await loadLookupSettings();
  const runCap = settings.carrier_ai_run_cap;
  const client = new Anthropic();

  let apiCalls = 0;
  let newlyMapped = 0;
  let needHuman = 0;

  while (true) {
    if (apiCalls >= runCap) {
      await notifyTelegram(
        `🛑 Carrier triage cost breaker: reached ${runCap} API calls this run. Stopping; remaining strings stay pending.`,
      );
      return { newlyMapped, needHuman, apiCalls, stoppedReason: "cost_cap" };
    }

    const batch = await claimBatch(BATCH_SIZE);
    if (batch.length === 0) break;

    let verdicts: Map<string, AiVerdict>;
    try {
      verdicts = await classifyBatch(client, batch);
      apiCalls++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await bumpAttempts(batch.map((b) => b.match_key), msg);
      if (err instanceof Anthropic.RateLimitError) {
        await notifyTelegram(
          `⚠️ Carrier triage rate-limited beyond backoff (${msg}). Paused for this run; ${batch.length} strings still pending.`,
        );
        return { newlyMapped, needHuman, apiCalls, stoppedReason: "rate_limit" };
      }
      await notifyTelegram(
        `⚠️ Carrier auto-classify failed: ${msg}. ${batch.length} strings pending. Sends continue under the Unmapped policy.`,
      );
      return { newlyMapped, needHuman, apiCalls, stoppedReason: "api_error" };
    }

    const writes: CarrierMappingWrite[] = [];
    const aiResolved: { matchKey: string; confidence: number }[] = [];
    const parkHuman: { matchKey: string; confidence: number | null; error?: string }[] = [];

    for (const row of batch) {
      const v = verdicts.get(row.match_key);
      if (!v) {
        parkHuman.push({ matchKey: row.match_key, confidence: null, error: "no_verdict" });
        continue;
      }
      if (!isBucket(v.brand)) {
        // Junk never gets written to carrier_mappings (brief §9.2).
        await notifyTelegram(
          `⚠️ Carrier triage: model returned out-of-enum brand "${v.brand.slice(0, 40)}" for "${row.raw_example.slice(0, 60)}". Rejected + requeued for human.`,
        );
        parkHuman.push({ matchKey: row.match_key, confidence: v.confidence, error: `out_of_enum:${v.brand.slice(0, 40)}` });
        continue;
      }
      if (v.brand !== "Unknown" && v.confidence >= HIGH_THRESHOLD) {
        writes.push({ matchKey: row.match_key, rawExample: row.raw_example, bucket: v.brand, mappedBy: "ai" });
        aiResolved.push({ matchKey: row.match_key, confidence: v.confidence });
      } else {
        parkHuman.push({ matchKey: row.match_key, confidence: v.confidence });
      }
    }

    if (writes.length > 0) await applyCarrierMappings(writes);
    if (aiResolved.length > 0) await markResolved(aiResolved);
    if (parkHuman.length > 0) await markNeedsHuman(parkHuman);

    newlyMapped += writes.length;
    needHuman += parkHuman.length;
  }

  await alertHighVolumeUnresolved();

  return { newlyMapped, needHuman, apiCalls };
}

// Oldest-first pending rows still under the attempt cap. Single-runner (withCronLease)
// so no row-level lock is needed.
async function claimBatch(size: number): Promise<QueueRow[]> {
  const rows = await db.execute<QueueRow>(sql`
    SELECT match_key, raw_example FROM carrier_classify_queue
    WHERE status = 'pending' AND attempts < ${MAX_AI_ATTEMPTS}
    ORDER BY created_at
    LIMIT ${size}`);
  return rows.map((r) => ({ match_key: r.match_key, raw_example: r.raw_example }));
}

async function classifyBatch(
  client: Anthropic,
  batch: QueueRow[],
): Promise<Map<string, AiVerdict>> {
  const list = batch
    .map((b) => `${b.match_key}\t${b.raw_example}`)
    .join("\n");
  const userText =
    `Classify each carrier string below. Each line is: match_key<TAB>carrier_name.\n` +
    `Return one result per match_key.\n\n${list}`;

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    messages: [{ role: "user", content: userText }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const parsed = JSON.parse(text) as {
    results?: (AiVerdict & { match_key: string })[];
  };
  const out = new Map<string, AiVerdict>();
  for (const r of parsed.results ?? []) {
    if (r && typeof r.match_key === "string") {
      out.set(r.match_key, { brand: String(r.brand), confidence: Number(r.confidence) });
    }
  }
  return out;
}

async function markResolved(rows: { matchKey: string; confidence: number }[]): Promise<void> {
  for (const r of rows) {
    await db.execute(sql`
      UPDATE carrier_classify_queue
      SET status = 'ai_resolved', confidence = ${r.confidence}, attempts = attempts + 1,
          last_error = NULL, updated_at = now()
      WHERE match_key = ${r.matchKey}`);
  }
}

async function markNeedsHuman(
  rows: { matchKey: string; confidence: number | null; error?: string }[],
): Promise<void> {
  for (const r of rows) {
    await db.execute(sql`
      UPDATE carrier_classify_queue
      SET status = 'needs_human', confidence = ${r.confidence}, attempts = attempts + 1,
          last_error = ${r.error ?? null}, updated_at = now()
      WHERE match_key = ${r.matchKey}`);
  }
}

// A transport/API failure isn't a classification verdict: keep the rows pending but
// count the attempt so a persistently-failing string eventually parks itself.
async function bumpAttempts(matchKeys: string[], error: string): Promise<void> {
  for (const k of matchKeys) {
    await db.execute(sql`
      UPDATE carrier_classify_queue
      SET attempts = attempts + 1, last_error = ${error.slice(0, 500)}, updated_at = now()
      WHERE match_key = ${k}`);
  }
}

// Brief §9.3: any still-unresolved string affecting >= threshold contacts is a
// high-impact gap that shouldn't hide. contact_count is derived on read (by key).
async function alertHighVolumeUnresolved(): Promise<void> {
  const counts = await contactCountsByMatchKey();
  const unresolved = await db.execute<{ match_key: string; raw_example: string }>(sql`
    SELECT match_key, raw_example FROM carrier_classify_queue
    WHERE status IN ('pending', 'needs_human')`);

  const hot = unresolved
    .map((r) => ({ raw: r.raw_example, count: counts.get(r.match_key) ?? 0 }))
    .filter((r) => r.count >= HIGH_VOLUME_CONTACTS)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  if (hot.length === 0) return;

  const lines = hot.map((r) => `• ${r.raw.slice(0, 50)} — ${r.count} contacts`).join("\n");
  await notifyTelegram(
    `⚠️ Carrier triage: ${hot.length} unresolved carrier string(s) each affect ≥${HIGH_VOLUME_CONTACTS} contacts:\n${lines}`,
  );
}
