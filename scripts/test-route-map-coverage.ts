import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { OPERATOR_ROUTE_MAP } from "@/lib/authz/route-map";

// Drift check: every API route on disk must be classified in
// OPERATOR_ROUTE_MAP, and every key in the map must still exist on disk.
//
// ⚠️ THIS IS NOT WHAT MAKES THE SYSTEM SAFE. Safety is structural — a route
// that never passes { route, method } to requireApiMembership() denies the
// operator whether or not it appears here. This check exists so that an
// unclassified route is a REVIEW ITEM rather than an invisible default: if
// someone adds an endpoint that should be operator-visible, the failure below
// is what tells them to decide, instead of the endpoint silently 403ing and
// being debugged later.
//
// It discovers routes from the FILESYSTEM rather than from a list, so a route
// added next month is covered without anyone remembering this file exists
// (docs/07-conventions.md — enumerating "routes I think exist" only tests the
// author's imagination).

const API_ROOT = resolve(process.cwd(), "app/api");

function findRoutes(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) findRoutes(full, out);
    else if (entry === "route.ts") {
      out.push(relative(API_ROOT, dir).split(sep).join("/"));
    }
  }
  return out;
}

let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  console.log(`  ${ok ? "OK " : "XX "} ${label} — ${detail}`);
  if (!ok) failures++;
}

console.log("=== route map coverage ===\n");

const onDisk = findRoutes(API_ROOT).sort();
const inMap = Object.keys(OPERATOR_ROUTE_MAP).sort();

console.log(`  scope: ${onDisk.length} route.ts files on disk, ${inMap.length} keys in the map`);

// An empty scope means the walker broke, not that everything is fine.
if (onDisk.length === 0) {
  check("route discovery", false, "EMPTY — found no route.ts files; the walker is broken");
} else {
  check("route discovery", true, `${onDisk.length} routes discovered from the filesystem`);
}

const missing = onDisk.filter((r) => !(r in OPERATOR_ROUTE_MAP));
check(
  "every route on disk is classified",
  missing.length === 0,
  missing.length
    ? `${missing.length} UNCLASSIFIED — decide allow/deny for: ${missing.join(", ")}`
    : "no unclassified routes",
);

const stale = inMap.filter((r) => !onDisk.includes(r));
check(
  "no stale map entries",
  stale.length === 0,
  stale.length
    ? `${stale.length} key(s) with no route.ts: ${stale.join(", ")}`
    : "every key maps to a real route",
);

// The allowed half must actually be wired, or it is a lie: the map says the
// operator may reach it, but requireApiMembership() denies because the handler
// never passes { route, method }.
const allowed = inMap.filter((r) => OPERATOR_ROUTE_MAP[r] != null);
const unwired: string[] = [];
for (const r of allowed) {
  const src = readFileSync(join(API_ROOT, r, "route.ts"), "utf8");
  if (!src.includes(`route: "${r}"`)) unwired.push(r);
}
console.log(`  scope: ${allowed.length} allowed routes checked for wiring`);
if (allowed.length === 0) {
  check("allowed-route wiring", false, "EMPTY — no allowed routes found");
} else {
  check(
    "every allowed route passes its own key",
    unwired.length === 0,
    unwired.length
      ? `${unwired.length} allowed but NOT wired (operator will still be denied): ${unwired.join(", ")}`
      : `all ${allowed.length} wired`,
  );
}

// ── API-token allowlist (ClickUp 869evpmbz) ───────────────────────────────
//
// Two properties, and they fail for different reasons.
//
// SUBSET. A token is its owner's authority NARROWED. If `token` ever names a
// method absent from `methods`, the map would be granting a token something the
// operator role itself may not do — the one thing this design promises cannot
// happen. TypeScript cannot express "subset of a sibling field", so it is
// asserted here.
//
// WIRING. Same trap as the allowed half above: a `token` list on a route whose
// handler never passes { route, method } reads as "the agent can call this" and
// silently 403s. The wiring check above already covers every non-null entry, and
// a token entry can only exist on a non-null entry, so this re-states the
// requirement rather than re-testing it — but it names the token surface
// explicitly in the output, which is the list a reviewer actually wants to see.
const tokenRoutes = inMap.filter((r) => OPERATOR_ROUTE_MAP[r]?.token !== undefined);
const notSubset: string[] = [];
for (const r of tokenRoutes) {
  const entry = OPERATOR_ROUTE_MAP[r];
  if (!entry?.token) continue;
  const extra = entry.token.filter((m) => !entry.methods.includes(m));
  if (extra.length > 0) notSubset.push(`${r} (${extra.join(", ")})`);
}

console.log(`\n  scope: ${tokenRoutes.length} routes reachable by an API token`);
if (tokenRoutes.length === 0) {
  // Not a failure in principle, but it means the token feature reaches nothing
  // — which is never what someone editing this file intended.
  check("token allowlist non-empty", false, "EMPTY — no route grants token access");
} else {
  check(
    "token methods are a subset of operator methods",
    notSubset.length === 0,
    notSubset.length
      ? `${notSubset.length} route(s) grant a token MORE than the role: ${notSubset.join(", ")}`
      : `all ${tokenRoutes.length} within the role's methods`,
  );
}

const denied = inMap.length - allowed.length;
console.log(`\n  summary: ${allowed.length} allowed / ${denied} denied of ${inMap.length}`);
console.log(`\n=== ${failures === 0 ? "ALL PASS" : "FAILURES"} ===`);
process.exit(failures === 0 ? 0 : 1);
