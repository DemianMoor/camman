// TEMPORARY — proves the guards workflow goes red on PR #317. Reverted before merge.
import { sql } from "drizzle-orm";
import { db } from "../db/client";
await db.execute(sql`INSERT INTO zz_never (x) VALUES (1)`);
