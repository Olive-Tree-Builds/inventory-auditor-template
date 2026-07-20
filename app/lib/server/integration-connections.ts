import type { SupabaseClient } from "@supabase/supabase-js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import {
  CredentialResolutionError,
  credentialEncryptionContext,
  resolveProviderCredential,
  type CredentialName,
  type CredentialStore,
} from "./credential-resolver";
import type { EnvironmentSource } from "./env";
import { GitHubAnalysisSkillClient, GitHubSkillError } from "./github-analysis-skill";
import {
  createWriteOnlySecretRecord,
  fingerprintSecret,
  maskSecret,
} from "./secret-crypto";

export const integrationProviderSchema = z.enum(["resend", "ai", "github"]);
export type IntegrationProvider = z.infer<typeof integrationProviderSchema>;
export const INTEGRATION_ADMIN_ROLES = ["super_admin", "admin"] as const;

/** A small, testable sequencing guard for every service-role integration path. */
export async function authorizeBeforeServiceRole<TContext, TService>(input: {
  authorize: () => Promise<TContext>;
  createService: (context: TContext) => TService;
}): Promise<{ context: TContext; service: TService }> {
  const context = await input.authorize();
  return { context, service: input.createService(context) };
}

function isUnsafeIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function isUnsafeIpAddress(address: string): boolean {
  const normalized = address.toLocaleLowerCase().split("%")[0];
  const family = isIP(normalized);
  if (family === 4) return isUnsafeIpv4(normalized);
  if (family !== 6) return true;
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    return isIP(mapped) !== 4 || isUnsafeIpv4(mapped);
  }
  return (
    normalized === "::" || normalized === "::1" ||
    normalized.startsWith("fc") || normalized.startsWith("fd") ||
    /^fe[89ab]/.test(normalized) || normalized.startsWith("ff")
  );
}

function isUnsafeHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" || normalized === "metadata.google.internal" ||
    normalized.endsWith(".localhost") || normalized.endsWith(".local") ||
    normalized.endsWith(".internal") || normalized.endsWith(".lan") ||
    (isIP(normalized) > 0 && isUnsafeIpAddress(normalized))
  );
}

function isSecureProviderUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && !isUnsafeHostname(url.hostname)
    );
  } catch {
    return false;
  }
}

const secretSchema = z.string()
  .min(8, "Enter the complete provider credential.")
  .max(4_096, "The provider credential is too long.")
  .refine((value) => value === value.trim(), "Remove spaces before or after the provider credential.")
  .optional();

const senderEmailSchema = z.string().trim().email().max(320);
const providerNameSchema = z.string().trim().min(1).max(80);
const modelNameSchema = z.string().trim().min(1).max(160);
const baseUrlSchema = z.string().trim().max(500)
  .refine(isSecureProviderUrl, "Use a public HTTPS provider URL without credentials, query text, or a fragment.")
  .transform((value) => value.replace(/\/+$/, ""));
const repositoryPartSchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/);

const resendSaveSchema = z.object({
  apiKey: secretSchema,
  senderEmail: senderEmailSchema,
}).strict();

const aiSaveSchema = z.object({
  apiKey: secretSchema,
  providerName: providerNameSchema,
  modelName: modelNameSchema,
  baseUrl: baseUrlSchema,
}).strict();

const githubSaveSchema = z.object({
  token: secretSchema,
  repositoryOwner: repositoryPartSchema,
  repositoryName: repositoryPartSchema,
  repositoryBranch: z.literal("trunk"),
}).strict();

export type ParsedProviderSaveInput =
  | ({ provider: "resend" } & z.infer<typeof resendSaveSchema>)
  | ({ provider: "ai" } & z.infer<typeof aiSaveSchema>)
  | ({ provider: "github" } & z.infer<typeof githubSaveSchema>);

export type ProviderConfiguration =
  | { provider: "resend"; senderEmail: string }
  | { provider: "ai"; providerName: string; modelName: string; baseUrl: string }
  | { provider: "github"; repositoryOwner: string; repositoryName: string; repositoryBranch: "trunk" };

