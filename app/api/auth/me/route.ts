import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { jsonError, jsonOk } from "../../../lib/api/http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) return jsonOk({ authenticated: false, membership: null });

    const { data: membership } = await supabase
      .from("ia_workspace_memberships")
      .select("id, workspace_id, role, status, email_enabled")
      .eq("user_id", data.user.id)
      .eq("status", "active")
      .maybeSingle();

    return jsonOk({
      authenticated: Boolean(membership),
      membership: membership || null,
      user: { id: data.user.id, email: data.user.email },
    });
  } catch (error) {
    return jsonError(error);
  }
}
