import { z } from "zod";
import { requireWorkspaceContext } from "../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../lib/api/http";
import { isValidIanaTimeZone } from "../../lib/server/time-zone";

const schema = z.object({
  brandId: z.uuid(),
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/),
  addressLine1: z.string().trim().min(2).max(160),
  city: z.string().trim().min(2).max(100),
  region: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(2).max(20),
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  timezone: z.string().trim().min(3).max(80).refine(isValidIanaTimeZone, "Choose a valid IANA timezone."),
});

export async function POST(request: Request) {
  try {
    const { supabase, membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const input = schema.parse(await readJson(request));
    const { data: brand } = await supabase
      .from("ia_brands")
      .select("id")
      .eq("id", input.brandId)
      .eq("workspace_id", membership.workspace_id)
      .eq("is_active", true)
      .maybeSingle();
    if (!brand) throw new HttpError(404, "The selected brand was not found.", "brand_not_found");

    const { data, error } = await supabase.rpc("ia_create_location", {
      p_brand_id: input.brandId,
      p_name: input.name,
      p_import_code: input.code.toLowerCase(),
      p_street_address: input.addressLine1,
      p_city: input.city,
      p_region: input.region,
      p_postal_code: input.postalCode,
      p_country_code: input.countryCode,
      p_time_zone: input.timezone,
    });
    if (error) {
      if (error.code === "23505") throw new HttpError(409, "That location name or code is already in use.", "location_exists");
      throw new HttpError(400, "The location could not be added.", "location_create_failed");
    }

    return jsonOk(data, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