export function parseProviderSaveInput(
  provider: IntegrationProvider,
  input: unknown,
): ParsedProviderSaveInput {
  if (provider === "resend") return { provider, ...resendSaveSchema.parse(input) };
  if (provider === "ai") return { provider, ...aiSaveSchema.parse(input) };
  return { provider, ...githubSaveSchema.parse(input) };
}

function configurationFromSave(input: ParsedProviderSaveInput): ProviderConfiguration {
  if (input.provider === "resend") {
    return { provider: "resend", senderEmail: input.senderEmail };
  }
  if (input.provider === "ai") {
    return {
      provider: "ai",
      providerName: input.providerName,
      modelName: input.modelName,
      baseUrl: input.baseUrl,
    };
  }
  return {
    provider: "github",
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    repositoryBranch: input.repositoryBranch,
  };
}

function newSecretFromSave(input: ParsedProviderSaveInput): string | undefined {
  return input.provider === "github" ? input.token : input.apiKey;
}

function credentialName(provider: IntegrationProvider): CredentialName {
  return provider === "github" ? "token" : "apiKey";
}

export type ProviderConnectionRecord = {
  id: string;
  workspaceId: string;
  provider: IntegrationProvider;
  providerName: string | null;
  baseUrl: string | null;
  modelName: string | null;
  senderEmail: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  repositoryBranch: string | null;
  status: "unconfigured" | "untested" | "connected" | "failing" | "disabled";
  maskedHint: string | null;
  secretVersion: number;
  lastTestedAt: string | null;
  lastTestResult: "passed" | "failed" | null;
  lastErrorCode: string | null;
  updatedAt: string;
};

export type PublicProviderConnection = {
  provider: IntegrationProvider;
  configured: boolean;
  status: ProviderConnectionRecord["status"];
  credentialSource: "stored" | "environment" | null;
  maskedHint: string | null;
  lastTestedAt: string | null;
  lastTestResult: ProviderConnectionRecord["lastTestResult"];
  lastErrorCode: string | null;
  configuration: Omit<ProviderConfiguration, "provider"> | null;
};

export interface IntegrationConnectionRepository {
  list(workspaceId: string): Promise<ProviderConnectionRecord[]>;
  recordTest(input: {
    workspaceId: string;
    actorUserId: string;
    provider: IntegrationProvider;
    configuration: ProviderConfiguration | null;
    expected: { id: string; secretVersion: number; updatedAt: string } | null;
    passed: boolean;
    errorCode: string | null;
  }): Promise<ProviderConnectionRecord>;
}

export interface ProviderConnectionStore extends CredentialStore {
  saveProviderConnection(input: {
    workspaceId: string;
    provider: IntegrationProvider;
    actorUserId: string;
    status: ProviderConnectionRecord["status"];
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
  }): Promise<string>;
}

export type IntegrationConnectionErrorCode = "credential_rotation_required";

export class IntegrationConnectionError extends Error {
  constructor(
    public readonly code: IntegrationConnectionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IntegrationConnectionError";
  }
}

export class IntegrationRepositoryError extends Error {
  readonly code = "integration_storage_failed";

  constructor(message = "Provider connection settings could not be stored.") {
    super(message);
    this.name = "IntegrationRepositoryError";
  }
}

const CONNECTION_COLUMNS = [
  "id",
  "workspace_id",
  "provider_kind",
  "provider_name",
  "base_url",
  "model_name",
  "sender_email",
  "repository_owner",
  "repository_name",
  "repository_branch",
  "status",
  "masked_hint",
  "secret_version",
  "last_tested_at",
  "last_test_result",
  "last_error_code",
  "updated_at",
].join(", ");

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function normalizeConnection(row: Record<string, unknown>): ProviderConnectionRecord {
  const provider = integrationProviderSchema.parse(row.provider_kind);
  const status = z.enum(["unconfigured", "untested", "connected", "failing", "disabled"]).parse(row.status);
  const lastTestResult = row.last_test_result === null || row.last_test_result === undefined
    ? null
    : z.enum(["passed", "failed"]).parse(row.last_test_result);
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    provider,
    providerName: nullableString(row.provider_name),
    baseUrl: nullableString(row.base_url),
    modelName: nullableString(row.model_name),
    senderEmail: nullableString(row.sender_email),
    repositoryOwner: nullableString(row.repository_owner),
    repositoryName: nullableString(row.repository_name),
    repositoryBranch: nullableString(row.repository_branch),
    status,
    maskedHint: nullableString(row.masked_hint),
    secretVersion: z.number().int().nonnegative().parse(row.secret_version),
    lastTestedAt: nullableString(row.last_tested_at),
    lastTestResult,
    lastErrorCode: nullableString(row.last_error_code),
    updatedAt: z.string().min(1).parse(row.updated_at),
  };
}

