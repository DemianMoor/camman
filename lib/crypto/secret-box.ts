import crypto from "node:crypto";

// AES-256-GCM secret box for provider credentials at rest.
// Blob format: "v1.<b64url(iv)>.<b64url(ciphertext)>.<b64url(authTag)>"
const VERSION = "v1";
const IV_LENGTH = 12;
const ALGORITHM = "aes-256-gcm";

function getMasterKey(): Buffer {
  const raw = process.env.PROVIDER_CREDENTIALS_KEY;
  if (!raw) {
    throw new Error("PROVIDER_CREDENTIALS_KEY is not set");
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `PROVIDER_CREDENTIALS_KEY must decode to 32 bytes, got ${key.length}`
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const key = getMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    authTag.toString("base64url"),
  ].join(".");
}

export function decryptSecret(blob: string): string {
  const parts = blob.split(".");
  if (parts.length !== 4) {
    throw new Error("Malformed secret-box blob: expected 4 segments");
  }
  const [version, ivB64, ciphertextB64, authTagB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unknown secret-box version: ${version}`);
  }
  const key = getMasterKey();
  const iv = Buffer.from(ivB64, "base64url");
  const ciphertext = Buffer.from(ciphertextB64, "base64url");
  const authTag = Buffer.from(authTagB64, "base64url");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
