import { z } from "zod";
import { requireLocationAccess, requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { loadCurrentForecastRequirements } from "../../../lib/server/supabase-email-delivery";
import { dashboardPeriodBounds, parseDateOnly } from "../../../lib/period-selection";

export const dynamic = "force-dynamic";
const periodSchema = z.enum(["day", "week", "month", "quarter", "year"]);

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const period = periodSchema.parse(url.searchParams.get("period") || "day");
    let anchor: string;
    try {
      anchor = parseDateOnly(url.searchParams.get("anchor") || new Date().toISOString().slice(0, 10));
    } catch {
      throw new HttpError(400, "Choose a real calendar date using YYYY-MM-DD.", "invalid_anchor");
    }
    const bounds = dashboardPeriodBounds(period, anchor);
    const requested = (url.searchParams.get("locations") || "").split(",").map((value) => value.trim()).filter(Boolean);
    if (!requested.length || requested.length > 20 || requested.some((value) => !z.uuid().safeParse(value).success)) {
      throw new HttpError(400, "Choose between one and twenty valid locations.", "invalid_locations");
    }
    const locationIds = [...new Set(requested)];
    const { supabase, user, membership } = await requireWorkspaceContext();
    const { data: assignments, error: assignmentError } = await supabase.from("ia_user_location_assignments").select("location_id")
      .eq("workspace_id", membership.workspace_id).eq("user_id", user.id).eq("is_active", true);
    if (assignmentError) throw new HttpError(500, "Your location access could not be checked.", "assignments_unavailable");
    requireLocationAccess(locationIds, new Set((assignments ?? []).map((row) => String(row.location_id))));

    const { data: locations, error: locationError } = await supabase.from("ia_locations")
      .select("id")
      .eq("workspace_id", membership.workspace_id)
      .eq("is_active", true)
      .in("id", locationIds);
    if (locationError || locations?.length !== locationIds.length) {
      throw new HttpError(403, "One or more locations are unavailable.", "location_access_denied");
    }
    let requirements;
    try {
      requirements = await loadCurrentForecastRequirements(createSupabaseAdminClient(), membership.workspace_id);
    } catch {
      return jsonOk({ runs: [], recommendations: [], missingLocationIds: locationIds, selection: { period, anchor, ...bounds } });
    }
    const runResults = await Promise.all(locations.map(async (location) => {
      let query = supabase.from("ia_forecast_runs")
        .select("id, brand_id, location_id, period_grouping, period_start, period_end, status, research_completed, policy_id, policy_version, policy_sha256, ai_provider, ai_model, warnings, generated_at, completed_at")
        .eq("workspace_id", membership.workspace_id)
        .eq("location_id", location.id)
        .eq("period_grouping", period)
        .eq("period_start", bounds.startDate)
        .eq("period_end", bounds.endDate)
        .eq("policy_revision_id", requirements.policyRevisionId)
        .in("status", ["complete", "baseline_only", "needs_review"]);
      if (requirements.historyWatermark) query = query.gte("created_at", requirements.historyWatermark);
      const result = await query.order("generated_at", { ascending: false }).limit(1).maybeSingle();
      return { locationId: String(location.id), ...result };
    }));
    if (runResults.some((result) => result.error)) {
      throw new HttpError(500, "Stored forecasts could not be loaded.", "forecasts_unavailable");
    }
    const missingLocationIds = runResults.filter((result) => !result.data).map((result) => result.locationId);
    if (missingLocationIds.length) return jsonOk({ runs: [], recommendations: [], missingLocationIds, selection: { period, anchor, ...bounds } });
    const runs = runResults.map((result) => result.data as Record<string, unknown>);
    if (!runs.length) return jsonOk({ runs: [], recommendations: [], selection: { period, anchor, ...bounds } });
    const runIds = runs.map((row) => String(row.id));
    const { data: itemRows, error: itemsError } = await supabase.from("ia_forecast_items")
      .select("id, forecast_run_id, location_id, product_id, baseline_quantity, adjustments, recommended_quantity, confidence, explanation")
      .eq("workspace_id", membership.workspace_id).in("forecast_run_id", runIds);
    const { data: sourceRows, error: sourcesError } = await supabase.from("ia_forecast_sources")
      .select("id, forecast_run_id, source_key, title, publisher, url, published_or_updated_date, accessed_at, fact_used")
      .eq("workspace_id", membership.workspace_id).in("forecast_run_id", runIds);
    if (itemsError || sourcesError) throw new HttpError(500, "Forecast details could not be loaded.", "forecast_details_unavailable");
    const productIds = [...new Set((itemRows ?? []).map((row) => String(row.product_id)))];
    const { data: products, error: productError } = await supabase.from("ia_products").select("id, name")
      .eq("workspace_id", membership.workspace_id).in("id", productIds);
    if (productError) throw new HttpError(500, "Forecast products could not be loaded.", "products_unavailable");
    const productNames = new Map((products ?? []).map((product) => [String(product.id), String(product.name)]));
    const responseRuns = runs.map((run) => {
      const runId = String(run.id);
      return {
        id: runId,
        brandId: String(run.brand_id),
        locationId: String(run.location_id),
        period: String(run.period_grouping),
        periodStart: String(run.period_start),
        periodEnd: String(run.period_end),
        status: String(run.status),
        researchCompleted: Boolean(run.research_completed),
        policyId: String(run.policy_id),
        policyVersion: String(run.policy_version),
        policySha256: String(run.policy_sha256),
        aiProvider: run.ai_provider ? String(run.ai_provider) : null,
        aiModel: run.ai_model ? String(run.ai_model) : null,
        warnings: Array.isArray(run.warnings) ? run.warnings : [],
        generatedAt: String(run.generated_at || run.completed_at),
        items: (itemRows ?? []).filter((item) => String(item.forecast_run_id) === runId).map((item) => ({
          id: String(item.id), productId: String(item.product_id), product: productNames.get(String(item.product_id)) || "Product",
          baselineQuantity: Number(item.baseline_quantity), recommendedQuantity: Number(item.recommended_quantity),
          confidence: String(item.confidence), explanation: String(item.explanation), adjustments: Array.isArray(item.adjustments) ? item.adjustments : [],
        })),
        sources: (sourceRows ?? []).filter((source) => String(source.forecast_run_id) === runId).map((source) => ({
          id: String(source.id), key: String(source.source_key), title: String(source.title), publisher: String(source.publisher), url: String(source.url),
          publishedOrUpdatedDate: source.published_or_updated_date ? String(source.published_or_updated_date) : null,
          accessedAt: String(source.accessed_at), factUsed: String(source.fact_used),
        })),
      };
    });
    return jsonOk({
      runs: responseRuns,
      recommendations: responseRuns.flatMap((run) => run.items.map((item) => ({ ...item, runId: run.id, locationId: run.locationId, status: run.status }))),
      selection: { period, anchor, ...bounds },
    });
  } catch (error) { return jsonError(error); }
}
