import "./_env-preload";
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
const CUT='2026-08-17T12:21:28Z';
async function main(){
  const s=(await db.execute(sql`
    SELECT p.sms_provider_id AS k, count(*)::int AS n
    FROM stage_sends ss JOIN campaign_stages st ON st.id=ss.stage_id
    JOIN sms_providers p ON p.id=st.sms_provider_id
    WHERE ss.sent_at > ${CUT}::timestamptz GROUP BY 1 ORDER BY 1
  `)) as unknown as {k:string;n:number}[];
  const f=(await db.execute(sql`
    SELECT count(*)::int AS n FROM send_attempts
    WHERE created_at > ${CUT}::timestamptz AND error IS NOT NULL
  `)) as unknown as {n:number}[];
  if (s.length) console.log(`DRAINRESULT ${s.map(r=>r.k+'='+r.n).join(' ')} errored_attempts=${f[0].n}`);
  await db.$client.end({timeout:5});
}
main().catch(e=>{console.log('DRAINRESULT WATCH-ERROR '+String(e).slice(0,140));process.exit(0);});
