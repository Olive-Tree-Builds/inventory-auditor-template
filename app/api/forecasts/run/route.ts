import { z } from "zod";
import { requireLocationAccess, requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { AnalysisPolicyUnavailableError } from "../../../lib/server/analysis-policy";
import { buildForecastResearchArea } from "../../../lib/server/forecast-provider";
import { runWorkspaceForecasts } from "../../../lib/server/forecast-runner";
import { dashboardPeriodBounds, parseDateOnly } from "../../../lib/period-selection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  period: z.enum(["day", "week", "month", "quarter", "year"]),
  anchor: z.string(),
  locationIds: z.array(z.uuid()).min(1).max(20),
}).strict();

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    let anchor: string;
    try {
      anchor = parseDateOnly(input.anchor);
    } catch {
      throw new HttpError(400, "Choose a real calendar date using YYYY-MM-DD.", "invalid_anchor");
    }
    const periodOverride = dashboardPeriodBounds(input.period, anchor);
    const locationIds = [...new Set(input.locationIds)];
    if (locationIds.length !== input.locationIds.length) throw new HttpError(400, "Choose each location once.", "duplicate_location");
    const { supabase, user, membership } = await requireWorkspaceContext(["super_admin", "admin", "manager"]);
    const { data: assignments, error: assignmentError } = await supabase
      .from("ia_user_location_assignments").select("location_id")
      .eq("workspace_id", membership.workspace_id).eq("user_id", user.id).eq("is_active", true);
    if (assignmentError) throw new HttpError(500, "Your location access could not be checked.", "assignments_unavailable");
    requireLocationAccess(locationIds, new Set((assignments ?? []).map((row) => String(row.location_id))));
    const { data: locations, error } = await supabase
      .from("ia_locations")
      .select("id, brand_id, name, time_zone, street_address, city, region, postal_code, country_code")
      .eq("workspace_id", membership.workspace_id).eq("is_active", true).in("id", locationIds);
    if (error || locations?.length !== locationIds.length) throw new HttpError(403, "One or more locations are unavailable.", "location_access_denied");
    const brandIds = [...new Set(locations.map((location) => String(location.brand_id)))];
    const { data: brands, error: brandError } = await supabase
      .from("ia_brands")
      .select("id, name")
      .eq("workspace_id", membership.workspace_id)
      .is("archived_at", null)
      .in("id", brandIds);
    if (brandError || brands?.length !== brandIds.length) {
      throw new HttpError(403, "One or more location brands are unavailable.", "location_access_denied");
    }
    const brandNames = new Map(brands.map((brand) => [String(brand.id), String(brand.name)]));
    const encryptionKey = String(process.env.APP_SECRET_ENCRYPTION_KEY || "").trim();
    if (!encryptionKey) throw new HttpError(503, "The app encryption key is not configured.", "encryption_key_unavailable");
    const runs = await runWorkspaceForecasts({
      supabase,
      admin: createSupabaseAdminClient(),
      workspaceId: membership.workspace_id,
      locations: locations.map((location) => {
        const streetAddress = typeof location.street_address === "string" && location.street_address.trim()
          ? location.street_address.trim()
          : null;
        const city = String(location.city || "").trim();
        const region = typeof location.region === "string" && location.region.trim() ? location.region.trim() : null;
        const postalCode = typeof location.postal_code === "string" && location.postal_code.trim()
          ? location.postal_code.trim()
          : null;
        const countryCode = String(location.country_code || "").trim().toLocaleUpperCase();
        return {
          id: String(location.id),
          brand_id: String(location.brand_id),
          brand_name: brandNames.get(String(location.brand_id)) || "",
          name: String(location.name),
          time_zone: String(location.time_zone),
          street_address: streetAddress,
          city,
          region,
          postal_code: postalCode,
          country_code: countryCode,
          research_area: buildForecastResearchArea({
            streetAddress,
            city,
            region,
            postalCode,
            countryCode,
          }),
        };
      }),
      grouping: input.period,
      periodOverride,
      encryptionKey,
      actorUserId: user.id,
    });
    return jsonOk({ accepted: true, receipts: runs });
  } catch (error) {
    if (error instanceof AnalysisPolicyUnavailableError) {
      return jsonError(new HttpError(409, error.message, error.code));
    }
    if (error instanceof Error && /Open Configuration|Analysis Skill|no imported product history|Historical data/.test(error.message)) {
      return jsonError(new HttpError(409, error.message, "forecast_not_ready"));
    }
    return jsonError(error);
  }
}
