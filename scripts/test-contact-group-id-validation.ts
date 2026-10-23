// Regression checks for the contact-group validators — pure, no network, no DB.
// Run: npx tsx scripts/test-contact-group-id-validation.ts
//
// Drip intake mints contact_group_id = `drip:<org uuid>:<partner-tag>`
// (lib/drip/groups.ts), always > 40 chars. The edit form validated with the
// CREATE schema (max 40), so no drip group could be saved from the edit dialog
// ("Too big: expected string to have <=40 characters" on a read-only field).
import {
  CONTACT_GROUP_ID_MAX,
  contactGroupCreateSchema,
  contactGroupEditFormSchema,
  contactGroupUpdateSchema,
} from "@/lib/validators/contact-groups";

let pass = 0, fail = 0;
function ok(cond: boolean, label: string, detail = "") {
  if (cond) pass++; else { fail++; console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`); }
}

const DRIP_ID = "drip:b0ce3435-5ea2-4510-ab11-8cdd0d0c125b:pml-autoinsur";
ok(DRIP_ID.length > 40, "fixture id is longer than the old 40-char limit");

// 1. The edit form submits every field, including the read-only id it loaded.
const formValues = {
  name: "pml-autoinsur",
  contact_group_id: DRIP_ID,
  description: "edited description",
  color: "#1A2B3C",
  freeze_after_messages: 5,
  freeze_cadence_days: 14,
  suppress_after_days: null,
  suppress_min_freeze_messages: null,
  partner_id: 3,
  allow_voip: true,
  allow_unknown: false,
};
const edit = contactGroupEditFormSchema.safeParse(formValues);
ok(edit.success, "edit form accepts a group whose id is > 40 chars (and contains ':')",
  edit.success ? "" : JSON.stringify(edit.error.issues));
ok(edit.success && !("contact_group_id" in edit.data), "edit form output carries no contact_group_id");

// 2. The PATCH body: description / color / lifecycle overrides save.
const patch = contactGroupUpdateSchema.safeParse({
  description: "edited description",
  color: "#1A2B3C",
  freeze_after_messages: 5,
  suppress_after_days: null,
});
ok(patch.success, "PATCH with description/color/lifecycle overrides parses",
  patch.success ? "" : JSON.stringify(patch.error.issues));

// 3. The id is stripped from a PATCH — never validated, never written.
const withId = contactGroupUpdateSchema.safeParse({ description: "x", contact_group_id: DRIP_ID });
ok(withId.success && !("contact_group_id" in withId.data), "PATCH strips a supplied contact_group_id");
const idOnly = contactGroupUpdateSchema.safeParse({ contact_group_id: "renamed" });
ok(!idOnly.success, "PATCH carrying ONLY contact_group_id is refused (nothing to update)");

// 4. Create: the new limit, and the charset rule is unchanged.
const base = { name: "n" };
ok(CONTACT_GROUP_ID_MAX === 100, `create limit is 100 (got ${CONTACT_GROUP_ID_MAX})`);
ok(contactGroupCreateSchema.safeParse({ ...base, contact_group_id: "a".repeat(100) }).success, "create accepts a 100-char id");
ok(!contactGroupCreateSchema.safeParse({ ...base, contact_group_id: "a".repeat(101) }).success, "create rejects a 101-char id");
ok(!contactGroupCreateSchema.safeParse({ ...base, contact_group_id: DRIP_ID }).success,
  "create still rejects ':' — the drip: namespace stays pipeline-only");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
