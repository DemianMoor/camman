// Verifies stages.delete is manager+ only. Pure function test, no DB.
// Run: npx tsx scripts/test-stages-delete-perm.ts
import "./_env-preload";
import { can } from "@/lib/permissions";

let ok = true;
function check(name: string, cond: boolean) { console.log((cond ? "  ✓ " : "  ✗ ") + name); if (!cond) ok = false; }

check("viewer cannot", !can("viewer", "stages.delete"));
check("operator cannot", !can("operator", "stages.delete"));
check("manager can", can("manager", "stages.delete"));
check("admin can", can("admin", "stages.delete"));
check("owner can", can("owner", "stages.delete"));

console.log(ok ? "\nAll passed." : "\nFAILED.");
process.exit(ok ? 0 : 1);
