// Line endings vs drizzle.__drizzle_migrations.hash — shared by
// verify-migration-integrity.ts and the apply-time preflight (check-migration-skip.ts).
//
// Drizzle records sha256 of the migration file EXACTLY as read from disk, line
// endings included. `.gitattributes` pins db/migrations/** to LF, but that only
// acts on commit and checkout — a migration is applied from the working file
// BEFORE it is committed, so a file a Windows tool wrote with CRLF gets a CRLF
// hash recorded forever, while git (and every later checkout) holds LF. That is
// how 0204 and 0208 were recorded on prod (2026-10-12): same SQL, different hash.

import { createHash } from "node:crypto";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Which line-ending form of `content` the recorded hash was taken from, or null
 * when neither matches (a real content difference). The recorded side can't be
 * normalized — only its hash survives — so both forms of the file are hashed.
 */
export function recordedHashForm(recorded: string | undefined, content: string): "lf" | "crlf" | null {
  const lf = content.replace(/\r\n/g, "\n");
  if (recorded === sha256(lf)) return "lf";
  if (recorded === sha256(lf.replace(/\n/g, "\r\n"))) return "crlf";
  return null;
}

/** A migration about to be applied must be LF, or Drizzle records a hash git can never reproduce. */
export function hasCarriageReturn(content: string): boolean {
  return content.includes("\r");
}
