// One-shot backfill (Phase 2 of the multi-account credentials workstream):
// 1) encrypt every plaintext provider_credentials.api_key into
//    api_key_encrypted (+ api_key_last4, + a default label), and
// 2) link provider_phones.credential_id to a provider's sole credential row,
//    for providers that have exactly one.
//
// Idempotent — step 1 only touches rows where api_key_encrypted IS NULL AND
// api_key IS NOT NULL; step 2 only touches phones where credential_id IS
// NULL. Re-running after a partial run (or after nothing changed) is safe.
//
// Two modes:
//   dry-run (default): prints planned changes, writes nothing.
//   --apply: performs the writes, then verifies every touched credential
//     decrypts back to the original plaintext, then asserts the known-good
//     end-state (see RECONCILIATION below) before exiting 0.
//
// Does NOT null the plaintext api_key column — kept for the dual-read window
// (see lib/sends/provider-credential.ts); dropped in a later task.
//
// Run against the same DATABASE_URL the deployed app uses:
//   npx tsx scripts/backfill-provider-credentials-encryption.ts
//   npx tsx scripts/backfill-provider-credentials-encryption.ts --apply
//
// Bypasses RLS via the privileged DB connection — does NOT require a signed-in
// user. Never logs the plaintext key or the master key; only last4/label/ids.

import { config } from "dotenv";
import { resolve } from "node:path";
config({ path: resolve(process.cwd(), ".env.local") });

import { eq, sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  provider_credentials,
  provider_phones,
  sms_providers,
} from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secret-box";
import { maskApiKey } from "@/lib/sends/provider-credential";

const APPLY = process.argv.includes("--apply");

// Reconciled 2026-07-15 prod inventory. Guards against running this against a
// DB that has drifted from what this script was designed for — if the shape
// doesn't match, we stop rather than silently doing something unexpected.
const EXPECTED = {
  credentialIdsToEncrypt: [2, 262].sort((a, b) => a - b),
  phoneLinks: {
    2: [26, 27, 43].sort((a, b) => a - b), // TextHub (provider 2 / txh)
    262: [44, 45].sort((a, b) => a - b), // Ahoi (provider 314 / ahi)
  } as Record<number, number[]>,
  skippedProviders: ["snx", "smpl"].sort(),
};

