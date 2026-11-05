import { readFileSync } from "node:fs";

// Source guard (partner postbacks, `invalid` event): lib/drip/enrichment.ts must
// queue the invalid postback INSIDE the landline branch, after the counters and
// BEFORE the inbox row is deleted — the row's id is the postback's event_id, and
// a call after the DELETE (or outside the branch) would silently stop reporting
// landlines, or report voip/unknown leads as invalid (G19). A behaviour test
// calling enqueueInvalidPostback directly stays green either way. Whole-line
// comments are dropped first so prose cannot satisfy or trip the check.

const FILE = "lib/drip/enrichment.ts";
const src = readFileSync(FILE, "utf8")
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

let failures = 0;
const bar = (label: string, ok: boolean) => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
};

const CALL = "tryEnqueueInvalidPostback(";
const start = src.indexOf(`if (lineType === "landline") {`);
const end = start === -1 ? -1 : src.indexOf("continue;", start);
const block = start === -1 || end === -1 ? "" : src.slice(start, end);
const bump = block.indexOf("bumpIntakeCounters(");
const call = block.indexOf(CALL);
const del = block.indexOf("DELETE FROM lead_inbox");

bar(`${FILE} has the landline branch`, block !== "");
bar("the landline branch calls tryEnqueueInvalidPostback", call !== -1);
bar("…after bumpIntakeCounters", bump !== -1 && call > bump);
bar("…before DELETE FROM lead_inbox", del !== -1 && call !== -1 && call < del);
bar("tryEnqueueInvalidPostback is called nowhere else in the file", src.split(CALL).length - 1 === 1);

if (failures > 0) process.exit(1);
