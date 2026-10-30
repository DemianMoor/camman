import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Source guard: the SMS send path must never import the partner-postback module.
// Postbacks are queued by the drip-monitors cron from the conversion ledger and
// delivered by their own cron; a send-path import would couple a partner's URL
// (slow, flaky, third-party) to message sending. Comments are stripped first so a
// mention in prose cannot trip or hide the check.

const ROOTS = ["lib/sends"];
const FILES = ["lib/drip/send-one.ts", "lib/drip/scheduler.ts", "lib/drip/followups.ts"];
// Alias (@/lib/partners/postbacks) or any relative path ending in partners/postbacks[/...].
const IMPORT_RE = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)["'](?:@\/lib\/|(?:\.{1,2}\/)+(?:lib\/)?)?partners\/postbacks(?:\/[^"']*)?["']/;

const NL = String.fromCharCode(10);
const BS = String.fromCharCode(92);

function stripComments(src: string): string {
  // Small scanner so "//" inside a string or template literal is not mistaken for a comment.
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== NL) i++;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += c;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === BS) out += src[i++];
        out += src[i++] ?? "";
      }
      out += src[i++] ?? "";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...ROOTS.flatMap((r) => walk(r)), ...FILES];
let failures = 0;
for (const f of files) {
  const hit = IMPORT_RE.test(stripComments(readFileSync(f, "utf8")));
  if (hit) {
    failures++;
    console.log(`  FAIL  ${f} imports lib/partners/postbacks`);
  }
}
if (failures > 0) process.exit(1);
console.log(`  PASS  ${files.length} send-path files scanned, none import lib/partners/postbacks`);