function configurationColumns(configuration: ProviderConfiguration): Record<string, unknown> {
  if (configuration.provider === "resend") {
    return {
      provider_name: "resend",
      sender_email: configuration.senderEmail,
      base_url: null,
      model_name: null,
      repository_owner: null,
      repository_name: null,
      repository_branch: null,
    };
  }
  if (configuration.provider === "ai") {
    return {
      provider_name: configuration.providerName,
      base_url: configuration.baseUrl,
      model_name: configuration.modelName,
      sender_email: null,
      repository_owner: null,
      repository_name: null,
      repository_branch: null,
    };
  }
  return {
    provider_name: "github",
    base_url: null,
    model_name: null,
    sender_email: null,
    repository_owner: configuration.repositoryOwner,
    repository_name: configuration.repositoryName,
    repository_branch: configuration.repositoryBranch,
  };
}

function connectionMetadata(configuration: ProviderConfiguration): {
  providerName: string | null;
  baseUrl: string | null;
  modelName: string | null;
  senderEmail: string | null;
  repositoryOwner: string | null;
  repositoryName: string | null;
  repositoryBranch: string | null;
} {
  if (configuration.provider === "resend") {
    return {
      providerName: "resend",
      baseUrl: null,
      modelName: null,
      senderEmail: configuration.senderEmail,
      repositoryOwner: null,
      repositoryName: null,
      repositoryBranch: null,
    };
  }
  if (configuration.provider === "ai") {
    return {
      providerName: configuration.providerName,
      baseUrl: configuration.baseUrl,
      modelName: configuration.modelName,
      senderEmail: null,
      repositoryOwner: null,
      repositoryName: null,
      repositoryBranch: null,
    };
  }
  return {
    providerName: "github",
    baseUrl: null,
    modelName: null,
    senderEmail: null,
    repositoryOwner: configuration.repositoryOwner,
    repositoryName: configuration.repositoryName,
    repositoryBranch: configuration.repositoryBranch,
  };
}

export class SupabaseIntegrationConnectionRepository implements IntegrationConnectionRepository {
  constructor(private readonly client: SupabaseClient) {}

  async list(workspaceId: string): Promise<ProviderConnectionRecord[]> {
    const { data, error } = await this.client
      .from("ia_provider_connections")
      .select(CONNECTION_COLUMNS)
      .eq("workspace_id", workspaceId)
      .order("provider_kind");
    if (error) throw new IntegrationRepositoryError("Provider connection settings could not be loaded.");
    try {
      return ((data ?? []) as unknown as Array<Record<string, unknown>>).map(normalizeConnection);
    } catch {
      throw new IntegrationRepositoryError("Provider connection settings contain an invalid record.");
    }
  }

