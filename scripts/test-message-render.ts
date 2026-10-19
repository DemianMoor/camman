// scripts/test-message-render.ts — pure suite for lib/messages (no DB).
// npx tsx scripts/test-message-render.ts
import { TAGS, findTags, findUnknownTokens } from "@/lib/messages/tags";

let fail = 0;
const bar = (n: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${n}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};
const eq = (n: string, got: unknown, want: unknown) =>
  bar(n, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("R1 — tag registry + normalizers");
const fn = TAGS.first_name.normalize;
eq("R1.1 ' JOSÉ ' → Jose", fn(" JOSÉ "), "Jose");
eq("R1.2 mary-jane → Mary-Jane", fn("mary-jane"), "Mary-Jane");
eq("R1.3 o'neil → O'Neil", fn("o'neil"), "O'Neil");
eq("R1.4 Ægir → Aegir", fn("Ægir"), "Aegir");
eq("R1.5 Zoë → Zoe", fn("Zoë"), "Zoe");
eq("R1.6 李雷 → null", fn("李雷"), null);
eq("R1.7 N/A → null", fn("N/A"), null);
eq("R1.8 '-' → null", fn("-"), null);
eq("R1.9 Jo3 → null", fn("Jo3"), null);
eq("R1.10 J → null", fn("J"), null);
eq("R1.11 16 chars → null", fn("Maximilianuslong"), null);
eq("R1.12 15 chars kept", fn("Maximilianuslon"), "Maximilianuslon");
eq("R1.13 '' → null", fn(""), null);
eq("R1.14 null → null", fn(null), null);
eq("R1.15 Unknown/none junk", [fn("Unknown"), fn(" NONE ")], [null, null]);

const zip = TAGS.zip.normalize;
eq("R1.16 02134", zip("02134"), "02134");
eq("R1.17 ZIP+4 dashed", zip("02134-1234"), "02134");
eq("R1.18 ZIP+4 plain", zip("021341234"), "02134");
eq("R1.19 4 digits → null", zip("2134"), null);

const st = TAGS.state.normalize;
eq("R1.20 tx → TX", st("tx"), "TX");
eq("R1.21 Texas → TX", st("Texas"), "TX");
eq("R1.22 'new  york' → NY", st("new  york"), "NY");
eq("R1.23 ZZ → null", st("ZZ"), null);
eq("R1.24 Unknown → null", st("Unknown"), null);
eq("R1.25 DC", st("District of Columbia"), "DC");

eq("R1.26 findTags distinct, first-seen", findTags("Hi {first_name}, {FirstName} {zip} {first_name}"), ["first_name", "zip"]);
eq("R1.27 findUnknownTokens", findUnknownTokens("Hi {first_name}, {FirstName} {zip} {url}"), ["{FirstName}"]);
eq("R1.28 spaced token is not a tag", findTags("{ first_name }"), []);
eq("R1.29 worst cases per spec A1", [TAGS.first_name.worstCase.length, TAGS.zip.worstCase, TAGS.state.worstCase, TAGS.brand.worstCase.length], [15, "00000", "XX", 20]);

console.log(fail === 0 ? "\nALL GREEN" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
