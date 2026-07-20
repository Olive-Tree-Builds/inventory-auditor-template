import { z } from "zod";
import { requireLocationAccess, requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { sendManualForecastEmails } from "../../../lib/server/manual-email-delivery";
import { EmailOperationError } from "../../../lib/server/supabase-email-delivery";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Choose a valid calendar date.");

const schema = z.object({
  locationIds: z.array(z.uuid()).min(1).max(20),
  periodStart: dateOnly,
  periodEnd: dateOnly,
  expectedRunIds: z.array(z.uuid()).min(1).max(20),
}).strict().superRefine((input, context) => {
  const start = new Date(`${input.periodStart}T00:00:00.000Z`);
  const end = new Date(`${input.periodEnd}T00:00:00.000Z`);
  const days = Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (days < 1 || days > 366) {
    context.addIssue({ code: "custom", path: ["periodEnd"], message: "Choose a period of one to 366 days." });
  }
});

function operationError(error: EmailOperationError): HttpError {
  if (["schedule_missing", "email_delivery_disabled", "forecast_missing", "forecast_invalid", "forecast_changed", "recipient_not_eligible", "recipient_has_no_locations", "recipient_collision", "recipient_scope_changed"].includes(error.code)) {
    return new HttpError(409, error.message, error.code);
  }
  if (["resend_not_configured", "resend_not_verified"].includes(error.code)) {
    return new HttpError(503, error.message, error.code);
  }
  if (error.code === "resend_send_failed") return new HttpError(502, error.message, error.code);
  return new HttpError(500, "The manual email could not be completed safely.", "manual_email_failed");
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const locationIds = [...new Set(input.locationIds)];
    const runIds = [...new Set(input.expectedRunIds)];
    if (locationIds.length !== input.locationIds.length || runIds.length !== input.expectedRunIds.length) {
      throw new HttpError(400, "Choose each location and forecast once.", "duplicate_scope_item");
    }

    const { supabase, user, membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { data: assignments, error: assignmentError } = await supabase
      .from("ia_user_location_assignments")
      .select("location_id")
      .eq("workspace_id", membership.workspace_id)
      .eq("user_id", user.id)
      .eq("is_active", true);
    if (assignmentError) {
      throw new HttpError(500, "Your location access could not be checked.", "assignments_unavailable");
    }
    requireLocationAccess(locationIds, new Set((assignments ?? []).map((row) => String(row.location_id))));

    const result = await sendManualForecastEmails({
      admin: createSupabaseAdminClient(),
      workspaceId: membership.workspace_id,
      actorUserId: user.id,
      locationIds,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      expectedRunIds: runIds,
    });
    return jsonOk(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error instanceof EmailOperationError ? operationError(error) : error);
  }
}
