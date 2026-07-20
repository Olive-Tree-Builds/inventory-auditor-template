import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { isValidIanaTimeZone } from "../../../lib/server/time-zone";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/),
  addressLine1: z.string().trim().min(2).max(160),
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(2).max(20),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  timezone: z.string().trim().min(3).max(80).refine(isValidIanaTimeZone, "Choose a valid IANA timezone."),
  active: z.boolean(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict();

export async function PATCH(
  request: Request,
  context: { params: Promise<{ locationId: string }> },
) {
  try {
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { locationId } = await context.params;
    const parsedLocationId = z.uuid().safeParse(locationId);
    if (!parsedLocationId.success) throw new HttpError(400, "Choose a valid location.", "invalid_location");
    const input = schema.parse(await readJson(request));

    const { data, error } = await supabase.rpc("ia_update_location", {
      p_location_id: parsedLocationId.data,
      p_name: input.name,
      p_import_code: input.code.toLowerCase(),
      p_street_address: input.addressLine1,
      p_city: input.city,
      p_region: input.region,
      p_postal_code: input.postalCode,
      p_country_code: input.countryCode,
      p_time_zone: input.timezone,
      p_is_active: input.active,
      p_expected_updated_at: input.expectedUpdatedAt,
    });
    if (error) {
      if (error.code === "IA409") {
        throw new HttpError(409, "Someone else changed this location while you were editing it. Reload the page and try again.", "location_stale");
      }
      if (error.code === "P0002") throw new HttpError(404, "The location was not found.", "location_not_found");
      if (error.code === "23505") throw new HttpError(409, "That location name or code is already in use.", "location_exists");
      if (error.code === "23514" || /inactive brand/i.test(error.message)) {
        throw new HttpError(409, "Reactivate the brand before reactivating this location.", "brand_inactive");
      }
      if (error.code === "42501") throw new HttpError(403, "You do not have permission to edit this location.", "location_update_denied");
      throw new HttpError(400, "The location could not be saved.", "location_update_failed");
    }

    return jsonOk(data);
  } catch (error) {
    return jsonError(error);
  }
}
