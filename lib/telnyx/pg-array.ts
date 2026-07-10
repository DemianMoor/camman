import { sql, type SQL } from "drizzle-orm";

// Build a Postgres array literal for raw sql (ANY / unnest). drizzle's ${jsArray}
// interpolation doesn't reliably encode arrays for postgres-js with an explicit
// ::type[] cast, so we follow the codebase's proven ARRAY[...] raw pattern (see
// buildGroupMembershipClause in lib/audience-snapshot.ts). Values are single-quote
// escaped — use for validated/trusted strings (E.164 phones, DB uuids).
export function pgArray(values: string[], cast: "text" | "uuid" | "bigint"): SQL {
  if (values.length === 0) return sql.raw(`ARRAY[]::${cast}[]`);
  const lit = values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
  return sql.raw(`ARRAY[${lit}]::${cast}[]`);
}