  async recordTest(input: {
    workspaceId: string;
    actorUserId: string;
    provider: IntegrationProvider;
    configuration: ProviderConfiguration | null;
    expected: { id: string; secretVersion: number; updatedAt: string } | null;
    passed: boolean;
    errorCode: string | null;
  }): Promise<ProviderConnectionRecord> {
    const mutableFields = {
      ...(input.configuration ? configurationColumns(input.configuration) : {}),
      status: input.passed ? "connected" : "failing",
      last_tested_at: new Date().toISOString(),
      last_test_result: input.passed ? "passed" : "failed",
      last_error_code: input.passed ? null : input.errorCode,
      updated_by: input.actorUserId,
    };
    const result = input.expected
      ? await this.client
        .from("ia_provider_connections")
        .update(mutableFields)
        .eq("workspace_id", input.workspaceId)
        .eq("provider_kind", input.provider)
        .eq("id", input.expected.id)
        .eq("secret_version", input.expected.secretVersion)
        .eq("updated_at", input.expected.updatedAt)
        .select(CONNECTION_COLUMNS)
        .single()
      : await this.client
        .from("ia_provider_connections")
        .insert({
        workspace_id: input.workspaceId,
        provider_kind: input.provider,
          ...mutableFields,
        })
        .select(CONNECTION_COLUMNS)
        .single();
    const { data, error } = result;
    if (error || !data) throw new IntegrationRepositoryError("The provider test result could not be stored.");
    try {
      const connection = normalizeConnection(data as unknown as Record<string, unknown>);
      const { error: auditError } = await this.client.from("ia_audit_events").insert({
        workspace_id: input.workspaceId,
        actor_user_id: input.actorUserId,
        event_type: "provider_connection.tested",
        entity_type: "provider_connection",
        entity_id: connection.id,
        outcome: input.passed ? "success" : "failed",
        metadata: {
          provider_kind: input.provider,
          result: input.passed ? "passed" : "failed",
          ...(input.errorCode ? { error_code: input.errorCode } : {}),
        },
      });
      if (auditError) throw new IntegrationRepositoryError("The provider test audit event could not be stored.");
      return connection;
    } catch {
      throw new IntegrationRepositoryError("The provider test result could not be verified.");
    }
  }
}

const ENVIRONMENT_SECRET_NAMES: Record<IntegrationProvider, string> = {
  resend: "RESEND_API_KEY",
  ai: "AI_API_KEY",
  github: "GITHUB_FINE_GRAINED_TOKEN",
};

function envValue(environment: EnvironmentSource, name: string): string {
  return String(environment[name] ?? "").trim();
}

type CredentialSource = "stored" | "environment" | null;

function credentialSource(
  provider: IntegrationProvider,
  row: ProviderConnectionRecord | undefined,
  environment: EnvironmentSource,
): CredentialSource {
  if (row?.maskedHint) return "stored";
  return envValue(environment, ENVIRONMENT_SECRET_NAMES[provider]) ? "environment" : null;
}

function savedConfiguration(
  provider: IntegrationProvider,
  row: ProviderConnectionRecord | undefined,
): ProviderConfiguration | null {
  if (!row) return null;
  try {
    if (provider === "resend") {
      return {
        provider,
        senderEmail: senderEmailSchema.parse(row.senderEmail),
      };
    }
    if (provider === "ai") {
      return {
        provider,
        providerName: providerNameSchema.parse(row.providerName),
        modelName: modelNameSchema.parse(row.modelName),
        baseUrl: baseUrlSchema.parse(row.baseUrl),
      };
    }
    return {
      provider,
      repositoryOwner: repositoryPartSchema.parse(row.repositoryOwner),
      repositoryName: repositoryPartSchema.parse(row.repositoryName),
      repositoryBranch: z.literal("trunk").parse(row.repositoryBranch),
    };
  } catch {
    return null;
  }
}

function environmentConfiguration(
  provider: IntegrationProvider,
  environment: EnvironmentSource,
): ProviderConfiguration | null {
  try {
    if (provider === "resend") {
      return { provider, senderEmail: senderEmailSchema.parse(envValue(environment, "RESEND_FROM_EMAIL")) };
    }
    if (provider === "ai") {
      return {
        provider,
        providerName: providerNameSchema.parse(envValue(environment, "AI_PROVIDER")),
        modelName: modelNameSchema.parse(envValue(environment, "AI_MODEL")),
        baseUrl: baseUrlSchema.parse(envValue(environment, "AI_BASE_URL")),
      };
    }
    return {
      provider,
      repositoryOwner: repositoryPartSchema.parse(envValue(environment, "GITHUB_OWNER")),
      repositoryName: repositoryPartSchema.parse(envValue(environment, "GITHUB_REPOSITORY")),
      repositoryBranch: z.literal("trunk").parse(envValue(environment, "GITHUB_BRANCH")),
    };
  } catch {
    return null;
  }
}

