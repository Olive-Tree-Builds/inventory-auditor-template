import { createHash } from "node:crypto";
import { jsonError, jsonOk } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (token.length < 32 || token.length > 256) return jsonOk({ valid: false });
    const hash = createHash("sha256").update(token).digest("hex");
    const admin = createSupabaseAdminClient();
    const { data } = await admin
      .from("ia_invitations")
      .select("email, display_name, expires_at, accepted_at, revoked_at, ia_workspaces(name)")
      .eq("token_hash", `\\x${hash}`)
      .maybeSingle();
    const valid = Boolean(data && !data.accepted_at && !data.revoked_at && Date.parse(data.expires_at) > Date.now());
    if (!valid || !data) return jsonOk({ valid: false });
    return jsonOk({
      valid: true,
      email: String(data.email),
      displayName: String(data.display_name),
      expiresAt: String(data.expires_at),
      workspaceName: Array.isArray(data.ia_workspaces)
        ? String(data.ia_workspaces[0]?.name || "Inventory Auditor")
        : String((data.ia_workspaces as { name?: string } | null)?.name || "Inventory Auditor"),
    });
  } catch (error) {
    return jsonError(error);
  }
}
