import { decryptSecret } from "./secret-crypto";
import type { EnvironmentSource } from "./env";

export type CredentialProvider = "supabase" | "resend" | "ai" | "github";
export type CredentialName = "secretKey" | "apiKey" | "token";

const ENVIRONMENT_FALLBACKS: Record<CredentialProvider, Partial<Record<CredentialName, string>>> = {
  supabase: { secretKey: "SUPABASE_SECRET_KEY" },
  resend: { apiKey: "RESEND_API_KEY" },
  ai: { apiKey: "AI_API_KEY" },
  github: { token: "GITHUB_FINE_GRAINED_TOKEN" },
};

export type StoredCredential = { encryptedValue: string };

export interface CredentialStore {
  readCredential(input: {
    workspaceId: string;
    provider: CredentialProvider;
    name: CredentialName;
  }): Promise<StoredCredential | null>;
}

export type ResolvedCredential = {
  value: string;
  source: "stored" | "environment";
};

export type CredentialResolutionErrorCode =
  | "invalid_request"
  | "unsupported_credential"
  | "stored_credential_unreadable"
  | "credential_missing";

export class CredentialResolutionError extends Error {
  readonly code: CredentialResolutionErrorCode;

  constructor(code: CredentialResolutionErrorCode, message: string) {
    super(message);
    this.name = "CredentialResolutionError";
    this.code = code;
  }
}

export function credentialEncryptionContext(
  workspaceId: string,
  provider: CredentialProvider,
  name: CredentialName,
): string {
  const workspace = String(workspaceId ?? "").trim();
  if (!workspace || !/^[A-Za-z0-9_-]{1,128}$/.test(workspace)) {
    throw new CredentialResolutionError("invalid_request", "A valid workspace identifier is required.");
  }
  return `inventory-auditor:${workspace}:${provider}:${name}`;
}

export async function resolveProviderCredential(input: {
  workspaceId: string;
  provider: CredentialProvider;
  name: CredentialName;
  store: CredentialStore;
  encryptionKey: string;
  environment?: EnvironmentSource;
}): Promise<ResolvedCredential> {
  const environmentVariable = ENVIRONMENT_FALLBACKS[input.provider]?.[input.name];
  if (!environmentVariable) {
    throw new CredentialResolutionError(
      "unsupported_credential",
      "That provider credential is not supported by the server resolver.",
    );
  }

  const context = credentialEncryptionContext(input.workspaceId, input.provider, input.name);
  const stored = await input.store.readCredential({
    workspaceId: input.workspaceId,
    provider: input.provider,
    name: input.name,
  });

  if (stored) {
    try {
      return {
        value: decryptSecret(stored.encryptedValue, input.encryptionKey, context),
        source: "stored",
      };
    } catch {
      throw new CredentialResolutionError(
        "stored_credential_unreadable",
        "The saved provider credential cannot be decrypted. Replace or rotate it before continuing.",
      );
    }
  }

  const fallback = String((input.environment ?? process.env)[environmentVariable] ?? "").trim();
  if (fallback) return { value: fallback, source: "environment" };

  throw new CredentialResolutionError(
    "credential_missing",
    `No ${input.provider} credential is configured for this workspace.`,
  );
}
