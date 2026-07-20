import { z } from "zod";
import { requireWorkspaceContext } from "../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../lib/api/http";
import { createSupabaseAdminClient } from "../../lib/supabase/admin";
import { resolveProviderCredential } from "../../lib/server/credential-resolver";
import { GitHubAnalysisSkillClient, GitHubSkillError } from "../../lib/server/github-analysis-skill";
import { SupabaseCredentialStore } from "../../lib/server/supabase-credential-store";
import { activateAnalysisPolicy, verifyAnalysisPolicy } from "../../lib/server/analysis-policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const updateSchema = z.object({
  markdown: z.string().min(1).max(512_000),
  expectedSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  commitMessage: z.string().trim().min(1).max(160),
}).strict();

async function githubClient(workspaceId: string) {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("ia_provider_connections")
    .select("repository_owner, repository_name, repository_branch")
    .eq("workspace_id", workspaceId)
    .eq("provider_kind", "github")
    .maybeSingle();
  if (error) throw new HttpError(500, "GitHub settings could not be loaded.", "github_settings_failed");
  const owner = String(data?.repository_owner || process.env.GITHUB_OWNER || "").trim();
  const repository = String(data?.repository_name || process.env.GITHUB_REPOSITORY || "").trim();
  const branch = String(data?.repository_branch || process.env.GITHUB_BRANCH || "").trim();
  const encryptionKey = String(process.env.APP_SECRET_ENCRYPTION_KEY || "").trim();
  if (!owner || !repository || branch !== "trunk" || !encryptionKey) {
    throw new HttpError(503, "Connect GitHub under Keys before using the Analysis Skill editor.", "github_not_configured");
  }
  const credential = await resolveProviderCredential({
    workspaceId,
    provider: "github",
    name: "token",
    store: new SupabaseCredentialStore(admin),
    encryptionKey,
  });
  return {
    admin,
    client: new GitHubAnalysisSkillClient({ owner, repository, branch: "trunk", token: credential.value }),
  };
}

function mapGitHubError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof GitHubSkillError) {
    const status = error.code === "conflict" ? 409 : error.code === "invalid_policy" || error.code === "invalid_configuration" ? 400 : 502;
    throw new HttpError(status, error.message, `github_${error.code}`);
  }
  throw error;
}

export async function GET() {
  try {
    const { membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { admin, client } = await githubClient(membership.workspace_id);
    const document = await client.read();
    const policy = verifyAnalysisPolicy(document.content);
    const { data: state, error: stateError } = await admin
      .from("ia_workspace_analysis_state")
      .select("active_policy_revision_id")
      .eq("workspace_id", membership.workspace_id)
      .maybeSingle();
    if (stateError) throw new HttpError(500, "The active Analysis Skill could not be checked.", "analysis_state_failed");
    const activeRevisionId = state?.active_policy_revision_id ? String(state.active_policy_revision_id) : null;
    let isActive = false;
    if (activeRevisionId) {
      const { data: revision, error: revisionError } = await admin
        .from("ia_analysis_policy_revisions")
        .select("sha256, repository_blob_sha")
        .eq("workspace_id", membership.workspace_id)
        .eq("id", activeRevisionId)
        .maybeSingle();
      if (revisionError) throw new HttpError(500, "The active Analysis Skill could not be checked.", "analysis_state_failed");
      isActive = Boolean(
        revision?.sha256 === policy.sha256 &&
        (!revision.repository_blob_sha || revision.repository_blob_sha === document.sha),
      );
    }
    return jsonOk({
      markdown: policy.markdown,
      sha: document.sha,
      htmlUrl: document.htmlUrl,
      isActive,
      activePolicyRevisionId: activeRevisionId,
    });
  } catch (error) {
    try { mapGitHubError(error); } catch (mapped) { return jsonError(mapped); }
  }
}

export async function PUT(request: Request) {
  try {
    const { user, membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const input = updateSchema.parse(await readJson(request, 600_000));
    const policy = verifyAnalysisPolicy(input.markdown);
    const { admin, client } = await githubClient(membership.workspace_id);
    const current = await client.read();
    if (current.sha !== input.expectedSha) {
      throw new HttpError(409, "ANALYSIS_SKILL.md changed after you opened it. Reload and review the current file before activating.", "github_conflict");
    }
    const currentPolicy = verifyAnalysisPolicy(current.content);
    const result = currentPolicy.markdown === policy.markdown
      ? { document: current, commitSha: null }
      : await client.update({
          expectedSha: input.expectedSha,
          markdown: policy.markdown,
          commitMessage: input.commitMessage,
        });
    const policyRevisionId = await activateAnalysisPolicy({
      admin, workspaceId: membership.workspace_id, actorUserId: user.id, policy,
      repositoryCommitSha: result.commitSha, repositoryBlobSha: result.document.sha,
    });
    return jsonOk({ markdown: policy.markdown, sha: result.document.sha, htmlUrl: result.document.htmlUrl, commitSha: result.commitSha, policyRevisionId });
  } catch (error) {
    try { mapGitHubError(error); } catch (mapped) { return jsonError(mapped); }
  }
}
