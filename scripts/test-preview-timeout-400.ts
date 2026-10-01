import "./_env-preload";
import "./_require-preview-db"; // second — refuses any target but the preview DB

// A campaign preview that hits its statement timeout must answer 400 with
// reason "preview_timeout", never 500 (card 869faaa3v).
//
// ⭐ THE ERROR IS REAL, NOT A MOCK. The bug was a check written against the
// error shape someone assumed (`err.code`) instead of the one Drizzle actually
// throws (the SQLSTATE on `err.cause`). A hand-built error would encode the
// same assumption. So this script makes Postgres cancel a statement through
// the app's own Drizzle client — `SET LOCAL statement_timeout` + pg_sleep,
// exactly how the preview's ceiling fires — and feeds THAT object to the
// mapping. It writes nothing.
//
//   node scripts/with-preview-env.mjs npx tsx --conditions=react-server scripts/test-preview-timeout-400.ts

import { readFileSync } from "node:fs";

import { sql } from "drizzle-orm";

let fail = 0;
const bar = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail++;
};

async function main() {
  const { db } = await import("@/db/client");
  const { previewTimeoutResponse } = await import("@/lib/api/preview-timeout");

  const caught = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return null;
    } catch (e) {
      return e;
    }
  };

  // A genuine statement-timeout cancellation, through the app's client.
  const timeoutErr = await caught(() =>
    db.transaction(async (tx) => {
      await tx.execute(sql`set local statement_timeout = '50ms'`);
      await tx.execute(sql`select pg_sleep(2)`);
    }),
  );
  const cause = (timeoutErr as { cause?: { code?: string } } | null)?.cause;
  bar("Postgres really cancelled the statement (57014 on the cause)", cause?.code === "57014", `cause.code=${cause?.code}`);

  // Red proof of the old check, on the real object.
  bar(
    "the OLD route check `err.code === \"57014\"` misses this real error",
    (timeoutErr as { code?: string } | null)?.code !== "57014",
    `top-level code=${(timeoutErr as { code?: string } | null)?.code}`,
  );

  const res = previewTimeoutResponse(timeoutErr);
  const body = res ? ((await res.json()) as { error?: string; details?: { reason?: string } }) : null;
  bar("a timeout maps to 400", res?.status === 400, `status=${res?.status}`);
  bar("…with reason preview_timeout", body?.details?.reason === "preview_timeout", JSON.stringify(body).slice(0, 160));
  bar("…and the operator sentence", /narrow the selection/.test(body?.error ?? ""));

  // Anything else must NOT be swallowed: a real non-timeout database error.
  const otherErr = await caught(() => db.execute(sql`select no_such_column from contacts limit 1`));
  bar("a non-timeout database error really failed (42703)", (otherErr as { cause?: { code?: string } } | null)?.cause?.code === "42703");
  bar("…and is NOT mapped (the route rethrows it unchanged)", previewTimeoutResponse(otherErr) === null);

  // The route uses the mapping and no longer carries the old check. A source
  // check is weak on its own; it is here only to tie the route to the helper
  // the bars above prove on a real error.
  const route = readFileSync("app/api/campaigns/audience-preview/route.ts", "utf8");
  bar(
    "the route maps errors through previewTimeoutResponse, not a top-level code check",
    route.includes("previewTimeoutResponse(e)") && !route.includes('code === "57014"'),
  );

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
