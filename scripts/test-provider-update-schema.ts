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

// ===========================================================================
// ⭐ Degenerate send windows must be REJECTED, not silently defaulted.
//
// effectiveWindow (lib/quiet-hours.ts) honours a window only when start < end;
// anything else falls back to the DEFAULT 08:00–21:00 ET. So `0/0` does not
// mean "never send" — it means "send during the default hours", the opposite of
// what an operator typing it intends. These columns cannot express "never
// send"; that is what send_paused is for, and the error says so.
// ===========================================================================
const base = { name: "T", sms_provider_id: "t" };

// start === end — the case that reads as "disable sending" and is not.
const eqDay = providerCreateSchema.safeParse({
  ...base, send_window_weekday_start: 0, send_window_weekday_end: 0,
});
ok(!eqDay.success, "⭐ create: weekday window 0/0 is REJECTED (does not disable sending)");
ok(!eqDay.success && /pause/i.test(eqDay.error.issues[0]?.message ?? ""),
   "⭐ create: the error points at pausing the provider as the way to stop sending");
ok(!providerCreateSchema.safeParse({
  ...base, send_window_weekend_start: 600, send_window_weekend_end: 600,
}).success, "create: weekend window 600/600 is REJECTED too (both pairs checked)");

// start > end — same silent fallback, same rejection.
ok(!providerCreateSchema.safeParse({
  ...base, send_window_weekday_start: 1200, send_window_weekday_end: 600,
}).success, "create: inverted weekday window (start > end) is REJECTED");

// Valid and null-pair cases must still pass — the guard must not block real use.
ok(providerCreateSchema.safeParse({
  ...base, send_window_weekday_start: 570, send_window_weekday_end: 1170,
}).success, "create: a real window 570/1170 (09:30–19:30 ET) is accepted");
ok(providerCreateSchema.safeParse(base).success,
   "create: omitting the window entirely is accepted (null pair = use the default)");
ok(providerCreateSchema.safeParse({
  ...base, send_window_weekday_start: null, send_window_weekday_end: null,
}).success, "create: an explicit null pair is accepted (legitimately means 'default')");
// A half-set pair is already 'unset' to effectiveWindow, so it is not the trap.
ok(providerCreateSchema.safeParse({
  ...base, send_window_weekday_start: 600, send_window_weekday_end: null,
}).success, "create: a half-set pair is accepted (already treated as unset)");

// The SAME guard must apply on PATCH — a bad pair can arrive either way.
ok(!providerUpdateSchema.safeParse({ send_window_weekday_start: 0, send_window_weekday_end: 0 }).success,
   "⭐ update: 0/0 is REJECTED on PATCH too, not just create");
ok(providerUpdateSchema.safeParse({ send_window_weekday_start: 570, send_window_weekday_end: 1170 }).success,
   "update: a real window is accepted on PATCH");
// And the earlier guarantees must survive the base/refine restructure.
ok(!providerUpdateSchema.safeParse({}).success, "update: empty payload still rejected after refactor");
{
  const p = providerUpdateSchema.safeParse({ name: "Only renaming this" });
  ok(p.success && !("short_link_supported" in routeWouldSet(p.data as Record<string, unknown>)),
     "update: the .partial()/.default() fix still holds after the restructure");
}

console.log(`\n${fail === 0 ? "✓ ALL PASS" : "✗ FAILED"}  ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
