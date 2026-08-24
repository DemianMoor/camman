import "./_env-preload";
import { createServerClient } from "@supabase/ssr";
import { sql } from "drizzle-orm";
import { db, sql as pgConn } from "@/db/client";

// Drip Phase 5 — production send proof driver.
//
// ⚠️ EVERY DESTINATION IS CHECKED AGAINST THE "Personal Numbers" GROUP AT SEND
// TIME, read live from the database rather than pasted in here. A hardcoded list
// would drift from the group the operator actually curates, and the first time
// it drifted the difference would be a real SMS to a stranger.
//
// Usage: npx tsx scripts/drip-p5-proof.ts <command> [args]
//   state | arm | disarm | window <start> <end> | inject <phone> | watch [secs]
//   pause | resume | exhaust | release

const PROD = process.env.SMOKE_BASE_URL ?? "https://camman.vercel.app";
const CAMP = Number(process.env.PROOF_CAMPAIGN_ID ?? 994);
const GROUP_NAME = "Personal Numbers";
const TOKEN = process.env.PROOF_TOKEN ?? "";
const SECRET = process.env.PROOF_SECRET ?? "";

interface ApiBody {
  [key: string]: unknown;
  data?: ApiBody;
  id?: number;
}

let cookie = "";
async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${PROD}${path}`, {
    method,
    headers: { cookie, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let j: unknown = null;
  try {
    j = await r.json();
  } catch {
    /* non-JSON */
  }
  return { status: r.status, body: j as ApiBody | null };
}

async function signIn() {
  const jar = new Map<string, string>();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => Array.from(jar).map(([name, value]) => ({ name, value })),
        setAll: (cs) => {
          for (const c of cs) jar.set(c.name, c.value);
        },
      },
    },
  );
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_EMAIL!,
    password: process.env.TEST_USER_PASSWORD!,
  });
  if (error) throw new Error(`sign-in: ${error.message}`);
  cookie = Array.from(jar)
    .map(([n, v]) => `${n}=${v}`)
    .join("; ");
}

async function rows(q: ReturnType<typeof sql>) {
  return (await db.execute(q)) as unknown as Record<string, any>[];
}

function hhmm(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
function etNow() {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  return (
    Number(f.find((p) => p.type === "hour")!.value) * 60 +
    Number(f.find((p) => p.type === "minute")!.value)
  );
}

/** The allowlist, read live from the group. */
async function allowed(): Promise<Map<string, string>> {
  const r = await rows(sql`
    SELECT c.id, c.phone_number
    FROM contacts c
    JOIN contact_contact_groups cg ON cg.contact_id = c.id
    JOIN contact_groups g ON g.id = cg.contact_group_id
    WHERE g.name = ${GROUP_NAME}
    ORDER BY c.phone_number`);
  return new Map(r.map((x) => [x.phone_number as string, x.id as string]));
}

async function state() {
  const et = etNow();
  console.log(`ET now ${hhmm(et)}`);
  console.log(
    `posture  ${JSON.stringify((await rows(sql`SELECT drip_enabled, drip_paused FROM org_settings`))[0])}`,
  );
  console.log(
    `campaign ${JSON.stringify(
      (
        await rows(
          sql`SELECT id, status, type, send_paused, send_paused_reason FROM campaigns WHERE id=${CAMP}`,
        )
      )[0],
    )}`,
  );
  for (const s of await rows(sql`
    SELECT id, window_start_min, window_end_min, drip_active, send_approved,
           materialized_at IS NOT NULL AS materialized, sent_at IS NOT NULL AS stamped
    FROM campaign_stages WHERE campaign_id=${CAMP} AND archived_at IS NULL ORDER BY id`)) {
    const inWin =
      s.window_start_min != null && et >= s.window_start_min && et < s.window_end_min;
    console.log(
      `stage ${s.id}  ${s.window_start_min == null ? "(no window)" : `${hhmm(s.window_start_min)}-${hhmm(s.window_end_min)}`}` +
        `  active=${s.drip_active} approved=${s.send_approved} mat=${s.materialized} sent_at=${s.stamped}` +
        `  ${inWin ? "<< NOW IN WINDOW" : ""}`,
    );
  }
  console.log(
    `numbers  ${JSON.stringify(await rows(sql`SELECT provider_phone_id, daily_limit FROM drip_campaign_numbers WHERE campaign_id=${CAMP}`))}`,
  );
  const a = await allowed();
  console.log(`allowlist "${GROUP_NAME}" (${a.size}): ${[...a.keys()].join(", ")}`);
  await journeys();
}

async function journeys() {
  const j = await rows(sql`
    SELECT j.id, ct.phone_number AS phone, j.state, j.routed_at, j.first_send_at,
           j.first_stage_id, j.reason
    FROM drip_journeys j JOIN contacts ct ON ct.id = j.contact_id
    WHERE j.campaign_id = ${CAMP} ORDER BY j.routed_at`);
  console.log(`journeys (${j.length}):`);
  for (const x of j)
    console.log(
      `   ${x.phone}  ${x.state}  routed=${x.routed_at ? String(x.routed_at).slice(11, 19) : "-"}` +
        ` first_send=${x.first_send_at ? String(x.first_send_at).slice(11, 19) : "-"} stage=${x.first_stage_id ?? "-"}`,
    );
  const s = await rows(sql`
    SELECT ss.id, ss.phone, ss.status, ss.provider_phone_id, ss.created_at, ss.sent_at,
           ss.texthub_message_id, ss.last_error, left(ss.rendered_text, 90) AS body
    FROM stage_sends ss WHERE ss.campaign_id = ${CAMP} ORDER BY ss.created_at`);
  console.log(`stage_sends (${s.length}):`);
  for (const x of s)
    console.log(
      `   ${x.phone}  ${x.status}  created=${String(x.created_at).slice(11, 19)}` +
        ` sent=${x.sent_at ? String(x.sent_at).slice(11, 19) : "-"}` +
        ` msgid=${x.texthub_message_id ?? "-"}${x.last_error ? ` err=${x.last_error}` : ""}`,
    );
  if (s[0]) console.log(`   body: ${JSON.stringify(s[0].body)}`);
}

async function inject(phone: string) {
  if (!TOKEN || !SECRET) throw new Error("PROOF_TOKEN / PROOF_SECRET must be set");
  const a = await allowed();
  if (!a.has(phone)) {
    console.error(
      `REFUSED: ${phone} is not in "${GROUP_NAME}". Allowed: ${[...a.keys()].join(", ")}`,
    );
    process.exit(1);
  }
  const t0 = Date.now();
  const r = await fetch(`${PROD}/api/intake/leads/${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-partner-secret": SECRET },
    body: JSON.stringify({ phone, first_name: "Proof", state: "NY" }),
  });
  const body = await r.text();
  console.log(`inject ${phone} -> HTTP ${r.status} (${Date.now() - t0}ms)  ${body.slice(0, 200)}`);
  console.log(
    `lead_inbox: ${JSON.stringify(
      await rows(
        sql`SELECT id, phone_e164, interest_tag, status, received_at, error
            FROM lead_inbox WHERE phone_e164 = ${phone} ORDER BY received_at DESC LIMIT 1`,
      ),
    )}`,
  );
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  await signIn();

  switch (cmd) {
    case "state":
      await state();
      break;

    case "arm": {
      const act = await api("POST", `/api/campaigns/${CAMP}/status`, { status: "active" });
      console.log(`activate -> HTTP ${act.status} ${JSON.stringify(act.body).slice(0, 160)}`);
      await db.execute(sql`
        UPDATE org_settings SET drip_enabled = true, drip_enabled_updated_at = now()`);
      console.log("posture -> ON");
      await state();
      break;
    }

    case "disarm": {
      await db.execute(sql`UPDATE org_settings SET drip_enabled = false, drip_enabled_updated_at = now()`);
      console.log("posture -> OFF");
      const p = await api("POST", `/api/campaigns/${CAMP}/drip-pause`, {
        action: "pause",
        reason: "proof complete",
      });
      console.log(`campaign pause -> HTTP ${p.status} ${JSON.stringify(p.body).slice(0, 160)}`);
      await state();
      break;
    }

    case "window": {
      const [s, e] = args.map(Number);
      const st = (
        await rows(
          sql`SELECT id FROM campaign_stages WHERE campaign_id=${CAMP} AND drip_active IS TRUE AND archived_at IS NULL ORDER BY id LIMIT 1`,
        )
      )[0];
      const r = await api("PATCH", `/api/campaigns/${CAMP}/stages/${st.id}`, {
        window_start_min: s,
        window_end_min: e,
      });
      console.log(`stage ${st.id} window -> ${hhmm(s)}-${hhmm(e)}  HTTP ${r.status}`);
      break;
    }

    case "inject":
      await inject(args[0]);
      break;

    case "watch": {
      const secs = Number(args[0] ?? 120);
      const until = Date.now() + secs * 1000;
      let last = "";
      while (Date.now() < until) {
        const j = await rows(sql`
          SELECT (SELECT count(*)::int FROM lead_inbox WHERE status='received') AS inbox_new,
                 (SELECT count(*)::int FROM drip_journeys WHERE campaign_id=${CAMP}) AS journeys,
                 (SELECT count(*)::int FROM stage_sends WHERE campaign_id=${CAMP} AND status='pending') AS pending,
                 (SELECT count(*)::int FROM stage_sends WHERE campaign_id=${CAMP} AND status='sent') AS sent`);
        const line = JSON.stringify(j[0]);
        if (line !== last) {
          console.log(`${new Date().toISOString().slice(11, 19)}  ${line}`);
          last = line;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      await journeys();
      break;
    }

    case "pause":
    case "resume": {
      const r = await api("POST", `/api/campaigns/${CAMP}/drip-pause`, {
        action: cmd,
        reason: "proof: pause-button test",
      });
      console.log(`${cmd} -> HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      break;
    }

    case "exhaust": {
      const n = (
        await rows(sql`
        SELECT count(*)::int AS n FROM stage_sends
        WHERE campaign_id=${CAMP} AND provider_phone_id=114
          AND created_at >= date_trunc('day', now() AT TIME ZONE 'America/New_York')
                            AT TIME ZONE 'America/New_York'`)
      )[0].n;
      const r = await api("PUT", `/api/campaigns/${CAMP}/drip-numbers`, {
        numbers: [{ provider_phone_id: 114, daily_limit: Math.max(1, n), position: 0 }],
      });
      console.log(`daily_limit -> ${Math.max(1, n)} (sends today = ${n})  HTTP ${r.status}`);
      break;
    }

    case "release": {
      const r = await api("PUT", `/api/campaigns/${CAMP}/drip-numbers`, {
        numbers: [{ provider_phone_id: 114, daily_limit: 20, position: 0 }],
      });
      console.log(`daily_limit -> 20  HTTP ${r.status}`);
      break;
    }

    default:
      console.log("commands: state arm disarm window <s> <e> inject <phone> watch [secs] pause resume exhaust release");
  }
  await pgConn.end();
}

main().catch(async (e) => {
  console.error("ERR", e);
  await pgConn.end();
  process.exit(1);
});