function fail(msg: string): never {
  console.error(`\nFAIL: ${msg}`);
  process.exit(1);
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) fail("DATABASE_URL is not set in .env.local");
  if (!process.env.PROVIDER_CREDENTIALS_KEY) {
    fail("PROVIDER_CREDENTIALS_KEY is not set in .env.local");
  }

  const pg = postgres(dbUrl!, { prepare: false, max: 1 });
  const db = drizzle(pg);

  console.log(APPLY ? "=== APPLY MODE ===" : "=== DRY RUN (no writes) ===");

  try {
    // ============ Step 1: encrypt plaintext keys ============
    const credRows = await db
      .select({
        id: provider_credentials.id,
        provider_id: provider_credentials.provider_id,
        label: provider_credentials.label,
        api_key: provider_credentials.api_key,
        provider_name: sms_providers.name,
      })
      .from(provider_credentials)
      .innerJoin(
        sms_providers,
        eq(sms_providers.id, provider_credentials.provider_id),
      )
      .where(
        drizzleSql`${provider_credentials.api_key_encrypted} IS NULL AND ${provider_credentials.api_key} IS NOT NULL`,
      )
      .orderBy(provider_credentials.id);

    console.log(
      `\nCredentials to encrypt: ${credRows.length} (${credRows.map((c) => c.id).join(", ") || "none"})`,
    );

    const touchedCredentialIds: number[] = [];
    for (const c of credRows) {
      const { last4 } = maskApiKey(c.api_key as string);
      const label = c.label ?? `${c.provider_name} — Default`;
      console.log(
        `  cred ${c.id} (${c.provider_name}): last4=${last4} label="${label}"`,
      );
      if (APPLY) {
        const enc = encryptSecret(c.api_key as string);
        await db
          .update(provider_credentials)
          .set({ api_key_encrypted: enc, api_key_last4: last4, label })
          .where(eq(provider_credentials.id, c.id));
        touchedCredentialIds.push(c.id);
      }
    }

    // ============ Step 2: link phones to their provider's sole credential ============
    const providerCredCounts = (await db.execute(drizzleSql`
      SELECT p.id AS provider_id, p.sms_provider_id, p.name,
             count(pc.id)::int AS cred_count
      FROM sms_providers p
      LEFT JOIN provider_credentials pc ON pc.provider_id = p.id
      GROUP BY p.id, p.sms_provider_id, p.name
      ORDER BY p.id
    `)) as unknown as {
      provider_id: number;
      sms_provider_id: string;
      name: string;
      cred_count: number;
    }[];

    console.log("\nProvider -> credential-count / link plan:");
    const phoneLinks: { provider_id: number; credential_id: number; phone_ids: number[] }[] = [];
    const skippedProviders: { sms_provider_id: string; name: string; reason: string }[] = [];

    for (const p of providerCredCounts) {
      if (p.cred_count !== 1) {
        skippedProviders.push({
          sms_provider_id: p.sms_provider_id,
          name: p.name,
          reason: `${p.cred_count} credentials (need exactly 1)`,
        });
        console.log(
          `  SKIP ${p.name} (${p.sms_provider_id}): ${p.cred_count} credentials`,
        );
        continue;
      }
      const [{ id: credentialId }] = await db
        .select({ id: provider_credentials.id })
        .from(provider_credentials)
        .where(eq(provider_credentials.provider_id, p.provider_id));

      const unlinkedPhones = await db
        .select({ id: provider_phones.id })
        .from(provider_phones)
        .where(
          drizzleSql`${provider_phones.provider_id} = ${p.provider_id} AND ${provider_phones.credential_id} IS NULL`,
        )
        .orderBy(provider_phones.id);
      const phoneIds = unlinkedPhones.map((r) => r.id);

      console.log(
        `  LINK ${p.name} (${p.sms_provider_id}): credential ${credentialId} <- phones [${phoneIds.join(", ") || "none"}]`,
      );

      if (phoneIds.length > 0) {
        phoneLinks.push({ provider_id: p.provider_id, credential_id: credentialId, phone_ids: phoneIds });
        if (APPLY) {
          await db
            .update(provider_phones)
            .set({ credential_id: credentialId })
            .where(
              drizzleSql`${provider_phones.provider_id} = ${p.provider_id} AND ${provider_phones.credential_id} IS NULL`,
            );
        }
      }
    }

    const totalPhonesLinked = phoneLinks.reduce((sum, l) => sum + l.phone_ids.length, 0);

    console.log("\n=== Summary ===");
    console.log(`Credentials to encrypt: ${credRows.length}`);
    console.log(`Phones to link: ${totalPhonesLinked}`);
    console.log(
      `Providers skipped: ${skippedProviders.map((s) => s.sms_provider_id).join(", ") || "none"}`,
    );

    // ============ Step 3: verify (apply mode only) ============
    if (APPLY && touchedCredentialIds.length > 0) {
      console.log("\n=== Verifying encrypted credentials ===");
      for (const id of touchedCredentialIds) {
        const [row] = await db
          .select({
            api_key: provider_credentials.api_key,
            api_key_encrypted: provider_credentials.api_key_encrypted,
            api_key_last4: provider_credentials.api_key_last4,
          })
          .from(provider_credentials)
          .where(eq(provider_credentials.id, id));
        if (!row || !row.api_key_encrypted || !row.api_key) {
          fail(`cred ${id}: missing row/columns after write`);
        }
        const decrypted = decryptSecret(row.api_key_encrypted!);
        if (decrypted !== row.api_key) {
          fail(`cred ${id}: decrypted value does not match plaintext api_key`);
        }
        const expectedLast4 = row.api_key!.slice(-4);
        if (row.api_key_last4 !== expectedLast4) {
          fail(`cred ${id}: api_key_last4 mismatch`);
        }
        console.log(`  cred ${id}: OK (decrypt round-trip + last4 match)`);
      }
    }

    // ============ Step 4: reconciliation assertion ============
    console.log("\n=== Reconciliation ===");
    const actualCredIds = credRows.map((c) => c.id).sort((a, b) => a - b);
    const actualPhoneLinks: Record<number, number[]> = {};
    for (const l of phoneLinks) {
      actualPhoneLinks[l.credential_id] = [...l.phone_ids].sort((a, b) => a - b);
    }
    const actualSkipped = skippedProviders.map((s) => s.sms_provider_id).sort();

    console.log(`  Expected credentials to encrypt: [${EXPECTED.credentialIdsToEncrypt.join(", ")}]`);
    console.log(`  Actual credentials to encrypt:   [${actualCredIds.join(", ")}]`);
    for (const [credId, expectedPhones] of Object.entries(EXPECTED.phoneLinks)) {
      const actual = actualPhoneLinks[Number(credId)] ?? [];
      console.log(
        `  Expected phones -> cred ${credId}: [${expectedPhones.join(", ")}]  Actual: [${actual.join(", ")}]`,
      );
    }
    console.log(`  Expected skipped providers: [${EXPECTED.skippedProviders.join(", ")}]`);
    console.log(`  Actual skipped providers:   [${actualSkipped.join(", ")}]`);

    const mismatches: string[] = [];
    if (JSON.stringify(actualCredIds) !== JSON.stringify(EXPECTED.credentialIdsToEncrypt)) {
      mismatches.push(
        `credential ids to encrypt: expected [${EXPECTED.credentialIdsToEncrypt.join(", ")}], got [${actualCredIds.join(", ")}]`,
      );
    }
    for (const [credId, expectedPhones] of Object.entries(EXPECTED.phoneLinks)) {
      const actual = actualPhoneLinks[Number(credId)] ?? [];
      if (JSON.stringify(actual) !== JSON.stringify(expectedPhones)) {
        mismatches.push(
          `phones -> cred ${credId}: expected [${expectedPhones.join(", ")}], got [${actual.join(", ")}]`,
        );
      }
    }
    if (JSON.stringify(actualSkipped) !== JSON.stringify(EXPECTED.skippedProviders)) {
      mismatches.push(
        `skipped providers: expected [${EXPECTED.skippedProviders.join(", ")}], got [${actualSkipped.join(", ")}]`,
      );
    }

    if (mismatches.length > 0) {
      console.error("\nWARNING: reconciliation mismatch vs expected prod shape:");
      for (const m of mismatches) console.error(`  - ${m}`);
      fail("reconciliation assertion failed — DB shape has drifted from the expected inventory; refusing to proceed silently");
    }

    console.log("\nReconciliation OK — matches expected shape.");
    console.log(APPLY ? "\nDone (applied)." : "\nDone (dry run — no writes made). Re-run with --apply to write.");
  } finally {
    await pg.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
