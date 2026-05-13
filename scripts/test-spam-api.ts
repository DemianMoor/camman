import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { spam_scores } from "../db/schema";
import { hashText, normalizeText } from "../lib/spam/normalize";
import { deriveLabel, deriveVerdict } from "../lib/spam/types";

// lib/spam/score.ts can't be imported directly here — it pulls in
// "server-only" which throws outside Next.js's Server Components context.
// Cache + failure behaviors are verified through the API instead.

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const dbUrl = process.env.DATABASE_URL!;
  const testEmail = process.env.TEST_USER_EMAIL;
  const testPassword = process.env.TEST_USER_PASSWORD;
  if (!testEmail || !testPassword) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD in .env.local.");
    process.exit(1);
  }

  const cookieJar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () =>
        Array.from(cookieJar.entries()).map(([name, value]) => ({
          name,
          value,
        })),
      setAll: (cookies) => {
        for (const { name, value } of cookies) cookieJar.set(name, value);
      },
    },
  });

  const { error: signInErr } = await supabase.auth.signInWithPassword({
    email: testEmail,
    password: testPassword,
  });
  if (signInErr) {
    console.error(`Sign-in failed: ${signInErr.message}`);
    process.exit(1);
  }

  function cookieHeader() {
    return Array.from(cookieJar.entries())
      .map(([n, v]) => `${n}=${v}`)
      .join("; ");
  }
  async function apiFetch(path: string, init?: RequestInit) {
    return fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
        Cookie: cookieHeader(),
      },
    });
  }

  let passed = 0;
  let failed = 0;
  function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
      failed++;
    }
  }

  const pg = postgres(dbUrl, { prepare: false, max: 1 });
  const db = drizzle(pg);
  const insertedHashes: string[] = [];

  try {
    // ============ [1] normalizeText ============
    console.log("\n[1] normalizeText unit tests");
    check("empty string → empty", normalizeText("") === "");
    check("whitespace-only → empty", normalizeText("   \t \n  ") === "");
    check(
      "multiline with tabs collapses to single space",
      normalizeText("Hello\n\tworld\n  there") === "hello world there",
    );
    check(
      "NFKC normalization (fullwidth → ascii)",
      normalizeText("ＡＢＣ") === "abc",
    );
    check(
      "emoji preserved",
      normalizeText("Hello 🎉  there") === "hello 🎉 there",
    );

    // ============ [2] hashText ============
    console.log("\n[2] hashText unit tests");
    const h1 = hashText("Hello World");
    const h2 = hashText("hello   world");
    const h3 = hashText("HELLO\tworld");
    check("hash is 64 hex chars (SHA-256)", /^[0-9a-f]{64}$/.test(h1));
    check(
      "case + whitespace variants hash identically",
      h1 === h2 && h2 === h3,
      `${h1.slice(0, 8)} vs ${h2.slice(0, 8)} vs ${h3.slice(0, 8)}`,
    );
    check(
      "different content → different hash",
      hashText("foo") !== hashText("bar"),
    );

    // ============ [3] deriveLabel boundaries ============
    console.log("\n[3] deriveLabel boundaries");
    check("score=0 → ham", deriveLabel(0) === "ham");
    check("score=30 → ham (boundary)", deriveLabel(30) === "ham");
    check("score=31 → suspicious (boundary)", deriveLabel(31) === "suspicious");
    check("score=50 → suspicious", deriveLabel(50) === "suspicious");
    check("score=70 → suspicious (boundary)", deriveLabel(70) === "suspicious");
    check("score=71 → spam (boundary)", deriveLabel(71) === "spam");
    check("score=100 → spam", deriveLabel(100) === "spam");

    // ============ [4] deriveVerdict boundaries ============
    console.log("\n[4] deriveVerdict boundaries");
    check("score=0 → not_spam", deriveVerdict(0) === "not_spam");
    check("score=50 → not_spam (boundary)", deriveVerdict(50) === "not_spam");
    check("score=51 → spam (boundary)", deriveVerdict(51) === "spam");
    check("score=100 → spam", deriveVerdict(100) === "spam");

    // ============ [5] API: /api/spam/score requires auth ============
    console.log("\n[5] API: /api/spam/score requires auth");
    const anonR = await fetch(`${appUrl}/api/spam/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "anon test" }),
    });
    check("anon → 401", anonR.status === 401, `got ${anonR.status}`);

    // ============ [6] API: validation ============
    console.log("\n[6] API: validation");
    const emptyR = await apiFetch("/api/spam/score", {
      method: "POST",
      body: JSON.stringify({ text: "" }),
    });
    check("empty text → 400", emptyR.status === 400);

    const oversizeR = await apiFetch("/api/spam/score", {
      method: "POST",
      body: JSON.stringify({ text: "x".repeat(1601) }),
    });
    check("oversize text → 400", oversizeR.status === 400);

    const badJsonR = await fetch(`${appUrl}/api/spam/score`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookieHeader(),
      },
      body: "{not json",
    });
    check("malformed JSON → 400", badJsonR.status === 400);

    // ============ [7] API: score shape + verdict consistency ============
    console.log("\n[7] API: /api/spam/score returns full shape");
    const text1 = `API smoke test ${Date.now()}`;
    insertedHashes.push(hashText(text1));
    const r1 = await apiFetch("/api/spam/score", {
      method: "POST",
      body: JSON.stringify({ text: text1 }),
    });
    check("authenticated → 200", r1.status === 200);
    if (r1.status === 200) {
      const body = (await r1.json()) as {
        score: number;
        label: string;
        verdict: string;
        cached: boolean;
        provider: string;
        textHash: string;
        latencyMs: number;
        confidence: number | null;
        modelVersion: string | null;
        error: string | null;
      };
      check(
        "response has all expected fields",
        typeof body.score === "number" &&
          ["ham", "suspicious", "spam"].includes(body.label) &&
          ["spam", "not_spam"].includes(body.verdict) &&
          typeof body.cached === "boolean" &&
          typeof body.provider === "string" &&
          typeof body.latencyMs === "number" &&
          /^[0-9a-f]{64}$/.test(body.textHash),
      );
      check("score in 0..100", body.score >= 0 && body.score <= 100);
      check("provider is classifier-v1", body.provider === "classifier-v1");
      check(
        "label derived from score",
        body.label === deriveLabel(body.score),
      );
      check(
        "verdict derived from score",
        body.verdict === deriveVerdict(body.score),
      );

      // ============ [8] cache hit ============
      console.log("\n[8] API: same text second call is a cache hit");
      const r2 = await apiFetch("/api/spam/score", {
        method: "POST",
        body: JSON.stringify({ text: text1 }),
      });
      check("second call: 200", r2.status === 200);
      const body2 = (await r2.json()) as {
        score: number;
        cached: boolean;
      };
      check(
        "second call cached=true",
        body2.cached === true,
        `got cached=${body2.cached}`,
      );
      check("second call same score", body2.score === body.score);

      // Verify exactly one DB row exists for this hash.
      const rows = await db
        .select()
        .from(spam_scores)
        .where(eq(spam_scores.text_hash, body.textHash));
      check(
        "exactly one spam_scores row for this hash",
        rows.length === 1,
        `got ${rows.length}`,
      );
      check(
        "row text_length matches input length",
        rows[0]?.text_length === text1.length,
      );

      // ============ [9] force re-score ============
      console.log("\n[9] API: force=true bypasses cache");
      const r3 = await apiFetch("/api/spam/score", {
        method: "POST",
        body: JSON.stringify({ text: text1, force: true }),
      });
      check("force=true: 200", r3.status === 200);
      const body3 = (await r3.json()) as { cached: boolean };
      check("force=true: cached=false", body3.cached === false);
    }

    // ============ [10] API: /api/spam/health ============
    console.log("\n[10] API: /api/spam/health");
    const healthR = await apiFetch("/api/spam/health");
    check("health authenticated → 200", healthR.status === 200);
    const health = (await healthR.json()) as {
      status: string;
      latencyMs: number;
    };
    check("health has latencyMs number", typeof health.latencyMs === "number");
    check(
      "health status is 'ok' or 'error'",
      health.status === "ok" || health.status === "error",
    );
    if (health.status !== "ok") {
      console.warn(
        `  (warning: classifier reported status='${health.status}' — endpoint shape is correct but the upstream classifier is unreachable)`,
      );
    }

    // ============ [11] Anon → 401 on health ============
    console.log("\n[11] API: health requires auth");
    const anonHealthR = await fetch(`${appUrl}/api/spam/health`);
    check(
      "anon health → 401",
      anonHealthR.status === 401,
      `got ${anonHealthR.status}`,
    );
  } finally {
    console.log("\nCleanup");
    try {
      if (insertedHashes.length > 0) {
        await db
          .delete(spam_scores)
          .where(inArray(spam_scores.text_hash, insertedHashes));
      }
      console.log("  cleanup complete");
    } finally {
      await pg.end({ timeout: 5 });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
