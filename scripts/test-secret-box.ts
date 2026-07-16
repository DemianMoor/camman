import assert from "node:assert";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-box";

// Requires PROVIDER_CREDENTIALS_KEY to be set in the environment.
function run() {
  // Round-trip
  const secret = "th_live_abcdef0123456789ABCDEF";
  const blob = encryptSecret(secret);
  assert.ok(blob.startsWith("v1."), `expected v1. prefix, got ${blob.slice(0, 8)}`);
  assert.strictEqual(decryptSecret(blob), secret, "round-trip must return the original");

  // Non-deterministic IV: two encryptions of the same plaintext differ
  assert.notStrictEqual(encryptSecret(secret), encryptSecret(secret), "IV must be random per call");

  // Tamper detection: flip a byte in the ciphertext segment → GCM auth fails
  const parts = blob.split(".");
  const tampered = [parts[0], parts[1], parts[2].slice(0, -2) + (parts[2].endsWith("A") ? "B" : "A"), parts[3]].join(".");
  assert.throws(() => decryptSecret(tampered), "tampered ciphertext must throw");

  // Unknown version prefix rejected
  assert.throws(() => decryptSecret("v2." + parts.slice(1).join(".")), "unknown version must throw");

  console.log("secret-box: all assertions passed");
}
run();
