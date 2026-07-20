import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import {
  EmailOperationError,
  sendInternalForecastTest,
} from "../../../lib/server/supabase-email-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  recipientUserId: z.uuid(),
}).strict();

function asHttpError(error: unknown): unknown {
  if (!(error instanceof EmailOperationError)) return error;
  if (["recipient_not_eligible", "recipient_has_no_locations", "recipient_scope_changed"].includes(error.code)) {
    return new HttpError(409, error.message, error.code);
  }
  if (["forecast_missing", "forecast_invalid", "forecast_changed"].includes(error.code)) {
    return new HttpError(409, error.message, error.code);
  }
  if (["resend_not_configured", "resend_not_verified"].includes(error.code)) {
    return new HttpError(503, error.message, error.code);
  }
  if (error.code === "resend_send_failed") return new HttpError(502, error.message, error.code);
  return error;
}

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const { user, membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const result = await sendInternalForecastTest({
      admin: createSupabaseAdminClient(),
      workspaceId: membership.workspace_id,
      actorUserId: user.id,
      recipientUserId: input.recipientUserId,
    });
    return jsonOk({
      message: `Internal test sent as one combined email for ${result.locationCount} ${result.locationCount === 1 ? "location" : "locations"}. Automatic delivery can now be enabled explicitly.`,
      locationCount: result.locationCount,
      emailSendingEnabled: true,
    }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(asHttpError(error));
  }
}
