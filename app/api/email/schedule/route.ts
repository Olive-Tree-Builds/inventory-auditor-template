import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { isValidIanaTimeZone } from "../../../lib/server/time-zone";

export const dynamic = "force-dynamic";

const schema = z.object({
  scheduleId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(120).default("Default forecast schedule"),
  enabled: z.boolean(),
  cadence: z.enum(["daily", "weekdays", "weekly", "custom"]),
  weekdayMask: z.number().int().min(0).max(127),
  localSendTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezoneRule: z.enum(["earliest_assigned_location", "workspace"]),
  workspaceTimeZone: z.string().trim().min(1).max(100).refine(isValidIanaTimeZone, "Choose a valid IANA timezone.").nullable(),
  forecastHorizon: z.enum(["today", "tomorrow", "next_7_days"]),
}).strict().superRefine((input, context) => {
  if (input.timezoneRule === "workspace" && !input.workspaceTimeZone) {
    context.addIssue({ code: "custom", path: ["workspaceTimeZone"], message: "Choose the workspace timezone." });
  }
  const bitCount = input.weekdayMask.toString(2).replace(/0/g, "").length;
  if (input.cadence === "weekly" && bitCount !== 1) {
    context.addIssue({ code: "custom", path: ["weekdayMask"], message: "Choose exactly one weekly delivery day." });
  }
  if (input.cadence === "custom" && input.weekdayMask === 0) {
    context.addIssue({ code: "custom", path: ["weekdayMask"], message: "Choose at least one delivery day." });
  }
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { data, error } = await supabase.rpc("ia_save_email_schedule", {
      p_schedule_id: input.scheduleId ?? null,
      p_name: input.name,
      p_enabled: input.enabled,
      p_cadence: input.cadence,
      p_weekday_mask: input.weekdayMask,
      p_local_send_time: input.localSendTime,
      p_timezone_rule: input.timezoneRule,
      p_workspace_time_zone: input.workspaceTimeZone,
      p_forecast_horizon: input.forecastHorizon,
    });
    if (error) {
      if (/verified before enabling/i.test(error.message)) {
        throw new HttpError(409, "Send a successful internal test email before enabling the schedule.", "email_not_verified");
      }
      throw new HttpError(400, "The email schedule could not be saved.", "schedule_save_failed");
    }
    return jsonOk({ scheduleId: String(data) });
  } catch (error) {
    return jsonError(error);
  }
}
