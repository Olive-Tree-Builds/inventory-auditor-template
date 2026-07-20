import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  role: z.enum(["super_admin", "admin", "manager", "viewer"]),
  status: z.enum(["active", "suspended"]),
  emailEnabled: z.boolean(),
  locationIds: z.array(z.uuid()).max(100),
}).strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ membershipId: string }> },
) {
  try {
    const input = schema.parse(await readJson(request));
    const { membershipId } = await context.params;
    const parsedMembershipId = z.uuid().parse(membershipId);
    const locationIds = [...new Set(input.locationIds)];
    if (input.status === "active" && locationIds.length === 0) {
      throw new HttpError(400, "An active user must have at least one location.", "location_required");
    }

    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { data, error } = await supabase.rpc("ia_update_member", {
      p_membership_id: parsedMembershipId,
      p_role: input.role,
      p_status: input.status,
      p_email_enabled: input.emailEnabled,
      p_location_ids: locationIds,
    });
    if (error) {
      if (/final super admin/i.test(error.message)) {
        throw new HttpError(409, "The final super admin cannot be demoted or suspended.", "final_super_admin");
      }
      if (/cannot manage|permission|administrator/i.test(error.message)) {
        throw new HttpError(403, "You cannot change this workspace member.", "member_update_denied");
      }
      throw new HttpError(400, "The user settings could not be saved.", "member_update_failed");
    }

    return jsonOk({ membershipId: String(data) });
  } catch (error) {
    return jsonError(error);
  }
}
