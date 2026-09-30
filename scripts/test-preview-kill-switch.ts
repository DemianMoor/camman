// Task 2, T1b — the audience-preview kill switch serves what it says.
//
// Drives the REAL route over HTTP against a running server and asserts which
// implementation answered (the x-audience-preview-impl header, set from the
// same variable that picks the function). Run it twice, once per server mode:
//
//   AUDIENCE_PREVIEW_IMPL=reference npm run dev:preview   →  --expect=reference
//   npm run dev:preview                                   →  --expect=live
//
//   node scripts/with-preview-env.mjs npx tsx scripts/test-preview-kill-switch.ts --expect=reference
//
// --no-source previews an EMPTY selection: the route still picks and names its
// implementation, but returns before any audience query. Use it against
// PRODUCTION outside the quiet window, where the first group could be the
// 646K one.
//
// Writes nothing: the preview route is read-only, and this script opens no
// database connection of its own.
import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { createServerClient } from "@supabase/ssr";

const NO_SOURCE = process.argv.includes("--no-source");
const expect = process.argv
  .find((a) => a.startsWith("--expect="))
  ?.slice("--expect=".length);

async function main() {
  if (expect !== "reference" && expect !== "live") {
    console.error("Pass --expect=reference or --expect=live (the mode the server was started in).");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const appUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3001";
  const email = process.env.TEST_USER_EMAIL;
  const password = process.env.TEST_USER_PASSWORD;
  if (!email || !password) {
    console.error("Set TEST_USER_EMAIL/TEST_USER_PASSWORD.");
    process.exit(1);
  }
  const jar = new Map<string, string>();
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      setAll: (cs) => cs.forEach(({ name, value }) => jar.set(name, value)),
    },
  });
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error(`Sign-in failed: ${error.message}`);
    process.exit(1);
  }
  const apiFetch = (path: string, init?: RequestInit) =>
    fetch(`${appUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
      },
    });

  let fail = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) fail++;
  };

  // A real group, so the preview runs its query rather than the no-source
  // early return.
  let groupId: number | undefined;
  if (!NO_SOURCE) {
    const groups = (await (await apiFetch("/api/contact-groups/list?pageSize=1")).json()) as {
      data?: { id: number }[];
    };
    groupId = groups.data?.[0]?.id;
    check("a contact group exists to preview", groupId != null);
  }

  const res = await apiFetch("/api/campaigns/audience-preview", {
    method: "POST",
    body: JSON.stringify({
      audience_contact_group_ids: groupId != null ? [groupId] : [],
      exclude_in_use_contacts: false,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { total_matching?: unknown };
  const served = res.headers.get("x-audience-preview-impl");
  check("the preview answers 200", res.status === 200, `${res.status}`);
  check("it returns a preview result", typeof body.total_matching === "number", JSON.stringify(body).slice(0, 160));
  check(`it was served by the ${expect} implementation`, served === expect, `header: ${served}`);
  console.log(`\n  body: ${JSON.stringify(body)}`);

  console.log(fail === 0 ? "\nAll checks passed." : `\n${fail} check(s) FAILED.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
