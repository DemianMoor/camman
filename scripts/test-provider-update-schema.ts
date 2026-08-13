// Regression checks for the provider validators (ClickUp 869ehjwtf) — pure, no
// network, no DB. Run: npx tsx scripts/test-provider-update-schema.ts
//
// Two defects are pinned here, both of which silently corrupted provider config:
//
//   1. `supports_api_send` was settable through the bulk create/update schema,
//      so the provider form — which submits every field on every save with no
//      concurrency check — could write back a STALE `true` after a deliberate
//      act had cleared it. Observed on the `tls` provider 2026-08-13.
//
//   2. `.partial()` does NOT strip an inner `.default()`. A PATCH that OMITTED
//      a defaulted boolean parsed to `false` (a real value, not `undefined`),
//      so the route's `if (v === undefined) continue` guard did not skip it and
//      the column was WRITTEN. Any partial PATCH silently cleared those flags.
//
// (2) is a Zod-version-dependent behaviour, which is exactly why it is pinned:
// if an upgrade changes how `.partial()` composes over `.default()`, this test
// fails instead of a provider quietly losing a flag.
import {
  providerCreateSchema,
  providerUpdateSchema,
  providerApiSendSchema,
} from "@/lib/validators/providers";

let pass = 0, fail = 0;
function eq(actual: unknown, expected: unknown, label: string) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; } else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      got      ${a}`); }
}
function ok(cond: boolean, label: string) { if (cond) pass++; else { fail++; console.log(`  ✗ ${label}`); } }

// Reproduces the PATCH route's update-building loop verbatim
// (app/api/providers/[providerId]/route.ts) so the test asserts on what the
// route would actually WRITE, not merely on what Zod returns.
function routeWouldSet(parsedData: Record<string, unknown>): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsedData)) {
    if (v === undefined) continue;
    updates[k] = v;
  }
  return updates;
}

// --- (1) the go-live gate is not reachable through the bulk schemas ---
const created = providerCreateSchema.safeParse({
  name: "Test", sms_provider_id: "test", supports_api_send: true,
});
ok(created.success, "create: parses");
if (created.success) {
  ok(!("supports_api_send" in created.data),
     "create: supports_api_send is STRIPPED even when supplied (never client-settable)");
}

const updated = providerUpdateSchema.safeParse({ name: "x", supports_api_send: true });
ok(updated.success, "update: parses");
if (updated.success) {
  const set = routeWouldSet(updated.data as Record<string, unknown>);
  ok(!("supports_api_send" in set),
     "update: a payload trying to set supports_api_send=true writes NOTHING for it");
}

// --- (2) omitted fields must stay omitted, not become false ---
const partial = providerUpdateSchema.safeParse({ name: "Only renaming this" });
ok(partial.success, "update: single-field PATCH parses");
if (partial.success) {
  const set = routeWouldSet(partial.data as Record<string, unknown>);
  eq(set, { name: "Only renaming this" },
     "update: omitting short_link_supported does NOT write false (the .partial()/.default() trap)");
  ok(!("short_link_supported" in set),
     "update: short_link_supported absent from the update set when omitted");
}

// An EXPLICIT false must still be written — "omitted" and "set to false" are
// different intents and the fix must not collapse them.
const explicitFalse = providerUpdateSchema.safeParse({ short_link_supported: false });
ok(explicitFalse.success, "update: explicit false parses");
if (explicitFalse.success) {
  const set = routeWouldSet(explicitFalse.data as Record<string, unknown>);
  eq(set, { short_link_supported: false },
     "update: an EXPLICIT false is still written (omitted != explicitly false)");
}
const explicitTrue = providerUpdateSchema.safeParse({ short_link_supported: true });
if (explicitTrue.success) {
  eq(routeWouldSet(explicitTrue.data as Record<string, unknown>), { short_link_supported: true },
     "update: an explicit true is written");
}

// The empty-payload guard still holds after the .extend().
ok(!providerUpdateSchema.safeParse({}).success, "update: empty payload still rejected");

// Create still defaults short_link_supported (correct for an INSERT — every
// column needs a value there; it is only on UPDATE that a default is wrong).
const createDefaults = providerCreateSchema.safeParse({ name: "T", sms_provider_id: "t" });
if (createDefaults.success) {
  eq(createDefaults.data.short_link_supported, false,
     "create: short_link_supported still defaults to false on INSERT");
}

// --- the dedicated gate endpoint's schema ---
ok(providerApiSendSchema.safeParse({ enabled: true }).success, "api-send: {enabled} accepted");
ok(providerApiSendSchema.safeParse({ enabled: false, reason: "go-live" }).success,
   "api-send: reason accepted");
ok(!providerApiSendSchema.safeParse({}).success, "api-send: enabled is REQUIRED (no default)");
ok(!providerApiSendSchema.safeParse({ enabled: "yes" }).success, "api-send: non-boolean rejected");

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