/** Keep each hidden credential paired to the settings under which it was supplied. */
function boundConfiguration(
  provider: IntegrationProvider,
  row: ProviderConnectionRecord | undefined,
  environment: EnvironmentSource,
): ProviderConfiguration | null {
  const source = credentialSource(provider, row, environment);
  if (source === "stored") return savedConfiguration(provider, row);
  if (source === "environment") {
    if (provider === "resend") {
      return savedConfiguration(provider, row) ?? environmentConfiguration(provider, environment);
    }
    return environmentConfiguration(provider, environment);
  }
  return null;
}

function assertReusableCredentialBinding(input: {
  provider: IntegrationProvider;
  configuration: ProviderConfiguration;
  row: ProviderConnectionRecord | undefined;
  environment: EnvironmentSource;
}): CredentialSource {
  const source = credentialSource(input.provider, input.row, input.environment);
  if (input.provider === "resend") return source;
  void input.configuration;
  throw new IntegrationConnectionError(
    "credential_rotation_required",
    `Enter the ${input.provider === "ai" ? "AI API key" : "GitHub token"} again whenever saving these settings.`,
  );
}

function safeErrorCode(value: string | null): string | null {
  if (!value) return null;
  return /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "provider_test_failed";
}

function publicConnection(
  provider: IntegrationProvider,
  row: ProviderConnectionRecord | undefined,
  environment: EnvironmentSource,
): PublicProviderConnection {
  const savedMask = row?.maskedHint || null;
  const environmentSecret = envValue(environment, ENVIRONMENT_SECRET_NAMES[provider]);
  const source = credentialSource(provider, row, environment);
  const configuration = boundConfiguration(provider, row, environment)
    ?? savedConfiguration(provider, row)
    ?? environmentConfiguration(provider, environment);
  const configured = Boolean(source && boundConfiguration(provider, row, environment));
  const status = row?.status === "disabled"
    ? "disabled"
    : configured
      ? row?.status ?? "untested"
      : "unconfigured";
  const { provider: _provider, ...publicConfiguration } = configuration ?? { provider };
  void _provider;

  return {
    provider,
    configured,
    status,
    credentialSource: source,
    maskedHint: savedMask || (environmentSecret ? maskSecret(environmentSecret) : null),
    lastTestedAt: row?.lastTestedAt ?? null,
    lastTestResult: row?.lastTestResult ?? null,
    lastErrorCode: safeErrorCode(row?.lastErrorCode ?? null),
    configuration: configuration ? publicConfiguration : null,
  };
}

export function summarizeProviderConnections(
  rows: readonly ProviderConnectionRecord[],
  environment: EnvironmentSource = process.env,
): PublicProviderConnection[] {
  const byProvider = new Map(rows.map((row) => [row.provider, row]));
  return (["resend", "ai", "github"] as const).map((provider) => (
    publicConnection(provider, byProvider.get(provider), environment)
  ));
}

export type ProviderTestErrorCode =
  | "configuration_incomplete"
  | "credential_missing"
  | "credential_unreadable"
  | "unsafe_endpoint"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "provider_unavailable"
  | "network_error"
  | "invalid_response";

export class ProviderConnectionTestError extends Error {
  readonly code: ProviderTestErrorCode;

  constructor(code: ProviderTestErrorCode, message = "The provider connection test failed.") {
    super(message);
    this.name = "ProviderConnectionTestError";
    this.code = code;
  }
}

function responseErrorCode(status: number): ProviderTestErrorCode {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  return "provider_unavailable";
}

function timedFetcher(fetcher: typeof fetch, timeoutMs = 12_000): typeof fetch {
  return async (input, init = {}) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return fetcher(input, { ...init, signal, redirect: "error" });
  };
}

export type ProviderHostResolver = (hostname: string) => Promise<readonly string[]>;

export const resolveProviderHost: ProviderHostResolver = async (hostname) => (
  await lookup(hostname, { all: true, verbatim: true })
).map((entry) => entry.address);

export async function assertPublicProviderHost(
  baseUrl: string,
  resolver: ProviderHostResolver,
): Promise<void> {
  const url = new URL(baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isUnsafeHostname(hostname)) throw new ProviderConnectionTestError("unsafe_endpoint");
  if (isIP(hostname) > 0) return;

  let addresses: readonly string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new ProviderConnectionTestError("network_error");
  }
  if (!addresses.length || addresses.some(isUnsafeIpAddress)) {
    throw new ProviderConnectionTestError("unsafe_endpoint");
  }
}

