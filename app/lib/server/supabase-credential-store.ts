import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  CredentialName,
  CredentialProvider,
  CredentialStore,
  StoredCredential,
} from "./credential-resolver";

const DATABASE_SECRET_NAMES: Record<CredentialName, string> = {
  secretKey: "secret_key",
  apiKey: "api_key",
  token: "token",
};

export type ProviderSecretStoreErrorCode =
  | "invalid_request"
  | "read_failed"
  | "invalid_record"
  | "write_failed";

export class ProviderSecretStoreError extends Error {
  readonly code: ProviderSecretStoreErrorCode;

  constructor(code: ProviderSecretStoreErrorCode, message: string) {
    super(message);
    this.name = "ProviderSecretStoreError";
    this.code = code;
  }
}

function assertWorkspaceId(workspaceId: string): string {
  const value = String(workspaceId ?? "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new ProviderSecretStoreError("invalid_request", "A valid workspace identifier is required.");
  }
  return value;
}

function assertDatabaseProvider(provider: CredentialProvider): Exclude<CredentialProvider, "supabase"> {
  if (provider === "resend" || provider === "ai" || provider === "github") return provider;
  throw new ProviderSecretStoreError("invalid_request", "That credential cannot be saved in the workspace store.");
}

function envelopeToBytea(encryptedValue: string): string {
  const value = String(encryptedValue ?? "");
  if (!value.startsWith("ia-secret-v1.") || value.length > 16_384) {
    throw new ProviderSecretStoreError("invalid_request", "The encrypted credential envelope is invalid.");
  }
  return `\\x${Buffer.from(value, "utf8").toString("hex")}`;
}

function byteaToEnvelope(input: unknown): string {
  if (typeof input !== "string" || !input) {
    throw new ProviderSecretStoreError("invalid_record", "The saved credential record is invalid.");
  }
  let value = input;
  if (value.startsWith("\\x")) {
    const hex = value.slice(2);
    if (!hex || hex.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(hex)) {
      throw new ProviderSecretStoreError("invalid_record", "The saved credential record is invalid.");
    }
    value = Buffer.from(hex, "hex").toString("utf8");
  }
  if (!value.startsWith("ia-secret-v1.") || value.length > 16_384) {
    throw new ProviderSecretStoreError("invalid_record", "The saved credential record is invalid.");
  }
  return value;
}

type ProviderSecretRow = {
  encrypted_value?: unknown;
  encryption_key_version?: unknown;
};

/**
 * Service-role adapter for the migration's narrow secret-envelope RPCs.
 * Callers must authenticate and authorize the workspace administrator before
 * constructing this adapter with a service-role Supabase client.
 */
export class SupabaseCredentialStore implements CredentialStore {
  constructor(private readonly client: SupabaseClient) {}

  async readCredential(input: {
    workspaceId: string;
    provider: CredentialProvider;
    name: CredentialName;
  }): Promise<StoredCredential | null> {
    const workspaceId = assertWorkspaceId(input.workspaceId);
    const provider = assertDatabaseProvider(input.provider);
    const { data, error } = await this.client.rpc("ia_server_get_provider_secret", {
      p_workspace_id: workspaceId,
      p_provider_kind: provider,
      p_secret_name: DATABASE_SECRET_NAMES[input.name],
    });
    if (error) {
      throw new ProviderSecretStoreError("read_failed", "The saved provider credential could not be read.");
    }
    const row = (Array.isArray(data) ? data[0] : data) as ProviderSecretRow | null | undefined;
    if (!row) return null;
    if (row.encryption_key_version !== 1) {
      throw new ProviderSecretStoreError("invalid_record", "The saved credential uses an unsupported encryption version.");
    }
    return { encryptedValue: byteaToEnvelope(row.encrypted_value) };
  }

  async saveProviderConnection(input: {
    workspaceId: string;
    provider: Exclude<CredentialProvider, "supabase">;
    actorUserId: string;
    status: "unconfigured" | "untested" | "connected" | "failing" | "disabled";
    metadata: {
      providerName: string | null;
      baseUrl: string | null;
      modelName: string | null;
      senderEmail: string | null;
      repositoryOwner: string | null;
      repositoryName: string | null;
      repositoryBranch: string | null;
    };
    secret?: {
      name: CredentialName;
      encryptedValue: string;
      encryptionVersion: number;
      maskedHint: string;
      fingerprint: string;
    };
  }): Promise<string> {
    const workspaceId = assertWorkspaceId(input.workspaceId);
    const provider = assertDatabaseProvider(input.provider);
    const secret = input.secret;
    if (secret && (secret.encryptionVersion !== 1 || !/^[a-f0-9]{64}$/i.test(secret.fingerprint))) {
      throw new ProviderSecretStoreError("invalid_request", "The encrypted credential metadata is invalid.");
    }
    if (secret && (!secret.maskedHint || secret.maskedHint.length > 16)) {
      throw new ProviderSecretStoreError("invalid_request", "The credential mask is invalid.");
    }

    const { data, error } = await this.client.rpc("ia_server_save_provider_connection", {
      p_workspace_id: workspaceId,
      p_provider_kind: provider,
      p_provider_name: input.metadata.providerName,
      p_base_url: input.metadata.baseUrl,
      p_model_name: input.metadata.modelName,
      p_sender_email: input.metadata.senderEmail,
      p_repository_owner: input.metadata.repositoryOwner,
      p_repository_name: input.metadata.repositoryName,
      p_repository_branch: input.metadata.repositoryBranch,
      p_status: input.status,
      p_secret_name: secret ? DATABASE_SECRET_NAMES[secret.name] : null,
      p_encrypted_value: secret ? envelopeToBytea(secret.encryptedValue) : null,
      p_encryption_key_version: secret?.encryptionVersion ?? null,
      p_masked_hint: secret?.maskedHint ?? null,
      p_secret_fingerprint: secret?.fingerprint ?? null,
      p_actor_user_id: input.actorUserId,
    });
    if (error || typeof data !== "string" || !data) {
      throw new ProviderSecretStoreError("write_failed", "The provider connection could not be saved.");
    }
    return data;
  }
}
