import { z } from "zod";
import { requireWorkspaceContext } from "../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../lib/api/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  displayName: z.string().trim().min(1).max(120),
  username: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,39}$/),
  positionTitle: z.string().trim().max(120)
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "Position/title cannot contain control characters.")
    .nullable(),
}).strict();

export async function PATCH(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const { supabase, user } = await requireWorkspaceContext();
    const { data, error } = await supabase
      .from("ia_profiles")
      .update({
        display_name: input.displayName,
        username: input.username.toLocaleLowerCase(),
        position_title: input.positionTitle || null,
      })
      .eq("user_id", user.id)
      .select("user_id, email, username, display_name, position_title")
      .single();

    if (error) {
      if (error.code === "23505") {
        throw new HttpError(409, "That username is already in use.", "username_taken");
      }
      if (error.code === "23514" || error.code === "22P02") {
        throw new HttpError(400, "The profile details are invalid.", "invalid_profile");
      }
      throw new HttpError(500, "Your profile could not be saved.", "profile_save_failed");
    }

    return jsonOk({
      userId: String(data.user_id),
      email: String(data.email),
      username: String(data.username),
      displayName: String(data.display_name),
      positionTitle: data.position_title ? String(data.position_title) : "",
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
