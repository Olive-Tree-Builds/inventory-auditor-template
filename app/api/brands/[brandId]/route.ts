import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { isValidIanaTimeZone } from "../../../lib/server/time-zone";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/),
  defaultTimeZone: z.string().trim().min(3).max(100).refine(isValidIanaTimeZone, "Choose a valid IANA timezone."),
  active: z.boolean(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ brandId: string }> },
) {
  try {
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { brandId } = await context.params;
    const parsedBrandId = z.uuid().safeParse(brandId);
    if (!parsedBrandId.success) throw new HttpError(400, "Choose a valid brand.", "invalid_brand");
    const input = schema.parse(await readJson(request));

    const { data, error } = await supabase.rpc("ia_update_brand", {
      p_brand_id: parsedBrandId.data,
      p_name: input.name,
      p_code: input.code.toLowerCase(),
      p_default_time_zone: input.defaultTimeZone,
      p_is_active: input.active,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (error.code === "IA409") {
        throw new HttpError(409, "Someone else changed this brand while you were editing it. Reload the page and try again.", "brand_stale");
      }
      if (error.code === "P0002") throw new HttpError(404, "The brand was not found.", "brand_not_found");
      if (error.code === "23505") throw new HttpError(409, "That brand name or code is already in use.", "brand_exists");
      if (error.code === "23514" || /active location/i.test(error.message)) {
        throw new HttpError(409, "Deactivate this brand's locations before deactivating the brand.", "brand_has_active_locations");
      }
      if (error.code === "42501") throw new HttpError(403, "You do not have permission to edit this brand.", "brand_update_denied");
      throw new HttpError(400, "The brand could not be saved.", "brand_update_failed");
    }

    return jsonOk(data);
  } catch (error) {
    return jsonError(error);
  }
}