async function assertJsonProbe(
  fetcher: typeof fetch,
  url: string,
  credential: string,
): Promise<void> {
  let response: Response;
  try {
    response = await timedFetcher(fetcher)(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
      cache: "no-store",
    });
  } catch {
    throw new ProviderConnectionTestError("network_error");
  }
  if (!response.ok) throw new ProviderConnectionTestError(responseErrorCode(response.status));
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    throw new ProviderConnectionTestError("invalid_response");
  }
}

/**
 * Verify a least-privilege Resend Sending key without delivering a message.
 *
 * Resend intentionally rejects Sending-only keys on read endpoints such as
 * /domains. A deliberately incomplete request to the send endpoint reaches
 * the permission boundary, then must fail validation before an email can be
 * queued. The later "Send test to me" action remains the definitive sender
 * and delivery check.
 */
async function assertResendSendingCredential(
  fetcher: typeof fetch,
  credential: string,
): Promise<void> {
  let response: Response;
  try {
    response = await timedFetcher(fetcher)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "inventory-auditor/1.0",
      },
      body: "{}",
      cache: "no-store",
    });
  } catch {
    throw new ProviderConnectionTestError("network_error");
  }

  if (response.status !== 400 && response.status !== 422) {
    if (!response.ok) {
      throw new ProviderConnectionTestError(responseErrorCode(response.status));
    }
    throw new ProviderConnectionTestError("invalid_response");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    throw new ProviderConnectionTestError("invalid_response");
  }
  const name = "name" in payload && typeof payload.name === "string" ? payload.name : null;
  if (name !== "missing_required_field" && name !== "validation_error") {
    throw new ProviderConnectionTestError("invalid_response");
  }
}

/** Non-destructive provider probes. No email is sent and no AI generation is created. */
export async function testProviderConnection(input: {
  configuration: ProviderConfiguration;
  credential: string;
  fetch?: typeof fetch;
  resolveHost?: ProviderHostResolver;
}): Promise<void> {
  const fetcher = input.fetch ?? fetch;
  if (input.configuration.provider === "resend") {
    await assertResendSendingCredential(fetcher, input.credential);
    return;
  }
  if (input.configuration.provider === "ai") {
    await assertPublicProviderHost(
      input.configuration.baseUrl,
      input.resolveHost ?? resolveProviderHost,
    );
    await assertJsonProbe(
      fetcher,
      `${input.configuration.baseUrl.replace(/\/+$/, "")}/models`,
      input.credential,
    );
    return;
  }

  try {
    await new GitHubAnalysisSkillClient({
      owner: input.configuration.repositoryOwner,
      repository: input.configuration.repositoryName,
      branch: input.configuration.repositoryBranch,
      token: input.credential,
      fetch: timedFetcher(fetcher),
    }).read();
  } catch (error) {
    if (error instanceof GitHubSkillError) {
      if (error.status) throw new ProviderConnectionTestError(responseErrorCode(error.status));
      throw new ProviderConnectionTestError(error.code === "invalid_response" ? "invalid_response" : "network_error");
    }
    throw new ProviderConnectionTestError("network_error");
  }
}

function testFailureCode(error: unknown): ProviderTestErrorCode | null {
  if (error instanceof ProviderConnectionTestError) return error.code;
  if (error instanceof CredentialResolutionError) {
    if (error.code === "credential_missing") return "credential_missing";
    if (error.code === "stored_credential_unreadable") return "credential_unreadable";
    return "configuration_incomplete";
  }
  return null;
}

export type IntegrationServiceDependencies = {
  repository: IntegrationConnectionRepository;
  credentialStore: ProviderConnectionStore;
  encryptionKey: string;
  environment?: EnvironmentSource;
  fetch?: typeof fetch;
  resolveHost?: ProviderHostResolver;
};

export class IntegrationConnectionService {
  private readonly environment: EnvironmentSource;

  constructor(private readonly dependencies: IntegrationServiceDependencies) {
    this.environment = dependencies.environment ?? process.env;
  }

  async list(workspaceId: string): Promise<PublicProviderConnection[]> {
    return summarizeProviderConnections(await this.dependencies.repository.list(workspaceId), this.environment);
  }

