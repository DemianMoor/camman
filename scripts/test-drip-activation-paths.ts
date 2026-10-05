import { readdirSync, readFileSync } from "node:fs";

// Every path that can activate a campaign must type-gate the audience snapshot.
//
// ⭐ THE BUG THIS EXISTS FOR. A drip campaign has no audience at activation —
// leads arrive afterwards and the routing worker admits them one at a time.
// snapshotAudience freezes the recipients of a blast, and raises
// EmptyAudienceError when that comes to zero, which is correct for a blast and
// fatal for a drip campaign.
//
// PR #125 gated the create VALIDATOR and the status route. It missed the create
// ROUTE's own launch branch, so "Save as draft" then Activate worked while
// "Activate" on /campaigns/new returned
//   400 "The current filters yield zero contacts in the chosen segments".
// Two of three paths gated looks exactly like three of three until someone
// clicks the third.
//
// ⚠️ DIRECTION (R13). The gate must be a POSITIVE read of 'drip'. A negative
// test (`type !== "regular"`) would let a NULL or a future type skip the
// snapshot, which is the dangerous direction: a regular campaign launching to
// nobody.
//
// This is a source scan, so it proves the gate is present — not that the screen
// works. The browser run is in the PR.

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(p) : /\.ts$/.test(p) ? [p] : [];
  });
}

/** API routes that call snapshotAudience — i.e. can freeze an audience. */
function activationRoutes(): string[] {
  return walk("app/api").filter((f) => readFileSync(f, "utf8").includes("snapshotAudience("));
}

function main() {
  const routes = activationRoutes();
  console.log(`routes that snapshot an audience: ${routes.length}`);
  for (const r of routes) console.log(`  ${r}`);

  check("⭐ at least one route snapshots (the scan is not vacuous)", routes.length > 0, true);

  console.log("\n⭐ each one type-gates the snapshot with a POSITIVE 'drip' read:");
  const ungated: string[] = [];
  const negativeGate: string[] = [];
  for (const f of routes) {
    const src = readFileSync(f, "utf8");
    // a positive comparison against the literal 'drip'
    const positive = /(?:===\s*["']drip["'])|(?:["']drip["']\s*===)/.test(src);
    if (!positive) ungated.push(f);
    // a negative one is the dangerous direction
    if (/!==\s*["']drip["']/.test(src)) negativeGate.push(f);
  }
  check("⭐ no activation route is missing the gate", ungated, []);
  check("⭐ no activation route gates on `!== 'drip'` (wrong direction)", negativeGate, []);

  // ⭐ The create route is the one that regressed; assert its gate sits on the
  // launch branch specifically, not merely somewhere in the file.
  console.log("\n⭐ the create route gates the LAUNCH branch, not just the row write:");
  const create = readFileSync("app/api/campaigns/route.ts", "utf8");
  check("`!saveAsDraft && isDrip` branch exists",
        /!saveAsDraft\s*&&\s*isDrip/.test(create), true);
  check("isDrip is a positive read of input.type",
        /const\s+isDrip\s*=\s*input\.type\s*===\s*["']drip["']/.test(create), true);
  check("the drip branch activates without snapshotting",
        /!saveAsDraft\s*&&\s*isDrip[\s\S]{0,1400}?audience_snapshot_count:\s*0/.test(create), true);

  // And the status route keeps its own gate (PR #125) — the two must stay in
  // step, because they are the same decision reached by two routes.
  const status = readFileSync("app/api/campaigns/[campaignId]/status/route.ts", "utf8");
  check("the status route still gates on isDrip",
        /const\s+isDrip\s*=\s*c\.type\s*===\s*["']drip["']/.test(status), true);

  // The validator's half of PR #125.
  const validator = readFileSync("lib/validators/campaigns.ts", "utf8");
  check("the create validator still skips the group requirement for drip",
        /const\s+isDrip\s*=\s*data\.type\s*===\s*["']drip["']/.test(validator), true);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
