import { redactForRole, type AliasTable } from "../lib/authz/redact";

// Operator response-redaction guard (ClickUp 869et3vm1 Phase 2).
//
// The redactor had NO test until 2026-09-11, and the gap cost a production
// outage for the first real operator: it rebuilt every object from
// Object.entries(), a Date has no own enumerable properties, so EVERY
// timestamp in an operator's payload became `{}`. `new Date({})` is Invalid
// Date and date-fns `format()` throws RangeError on it, so /campaigns died
// outright — while the Owner saw the page perfectly, because redactForRole()
// returns the payload untouched for every role except `operator`.
//
// ⭐ THAT ASYMMETRY IS THE WHOLE DIFFICULTY. Nothing an owner does can surface
// an operator-only defect, and this codebase had exactly one owner for a year.
// So the tests below assert the OPERATOR output against the OWNER output
// wherever the two are supposed to agree — the owner's payload is the
// reference, and redaction may only change what it is meant to change.
//
// Run: npx tsx scripts/test-operator-redaction.ts

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) {
    console.log(`        expected ${JSON.stringify(expected)}`);
    console.log(`        got      ${JSON.stringify(actual)}`);
  }
}

const table: AliasTable = {
  byId: new Map([[1, "Route A"], [2, "Route B"]]),
  byValue: new Map([["texthub", "Route A"], ["txh", "Route A"], ["tells", "Route B"]]),
};

const ISO = "2026-09-11T12:00:00.000Z";
const makePayload = () => ({
  data: [
    {
      id: 7,
      name: "Spring blast",
      created_at: new Date(ISO),
      start_date: new Date(ISO),
      provider_name: "TextHub",
      sms_provider_id: 1,
      adapter_code: "some-unrecognised-code",
      nested: { deep: { sent_at: new Date(ISO), provider_name: "Tells" } },
      stages: [{ scheduled_at: new Date(ISO), provider_name: "txh" }],
      body: "TextHub is mentioned inside this creative body text",
      archived_at: null,
      is_active: true,
      count: 42,
    },
  ],
  totalCount: 1,
});

function main() {
  console.log("\ntimestamps survive redaction (the 2026-09-11 regression)");
  const owner = redactForRole("owner", makePayload(), table);
  const op = redactForRole("operator", makePayload(), table);
  const o = owner.data[0];
  const p = op.data[0];

  check("top-level Date is still a Date", p.created_at instanceof Date, true);
  check("top-level Date keeps its value", (p.created_at as Date).toISOString(), ISO);
  check("second top-level Date survives", (p.start_date as Date).toISOString(), ISO);
  check("Date nested two levels deep survives", (p.nested.deep.sent_at as Date).toISOString(), ISO);
  check("Date inside an array survives", (p.stages[0].scheduled_at as Date).toISOString(), ISO);
  check(
    "operator timestamp serialises identically to the owner's",
    JSON.parse(JSON.stringify(p.created_at)),
    JSON.parse(JSON.stringify(o.created_at)),
  );
  check("null timestamp stays null", p.archived_at, null);

  console.log("\nredaction still does its actual job");
  check("provider name -> alias", p.provider_name, "Route A");
  check("nested provider name -> alias", p.nested.deep.provider_name, "Route B");
  check("provider code inside an array -> alias", p.stages[0].provider_name, "Route A");
  check("numeric sms_provider_id -> alias", p.sms_provider_id, "Route A");
  check("unrecognised value on an identity key -> null", p.adapter_code, null);
  check(
    "prose mentioning a provider is NOT mangled (whole-string match only)",
    p.body,
    "TextHub is mentioned inside this creative body text",
  );
  check("non-identity scalars untouched", [p.id, p.name, p.is_active, p.count], [7, "Spring blast", true, 42]);
  check("structure preserved", op.totalCount, 1);

  console.log("\nevery other role is untouched");
  for (const role of ["owner", "admin", "manager", "viewer"] as const) {
    const out = redactForRole(role, makePayload(), table);
    check(`${role}: provider name NOT redacted`, out.data[0].provider_name, "TextHub");
    check(`${role}: Date preserved`, out.data[0].created_at instanceof Date, true);
  }

  // ⭐ CAN-GO-RED CONTROL. A guard that cannot fail is decoration. This is the
  // exact branch the redactor used to run; the assertions above must reject it.
  console.log("\ncontrol — the old rebuild-everything branch is detected");
  function oldRedact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(oldRedact);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = oldRedact(v);
      }
      return out;
    }
    return value;
  }
  const broken = oldRedact({ created_at: new Date(ISO) }) as { created_at: unknown };
  check("control: old branch turns a Date into {}", JSON.stringify(broken.created_at), "{}");
  check("control: old branch's Date is no longer a Date", broken.created_at instanceof Date, false);
  check(
    "control: new Date() on that value is Invalid Date",
    Number.isNaN(new Date(broken.created_at as never).getTime()),
    true,
  );

  console.log(
    failures === 0 ? "\n=== ALL PASS ===" : `\n=== ${failures} FAILURE(S) ===`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main();
