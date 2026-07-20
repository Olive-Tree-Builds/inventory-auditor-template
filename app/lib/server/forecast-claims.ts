import type { SupabaseClient } from "@supabase/supabase-js";

export type ForecastRunSource = "manual" | "scheduled" | "email_test";

export class ForecastClaimError extends Error {
  readonly code = "forecast_claim_failed" as const;

  constructor(message: string) {
    super(message);
    this.name = "ForecastClaimError";
  }
}

type ForecastClaimScope = {
  admin: SupabaseClient;
  workspaceId: string;
  locationId: string;
  period: { startDate: string; endDate: string };
  policyRevisionId: string;
  runSource: ForecastRunSource;
  actorUserId?: string;
};

function claimActor(input: ForecastClaimScope): string | null {
  if (input.runSource === "scheduled") {
    if (input.actorUserId) throw new ForecastClaimError("Scheduled forecasts cannot borrow a user identity.");
    return null;
  }
  if (!input.actorUserId) throw new ForecastClaimError("An authorized forecast actor is required.");
  return input.actorUserId;
}

export async function claimForecastGeneration(input: ForecastClaimScope): Promise<string | null> {
  const { data, error } = await input.admin.rpc("ia_server_claim_scheduled_forecast", {
    p_workspace_id: input.workspaceId,
    p_location_id: input.locationId,
    p_period_start: input.period.startDate,
    p_period_end: input.period.endDate,
    p_policy_revision_id: input.policyRevisionId,
    p_run_source: input.runSource,
    p_actor_user_id: claimActor(input),
  });
  if (error) throw new ForecastClaimError("The forecast could not be claimed safely.");
  if (data === null) return null;
  if (typeof data !== "string" || !/^[0-9a-f-]{36}$/i.test(data)) {
    throw new ForecastClaimError("Supabase returned an invalid forecast claim receipt.");
  }
  return data;
}

export async function failForecastGeneration(input: ForecastClaimScope & {
  claimToken: string;
  failureCode?: string;
}): Promise<void> {
  const failureCode = input.failureCode || "forecast_generation_failed";
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(failureCode)) {
    throw new ForecastClaimError("The forecast failure code is invalid.");
  }
  const { error } = await input.admin.rpc("ia_server_finish_scheduled_forecast", {
    p_workspace_id: input.workspaceId,
    p_location_id: input.locationId,
    p_period_start: input.period.startDate,
    p_period_end: input.period.endDate,
    p_policy_revision_id: input.policyRevisionId,
    p_run_source: input.runSource,
    p_actor_user_id: claimActor(input),
    p_claim_token: input.claimToken,
    p_outcome: "failed",
    p_failure_code: failureCode,
  });
  if (error) throw new ForecastClaimError("The forecast claim could not be finalized safely.");
}
