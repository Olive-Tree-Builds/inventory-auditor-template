import { z } from "zod";
import { requireWorkspaceContext } from "../../../../lib/api/auth";
import { HttpError, jsonError, jsonOk } from "../../../../lib/api/http";

export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ recipientId: string }> },
) {
  try {
    const { recipientId } = await context.params;
    const parsedId = z.uuid().safeParse(recipientId);
    if (!parsedId.success) throw new HttpError(400, "Choose a valid email recipient.", "invalid_recipient");
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { data, error } = await supabase.rpc("ia_archive_email_contact", {
      p_contact_id: parsedId.data,
    });
    if (error) {
      if (error.code === "P0002") {
        throw new HttpError(404, "The email recipient was not found.", "recipient_not_found");
      }
      if (error.code === "42501") {
        throw new HttpError(403, "You do not have permission to archive this recipient.", "insufficient_role");
      }
      throw new HttpError(400, "The email recipient could not be archived.", "recipient_archive_failed");
    }
    return jsonOk({ recipientId: String(data), archived: true });
  } catch (error) {
    return jsonError(error);
  }
}
