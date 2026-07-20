import { z } from "zod";
import { requireLocationAccess, requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk } from "../../../lib/api/http";
import { dashboardPeriodBounds, parseDateOnly } from "../../../lib/period-selection";

export const dynamic = "force-dynamic";

const periodSchema = z.enum(["day", "week", "month", "quarter", "year"]);

export async function GET(request: Request) {
  try {
    const { supabase, user, membership } = await requireWorkspaceContext();
    const url = new URL(request.url);
    const period = periodSchema.parse((url.searchParams.get("period") || "week").toLocaleLowerCase());
    let anchor: string;
    try {
      anchor = parseDateOnly(url.searchParams.get("anchor") || new Date().toISOString().slice(0, 10));
    } catch {
      throw new HttpError(400, "Choose a real calendar date using YYYY-MM-DD.", "invalid_anchor");
    }
    const bounds = dashboardPeriodBounds(period, anchor);

    const { data: assignments, error: assignmentError } = await supabase
      .from("ia_user_location_assignments")
      .select("location_id")
      .eq("workspace_id", membership.workspace_id)
      .eq("user_id", user.id)
      .eq("is_active", true);
    if (assignmentError) throw new HttpError(500, "Your location access could not be loaded.", "assignments_unavailable");
    const allowed = new Set((assignments ?? []).map((assignment) => String(assignment.location_id)));
    const requested = (url.searchParams.get("locations") || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const locationIds = requested.length > 0 ? requested : [...allowed];
    if (locationIds.length === 0) {
      return jsonOk({
        rows: [],
        totals: { current: 0, previous: 0 },
        locationIds: [],
        selection: { period, anchor, ...bounds },
      });
    }
    requireLocationAccess(locationIds, allowed);

    const { data, error } = await supabase.rpc("ia_historical_dashboard", {
      p_anchor: anchor,
      p_location_ids: locationIds,
      p_period: period,
    });
    if (error) throw new HttpError(500, "Historical totals could not be calculated.", "history_unavailable");
    const rows = Array.isArray(data) ? data : [];
    const current = rows.reduce((sum, row) => sum + Number(row.current_quantity || 0), 0);
    const previous = rows.reduce((sum, row) => sum + Number(row.previous_quantity || 0), 0);
    const products = new Map<string, { id: string; name: string; current: number; previous: number }>();
    for (const row of rows) {
      const key = String(row.product_id);
      const existing = products.get(key) ?? { id: key, name: String(row.product_name), current: 0, previous: 0 };
      existing.current += Number(row.current_quantity || 0);
      existing.previous += Number(row.previous_quantity || 0);
      products.set(key, existing);
    }

    return jsonOk({
      rows,
      locationIds,
      selection: { period, anchor, ...bounds },
      totals: {
        current,
        previous,
        changePercent: previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null,
      },
      products: [...products.values()].sort((left, right) => right.current - left.current),
    });
  } catch (error) {
    return jsonError(error);
  }
}