  async save(input: {
    workspaceId: string;
    actorUserId: string;
    provider: IntegrationProvider;
    body: unknown;
  }): Promise<PublicProviderConnection> {
    const parsed = parseProviderSaveInput(input.provider, input.body);
    const configuration = configurationFromSave(parsed);
    const secret = newSecretFromSave(parsed);
    const name = credentialName(input.provider);
    const rows = await this.dependencies.repository.list(input.workspaceId);
    const row = rows.find((candidate) => candidate.provider === input.provider);
    let writeOnlyRecord: ReturnType<typeof createWriteOnlySecretRecord> | null = null;
    let fingerprint: string | null = null;

    if (secret) {
      const context = credentialEncryptionContext(input.workspaceId, input.provider, name);
      writeOnlyRecord = createWriteOnlySecretRecord(secret, this.dependencies.encryptionKey, context);
      fingerprint = fingerprintSecret(secret, this.dependencies.encryptionKey, context);
    } else {
      const expectedSource = assertReusableCredentialBinding({
        provider: input.provider,
        configuration,
        row,
        environment: this.environment,
      });
      const resolved = await resolveProviderCredential({
        workspaceId: input.workspaceId,
        provider: input.provider,
        name,
        store: this.dependencies.credentialStore,
        encryptionKey: this.dependencies.encryptionKey,
        environment: this.environment,
      });
      if (resolved.source !== expectedSource) {
        throw new IntegrationConnectionError(
          "credential_rotation_required",
          "Enter the provider credential again before changing this connection.",
        );
      }
    }

    await this.dependencies.credentialStore.saveProviderConnection({
      workspaceId: input.workspaceId,
      provider: input.provider,
      actorUserId: input.actorUserId,
      status: "untested",
      metadata: connectionMetadata(configuration),
      ...(writeOnlyRecord && fingerprint ? {
        secret: {
          name,
          encryptedValue: writeOnlyRecord.encryptedValue,
          encryptionVersion: writeOnlyRecord.encryptionVersion,
          maskedHint: writeOnlyRecord.maskedHint,
          fingerprint,
        },
      } : {}),
    });

    const summary = await this.list(input.workspaceId);
    return summary.find((connection) => connection.provider === input.provider)!;
  }

  async test(input: {
    workspaceId: string;
    actorUserId: string;
    provider: IntegrationProvider;
  }): Promise<{
    passed: boolean;
    errorCode: ProviderTestErrorCode | null;
    connection: PublicProviderConnection;
  }> {
    const rows = await this.dependencies.repository.list(input.workspaceId);
    const row = rows.find((candidate) => candidate.provider === input.provider);
    const configuration = boundConfiguration(input.provider, row, this.environment);
    const expectedSource = credentialSource(input.provider, row, this.environment);
    let errorCode: ProviderTestErrorCode | null = null;

    if (!configuration) {
      errorCode = "configuration_incomplete";
    } else {
      try {
        const credential = await resolveProviderCredential({
          workspaceId: input.workspaceId,
          provider: input.provider,
          name: credentialName(input.provider),
          store: this.dependencies.credentialStore,
          encryptionKey: this.dependencies.encryptionKey,
          environment: this.environment,
        });
        if (credential.source !== expectedSource) {
          throw new ProviderConnectionTestError(
            expectedSource === "stored" ? "credential_unreadable" : "configuration_incomplete",
          );
        }
        await testProviderConnection({
          configuration,
          credential: credential.value,
          fetch: this.dependencies.fetch,
          resolveHost: this.dependencies.resolveHost,
        });
      } catch (error) {
        const normalized = testFailureCode(error);
        if (!normalized) throw error;
        errorCode = normalized;
      }
    }

    const passed = errorCode === null;
    await this.dependencies.repository.recordTest({
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      provider: input.provider,
      configuration,
      expected: row ? {
        id: row.id,
        secretVersion: row.secretVersion,
        updatedAt: row.updatedAt,
      } : null,
      passed,
      errorCode,
    });
    const summary = await this.list(input.workspaceId);
    return {
      passed,
      errorCode,
      connection: summary.find((connection) => connection.provider === input.provider)!,
    };
  }
}
