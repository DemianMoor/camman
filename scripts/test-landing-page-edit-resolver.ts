import assert from "node:assert";

import { resolveLandingPageEdit } from "@/lib/landing-page-edit";

// Pure — no DB, no env. Run: npx tsx scripts/test-landing-page-edit-resolver.ts

const slugPage = { kind: "slug" as const, slug: "orv", external_url: null };
const urlPage = { kind: "external_url" as const, slug: null, external_url: "https://a.example/x" };

function ok(r: ReturnType<typeof resolveLandingPageEdit>) {
  assert.ok(r.ok, `expected ok, got refusal: ${!r.ok ? r.message : ""}`);
  return r;
}

function run() {
  // Title-only edit (no destination fields) — nothing changes.
  let r = ok(resolveLandingPageEdit(slugPage, {}));
  assert.deepStrictEqual(
    { kind: r.kind, slug: r.slug, external_url: r.external_url, changed: r.destinationChanged },
    { kind: "slug", slug: "orv", external_url: null, changed: false },
  );

  // Same values re-sent (the UI sends kind + value whenever the editor is open).
  r = ok(resolveLandingPageEdit(slugPage, { kind: "slug", slug: "orv" }));
  assert.strictEqual(r.destinationChanged, false, "re-sending the same slug is not a change");
  r = ok(resolveLandingPageEdit(urlPage, { kind: "external_url", external_url: "https://a.example/x" }));
  assert.strictEqual(r.destinationChanged, false, "re-sending the same URL is not a change");

  // Slug edit.
  r = ok(resolveLandingPageEdit(slugPage, { slug: "orv2" }));
  assert.deepStrictEqual([r.kind, r.slug, r.external_url, r.destinationChanged], ["slug", "orv2", null, true]);

  // URL edit.
  r = ok(resolveLandingPageEdit(urlPage, { external_url: "https://b.example/y" }));
  assert.deepStrictEqual(
    [r.kind, r.slug, r.external_url, r.destinationChanged],
    ["external_url", null, "https://b.example/y", true],
  );

  // slug → external_url: the slug column is cleared.
  r = ok(resolveLandingPageEdit(slugPage, { kind: "external_url", external_url: "https://c.example" }));
  assert.deepStrictEqual(
    [r.kind, r.slug, r.external_url, r.destinationChanged],
    ["external_url", null, "https://c.example", true],
  );

  // external_url → slug: the URL column is cleared.
  r = ok(resolveLandingPageEdit(urlPage, { kind: "slug", slug: "monks" }));
  assert.deepStrictEqual([r.kind, r.slug, r.external_url, r.destinationChanged], ["slug", "monks", null, true]);

  // A value that doesn't belong to the target kind is refused.
  let bad = resolveLandingPageEdit(slugPage, { external_url: "https://c.example" });
  assert.ok(!bad.ok && bad.field === "external_url", "URL on a slug page must be refused");
  bad = resolveLandingPageEdit(urlPage, { slug: "orv" });
  assert.ok(!bad.ok && bad.field === "slug", "slug on a URL page must be refused");
  bad = resolveLandingPageEdit(slugPage, { kind: "external_url", slug: "orv", external_url: "https://c.example" });
  assert.ok(!bad.ok && bad.field === "slug", "slug sent alongside a switch to URL must be refused");

  // Switching kind without the new kind's value is refused.
  bad = resolveLandingPageEdit(slugPage, { kind: "external_url" });
  assert.ok(!bad.ok && bad.field === "external_url", "switch to URL without a URL must be refused");
  bad = resolveLandingPageEdit(urlPage, { kind: "slug" });
  assert.ok(!bad.ok && bad.field === "slug", "switch to slug without a slug must be refused");

  console.log("landing-page-edit resolver: all assertions passed");
}
run();
