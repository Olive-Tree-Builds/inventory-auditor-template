import { createHash, timingSafeEqual } from "node:crypto";

export function ownerSetupSecretIsValid(value: string | null | undefined): boolean {
  const normalized = String(value ?? "").trim();
  return normalized.length >= 32 && normalized.length <= 4_096;
}

export function verifyOwnerSetupSecret(
  supplied: string | null | undefined,
  configured: string | null | undefined,
): boolean {
  const candidate = String(supplied ?? "").trim();
  const expected = String(configured ?? "").trim();
  if (!ownerSetupSecretIsValid(candidate) || !ownerSetupSecretIsValid(expected)) return false;
  return timingSafeEqual(
    createHash("sha256").update(candidate).digest(),
    createHash("sha256").update(expected).digest(),
  );
}
