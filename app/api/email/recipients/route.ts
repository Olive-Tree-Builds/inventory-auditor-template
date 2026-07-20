import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  recipientId: z.uuid().nullable().optional(),
  scheduleId: z.uuid(),
  email: z.string().trim().email().max(320),
  displayName: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  locationIds: z.array(z.uuid()).min(1).max(100),
}).strict();

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const locationIds = [...new Set(input.locationIds)];
    if (locationIds.length !== input.locationIds.length) {
      throw new HttpError(400, "Choose each location once.", "duplicate_location");
    }
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { data, error } = await supabase.rpc("ia_save_email_contact", {
      p_contact_id: input.recipientId ?? null,
      p_schedule_id: input.scheduleId,
      p_email: input.email.toLocaleLowerCase(),
      p_display_name: input.displayName,
      p_enabled: input.enabled,
      p_location_ids: locationIds,
    });
    if (error) {
      if (/pending workspace invitation/i.test(error.message)) {
        throw new HttpError(
          409,
          "That email has a pending user invitation. Revoke or finish the invitation before adding it as an email-only recipient.",
          "recipient_email_conflict",
        );
      }
      if (error.code === "23505" || /workspace user|already exists|duplicate/i.test(error.message)) {
        throw new HttpError(
          409,
          "That address is already a workspace user or additional recipient. Use its existing email setting instead.",
          "recipient_email_conflict",
        );
      }
      if (error.code === "42501") {
        throw new HttpError(403, "One or more selected locations are unavailable.", "location_access_denied");
      }
      if (error.code === "P0002") {
        throw new HttpError(404, "The email schedule or recipient was not found.", "recipient_not_found");
      }
      throw new HttpError(400, "The email recipient could not be saved.", "recipient_save_failed");
    }
    return jsonOk({ recipientId: String(data) });
  } catch (error) {
    return jsonError(error);
  }
}
