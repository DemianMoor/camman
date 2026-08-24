import "./_env-preload";
import { readdirSync, readFileSync, statSync } from "node:fs";

import { bodyCarriesStop } from "@/lib/sends/opt-out-footer";

// The STOP-keyword predicate, and the corruption class that broke it.
//
// ⭐ WHAT HAPPENED. A scripted patch replaced the two `\b` word boundaries in the
// drip scheduler's STOP regex with literal BACKSPACE characters (0x08). The file
// compiled. `tsc` was clean, lint was clean, the line read correctly in the
// editor, in `sed`, and in the GitHub diff — a terminal renders 0x08 as nothing.
// The regex became /<BS>STOP<BS>/i, which cannot match any real text, so the
// opt-out gate refused every txr lead. It failed CLOSED, so nothing wrong was
// sent; nothing at all was sent either, and the only visible symptom was a
// counter.
//
// Two guards, because either alone is weak:
//   1. BEHAVIOUR — the predicate is exported and exercised on real bodies, so a
//      regex that cannot match fails a test instead of a production send.
//   2. BYTES — a repo-wide scan for control characters, because the whole point
//      of this class is that it is invisible to every review surface.

const SOURCE_GLOBS = ["lib", "app", "components", "scripts", "db"];

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e.startsWith(".")) continue;
    const full = `${dir}/${e}`;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(full);
  }
  return out;
}

function main() {
  console.log("1. the predicate, on bodies that actually ship:");
  const real =
    "LumZen: One jelly after lunch, cravings gone by dinner. Intro discount live this weekend only:\n" +
    "https://g.lumzen.co/r/AbCdEfG\nStop to END";
  check("⭐ a real drip body with the footer CARRIES stop", bodyCarriesStop(real), true);
  check("the same body without the link still carries it",
        bodyCarriesStop("LumZen: something:\nStop to END"), true);
  check("uppercase STOP", bodyCarriesStop("Reply STOP to opt out"), true);
  check("stop at the very end", bodyCarriesStop("text stop"), true);

  console.log("\n2. ⭐ the word boundaries are load-bearing:");
  check("⭐ 'stopped snacking' is NOT opt-out language",
        bodyCarriesStop("She ate dessert and stopped snacking completely."), false);
  check("'nonstop' is not either", bodyCarriesStop("nonstop savings"), false);
  check("a body with no footer at all", bodyCarriesStop("LumZen: buy now:"), false);
  check("empty", bodyCarriesStop(""), false);

  console.log("\n3. ⭐ no control characters anywhere in the source:");
  // Tabs, newlines and CR are legitimate; everything else in C0 is not.
  const bad = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of SOURCE_GLOBS) {
    for (const f of walk(root)) {
      scanned++;
      const text = readFileSync(f, "utf8");
      if (bad.test(text)) {
        const line = text.split("\n").findIndex((l) => bad.test(l)) + 1;
        offenders.push(`${f}:${line}`);
      }
    }
  }
  console.log(`        scanned ${scanned} source files`);
  check("⭐ zero files contain a C0 control character", offenders, []);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exitCode = 1;
}

main();
