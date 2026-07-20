import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseAnalysisSkill } from "../analysis-skill.mjs";
import { resolveProviderCredential } from "./credential-resolver";
import type { EnvironmentSource } from "./env";
import {
  GitHubAnalysisSkillClient,
  type AnalysisSkillDocument,
  validateAnalysisSkillForGitHub,
} from "./github-analysis-skill";
import {
  SupabaseIntegrationConnectionRepository,
  summarizeProviderConnections,
} from "./integration-connections";
import { SupabaseCredentialStore } from "./supabase-credential-store";

export type VerifiedAnalysisPolicy = {
  markdown: string;
  sha256: string;
  policyId: string;
  policyVersion: string;
  outputSchemaVersion: string;
  activeVariableRevision: number;
  activeVariables: Array<{ id: string; name: string }>;
};

export type ActiveAnalysisPolicyRecord = {
  id: string;
  policy_id: string;
  policy_version: string;
  output_schema_version: string;
  active_variable_revision: number;
  markdown_content: string;
  active_variables: unknown;
  sha256: string;
  repository_blob_sha: string | null;
};

export class AnalysisPolicyUnavailableError extends Error {
  readonly code = "policy_unavailable" as const;

  constructor(message = "The current Analysis Skill could not be verified. Reconnect GitHub or open Configuration → Analysis Skill, then try again.") {
    super(message);
    this.name = "AnalysisPolicyUnavailableError";
  }
}

function metadata(markdown: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.match(new RegExp(`^- ${escaped}:\\s*\\x60([^\\x60]+)\\x60\\s*$`, "m"))?.[1]?.trim() ?? null;
}

export function verifyAnalysisPolicy(markdown: string): VerifiedAnalysisPolicy {
  const normalized = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const parser = parseAnalysisSkill(normalized);
  const issues = [...parser.errors, ...validateAnalysisSkillForGitHub(normalized)];
  const policyId = metadata(normalized, "Policy ID");
  const outputSchemaVersion = metadata(normalized, "Output schema version");
  if (!policyId || !/^[a-z0-9][a-z0-9-]{1,99}$/.test(policyId)) issues.push("Policy ID metadata is invalid.");
  if (!outputSchemaVersion || !/^\d+\.\d+$/.test(outputSchemaVersion)) issues.push("Output schema version metadata is invalid.");
  if (issues.length) throw new Error(issues[0]);
  return {
    markdown: normalized,
    sha256: createHash("sha256").update(normalized, "utf8").digest("hex"),
    policyId: policyId!,
    policyVersion: parser.policyVersion!,
    outputSchemaVersion: outputSchemaVersion!,
    activeVariableRevision: Number(parser.activeVariableRevision),
    activeVariables: parser.variables,
  };
}

export async function activateAnalysisPolicy(input: {
  admin: SupabaseClient;
  workspaceId: string;
  actorUserId: string;
  policy: VerifiedAnalysisPolicy;
  repositoryCommitSha: string | null;
  repositoryBlobSha: string | null;
}): Promise<string> {
  const { data, error } = await input.admin.rpc("ia_server_activate_analysis_policy", {
    p_workspace_id: input.workspaceId,
    p_actor_user_id: input.actorUserId,
    p_policy_id: input.policy.policyId,
    p_policy_version: input.policy.policyVersion,
    p_output_schema_version: input.policy.outputSchemaVersion,
    p_active_variable_revision: input.policy.activeVariableRevision,
    p_markdown_content: input.policy.markdown,
    p_active_variables: input.policy.activeVariables,
    p_sha256: input.policy.sha256,
    p_repository_commit_sha: input.repositoryCommitSha,
    p_repository_blob_sha: input.repositoryBlobSha,
  });
  if (error || typeof data !== "string") throw new Error("The active Analysis Skill could not be recorded in Supabase.");
  return data;
}

function recordMatchesPolicy(
  record: ActiveAnalysisPolicyRecord,
  policy: VerifiedAnalysisPolicy,
  repositoryBlobSha: string,
): boolean {
  if (
    record.sha256 !== policy.sha256 ||
    record.markdown_content !== policy.markdown ||
    record.policy_id !== policy.policyId ||
    record.policy_version !== policy.policyVersion ||
    record.output_schema_version !== policy.outputSchemaVersion ||
    record.active_variable_revision !== policy.activeVariableRevision ||
    (record.repository_blob_sha !== null && record.repository_blob_sha !== repositoryBlobSha)
  ) return false;

  try {
    const stored = verifyAnalysisPolicy(record.markdown_content);
    return (
      stored.sha256 === record.sha256 &&
      stored.policyId === record.policy_id &&
      stored.policyVersion === record.policy_version &&
      stored.outputSchemaVersion === record.output_schema_version &&
      stored.activeVariableRevision === record.active_variable_revision &&
      JSON.stringify(stored.activeVariables) === JSON.stringify(record.active_variables)
    );
  } catch {
    return false;
  }
}

