import type { SupabaseClient, User } from "@supabase/supabase-js";
import { HttpError } from "./http";
import { createSupabaseServerClient } from "../supabase/server";

export type WorkspaceRole = "super_admin" | "admin" | "manager" | "viewer";

export type RequestContext = {
  supabase: SupabaseClient;
  user: User;
  membership: {
    id: string;
    workspace_id: string;
    role: WorkspaceRole;
    status: string;
    email_enabled: boolean;
  };
};

export async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) {
    throw new HttpError(401, "Sign in to continue.", "not_authenticated");
  }
  return { supabase, user: data.user };
}

export async function requireWorkspaceContext(
  allowedRoles?: readonly WorkspaceRole[],
): Promise<RequestContext> {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .from("ia_workspace_memberships")
    .select("id, workspace_id, role, status, email_enabled")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (error) throw new HttpError(500, "Your workspace access could not be checked.", "membership_lookup_failed");
  if (!data) throw new HttpError(403, "Your account is not assigned to this workspace.", "membership_required");

  const membership = data as RequestContext["membership"];
  if (allowedRoles && !allowedRoles.includes(membership.role)) {
    throw new HttpError(403, "You do not have permission to perform this action.", "insufficient_role");
  }

  return { supabase, user, membership };
}

export function requireLocationAccess(locationIds: readonly string[], allowedLocationIds: ReadonlySet<string>) {
  const denied = locationIds.find((locationId) => !allowedLocationIds.has(locationId));
  if (denied) {
    throw new HttpError(403, "One or more requested locations are not assigned to your account.", "location_access_denied");
  }
}
