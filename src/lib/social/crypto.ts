import "server-only";

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * Encryption for social access tokens (0118).
 *
 * A long-lived Meta Page token can post as the business for sixty days. That
 * is not a secret to keep in a text column beside the account name, where any
 * future query, log line or backup carries it in the clear.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt
 * rather than decrypting to something else. The stored form is
 * `v1.<iv>.<tag>.<ciphertext>`, all base64url — versioned so the scheme can
 * change later without guessing what an old row was.
 */

const VERSION = "v1";

/**
 * The key, derived from SOCIAL_TOKEN_KEY.
 *
 * scrypt rather than using the env var directly: the variable is a passphrase
 * somebody typed, not 32 bytes of entropy. A fixed salt is fine here — the
 * threat is a leaked database, not a rainbow table against one key.
 */
function key(): Buffer {
  const secret = process.env.SOCIAL_TOKEN_KEY?.trim();
  if (!secret) {
    throw new Error(
      "SOCIAL_TOKEN_KEY is not set — required before a social account can be connected.",
    );
  }
  return scryptSync(secret, "arc-social-tokens", 32);
}

export function isSocialCryptoConfigured(): boolean {
  return Boolean(process.env.SOCIAL_TOKEN_KEY?.trim());
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

/**
 * Decrypt, or null.
 *
 * Null rather than throwing: a rotated key, a truncated column or a row
 * written by an older scheme all mean "we can't post with this account", and
 * the publisher should say that plainly rather than crash a tick.
 */
export function decryptToken(stored: string | null): string | null {
  if (!stored) return null;
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(parts[1], "base64url"),
    );
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}