async function loadActivePolicyRecord(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<ActiveAnalysisPolicyRecord | null> {
  const { data: state, error: stateError } = await admin
    .from("ia_workspace_analysis_state")
    .select("active_policy_revision_id")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (stateError) throw new AnalysisPolicyUnavailableError();
  const activeRevisionId = typeof state?.active_policy_revision_id === "string"
    ? state.active_policy_revision_id
    : undefined;
  if (!activeRevisionId) return null;

  const { data, error } = await admin
    .from("ia_analysis_policy_revisions")
    .select("id, policy_id, policy_version, output_schema_version, active_variable_revision, markdown_content, active_variables, sha256, repository_blob_sha")
    .eq("workspace_id", workspaceId)
    .eq("id", activeRevisionId)
    .maybeSingle();
  if (error || !data) throw new AnalysisPolicyUnavailableError();
  return data as ActiveAnalysisPolicyRecord;
}

async function createRepositoryPolicyLoader(input: {
  admin: SupabaseClient;
  workspaceId: string;
  encryptionKey: string;
  environment: EnvironmentSource;
  fetch?: typeof fetch;
}): Promise<() => Promise<AnalysisSkillDocument>> {
  const repository = new SupabaseIntegrationConnectionRepository(input.admin);
  const github = summarizeProviderConnections(
    await repository.list(input.workspaceId),
    input.environment,
  ).find((connection) => connection.provider === "github");
  const configuration = github?.configuration as {
    repositoryOwner?: unknown;
    repositoryName?: unknown;
    repositoryBranch?: unknown;
  } | null | undefined;
  if (
    !github?.configured || github.status !== "connected" ||
    typeof configuration?.repositoryOwner !== "string" || !configuration.repositoryOwner ||
    typeof configuration.repositoryName !== "string" || !configuration.repositoryName ||
    configuration.repositoryBranch !== "trunk"
  ) {
    throw new AnalysisPolicyUnavailableError(
      "The GitHub Analysis Skill connection must be saved and tested before forecasting.",
    );
  }
  const credential = await resolveProviderCredential({
    workspaceId: input.workspaceId,
    provider: "github",
    name: "token",
    store: new SupabaseCredentialStore(input.admin),
    encryptionKey: input.encryptionKey,
    environment: input.environment,
  });
  const client = new GitHubAnalysisSkillClient({
    owner: configuration.repositoryOwner,
    repository: configuration.repositoryName,
    branch: "trunk",
    token: credential.value,
    fetch: input.fetch,
  });
  return () => client.read();
}

/**
 * Reconcile the database audit record with the current repository document.
 *
 * GitHub remains authoritative: a cached database revision is never used when
 * the repository cannot be read. A changed document is activated only with an
 * explicitly authorized administrator audit actor, then read back from GitHub
 * before the run may use it. Scheduled jobs therefore stop safely on a policy
 * mismatch until an administrator activates the repository revision.
 */
export async function reconcileAnalysisPolicy(input: {
  admin: SupabaseClient;
  workspaceId: string;
  encryptionKey: string;
  actorUserId?: string;
  environment?: EnvironmentSource;
  fetch?: typeof fetch;
  repositoryPolicyLoader?: () => Promise<AnalysisSkillDocument>;
}): Promise<ActiveAnalysisPolicyRecord> {
  let loadRepositoryPolicy: () => Promise<AnalysisSkillDocument>;
  try {
    loadRepositoryPolicy = input.repositoryPolicyLoader ?? await createRepositoryPolicyLoader({
      admin: input.admin,
      workspaceId: input.workspaceId,
      encryptionKey: input.encryptionKey,
      environment: input.environment ?? process.env,
      fetch: input.fetch,
    });
  } catch (error) {
    if (error instanceof AnalysisPolicyUnavailableError) throw error;
    throw new AnalysisPolicyUnavailableError();
  }

  let document: AnalysisSkillDocument;
  let repositoryPolicy: VerifiedAnalysisPolicy;
  try {
    document = await loadRepositoryPolicy();
    repositoryPolicy = verifyAnalysisPolicy(document.content);
  } catch {
    throw new AnalysisPolicyUnavailableError();
  }

  const active = await loadActivePolicyRecord(input.admin, input.workspaceId);
  if (active && recordMatchesPolicy(active, repositoryPolicy, document.sha)) return active;

  if (!input.actorUserId) {
    throw new AnalysisPolicyUnavailableError(
      "ANALYSIS_SKILL.md changed in GitHub and must be activated by an administrator before forecasting can continue.",
    );
  }

  let revisionId: string;
  try {
    revisionId = await activateAnalysisPolicy({
      admin: input.admin,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      policy: repositoryPolicy,
      repositoryCommitSha: null,
      repositoryBlobSha: document.sha,
    });
  } catch {
    throw new AnalysisPolicyUnavailableError(
      "The current GitHub Analysis Skill could not be activated. Open Configuration → Analysis Skill and resolve the policy version before forecasting.",
    );
  }

  let verifiedDocument: AnalysisSkillDocument;
  try {
    verifiedDocument = await loadRepositoryPolicy();
  } catch {
    throw new AnalysisPolicyUnavailableError();
  }
  if (verifiedDocument.sha !== document.sha || verifiedDocument.content !== document.content) {
    throw new AnalysisPolicyUnavailableError(
      "ANALYSIS_SKILL.md changed while forecasting was starting. Reload it before trying again.",
    );
  }

  const activated = await loadActivePolicyRecord(input.admin, input.workspaceId);
  if (
    !activated || activated.id !== revisionId ||
    !recordMatchesPolicy(activated, repositoryPolicy, document.sha)
  ) {
    throw new AnalysisPolicyUnavailableError();
  }
  return activated;
}
