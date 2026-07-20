import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const ENVELOPE_PREFIX = "ia-secret-v1";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export type SecretCryptoErrorCode =
  | "invalid_key"
  | "invalid_secret"
  | "invalid_context"
  | "invalid_envelope"
  | "decrypt_failed";

export class SecretCryptoError extends Error {
  readonly code: SecretCryptoErrorCode;

  constructor(code: SecretCryptoErrorCode, message: string) {
    super(message);
    this.name = "SecretCryptoError";
    this.code = code;
  }
}

export type WriteOnlySecretRecord = {
  encryptedValue: string;
  maskedHint: string;
  encryptionVersion: 1;
};

function decodeBase64Key(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, "base64");
  const canonicalInput = value.replace(/=+$/, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");
  return canonicalInput === canonicalDecoded ? decoded : null;
}

/** Accept a 32-byte key encoded as standard base64 or 64 hexadecimal characters. */
export function decodeEncryptionKey(encodedKey: string): Buffer {
  const value = String(encodedKey ?? "").trim();
  const decoded = /^[a-fA-F0-9]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : decodeBase64Key(value);

  if (!decoded || decoded.byteLength !== 32) {
    throw new SecretCryptoError(
      "invalid_key",
      "The application encryption key must encode exactly 32 bytes.",
    );
  }

  return decoded;
}

function validateContext(context: string): string {
  const normalized = String(context ?? "").trim();
  if (!normalized || normalized.length > 512) {
    throw new SecretCryptoError(
      "invalid_context",
      "A bounded workspace/provider context is required for secret encryption.",
    );
  }
  return normalized;
}

export function maskSecret(secret: string): string {
  const value = String(secret ?? "");
  if (value.length <= 4) return "••••";
  return `•••• ${value.slice(-4)}`;
}

/**
 * Encrypt a server credential with AES-256-GCM. The caller must bind the
 * ciphertext to a stable context such as workspace/provider/credential name.
 */
export function encryptSecret(secret: string, encodedKey: string, context: string): string {
  const plaintext = String(secret ?? "");
  if (!plaintext.trim()) {
    throw new SecretCryptoError("invalid_secret", "A non-empty secret is required.");
  }

  const key = decodeEncryptionKey(encodedKey);
  const aad = Buffer.from(validateContext(context), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    ENVELOPE_PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(envelope: string, encodedKey: string, context: string): string {
  const key = decodeEncryptionKey(encodedKey);
  const aad = Buffer.from(validateContext(context), "utf8");
  const parts = String(envelope ?? "").split(".");

  if (parts.length !== 4 || parts[0] !== ENVELOPE_PREFIX) {
    throw new SecretCryptoError("invalid_envelope", "The stored secret envelope is invalid.");
  }

  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const ciphertext = Buffer.from(parts[3], "base64url");
    if (iv.byteLength !== IV_BYTES || tag.byteLength !== AUTH_TAG_BYTES || ciphertext.byteLength === 0) {
      throw new Error("invalid envelope lengths");
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretCryptoError(
      "decrypt_failed",
      "The stored credential could not be decrypted with the configured key and context.",
    );
  }
}

export function createWriteOnlySecretRecord(
  secret: string,
  encodedKey: string,
  context: string,
): WriteOnlySecretRecord {
  return {
    encryptedValue: encryptSecret(secret, encodedKey, context),
    maskedHint: maskSecret(secret),
    encryptionVersion: 1,
  };
}

/**
 * Produce a keyed, context-bound rotation fingerprint without storing a
 * reusable hash of the provider credential.
 */
export function fingerprintSecret(secret: string, encodedKey: string, context: string): string {
  const plaintext = String(secret ?? "");
  if (!plaintext.trim()) {
    throw new SecretCryptoError("invalid_secret", "A non-empty secret is required.");
  }
  const key = decodeEncryptionKey(encodedKey);
  const normalizedContext = validateContext(context);
  return createHmac("sha256", key)
    .update(normalizedContext, "utf8")
    .update("\0", "utf8")
    .update(plaintext, "utf8")
    .digest("hex");
}
