import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError } from "./http";

export function safeWorkspaceSlug(value: string) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}

export type BootstrapInput = {
  workspaceName: string;
  username: string;
  displayName: string;
  timezone: string;
};

export async function authorizeOwnerBootstrap(
  admin: SupabaseClient,
  userId: string,
  input: BootstrapInput,
) {
  const { error } = await admin.rpc("ia_server_authorize_owner_bootstrap", {
    p_user_id: userId,
    p_display_name: input.displayName,
    p_workspace_name: input.workspaceName,
    p_workspace_slug: safeWorkspaceSlug(input.workspaceName),
    p_default_time_zone: input.timezone,
    p_username: input.username,
  });

  if (error) {
    if (/already|initialized|workspace exists|setup is closed/i.test(error.message)) {
      throw new HttpError(409, "This deployment already has an owner. Ask that owner for an invitation.", "setup_closed");
    }
    throw new HttpError(500, "The first-owner authorization could not be saved.", "bootstrap_authorization_failed");
  }
}

export async function bootstrapWorkspace(admin: SupabaseClient, userId: string) {
  const { data, error } = await admin.rpc("ia_server_bootstrap_workspace", {
    p_user_id: userId,
  });

  if (error) {
    if (/already|initialized|workspace exists/i.test(error.message)) {
      throw new HttpError(409, "This deployment already has an owner. Ask that owner for an invitation.", "setup_closed");
    }
    if (/authorization|expired|confirmed|not found/i.test(error.message)) {
      throw new HttpError(403, "This account is not authorized to create the first workspace.", "bootstrap_not_authorized");
    }
    throw new HttpError(500, "The first workspace could not be created.", "bootstrap_failed");
  }

  return { userId, workspace: data };
}
