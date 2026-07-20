import type { SupabaseClient } from "@supabase/supabase-js";
import { HttpError, jsonError, jsonOk } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import {
  composeCombinedForecastEmail,
  evaluateDueEmailSchedule,
  isAuthorizedCronRequest,
} from "../../../lib/server/email-delivery";
import {
  AnalysisPolicyUnavailableError,
  reconcileAnalysisPolicy,
} from "../../../lib/server/analysis-policy";
import { buildEmailIdempotencyKey, ResendEmailClient, ResendError } from "../../../lib/server/resend-email";
import {
  claimScheduledDelivery,
  EmailOperationError,
  finishScheduledDelivery,
  loadActiveEmailContactScope,
  loadActiveRecipientScope,
  loadCurrentForecastRequirements,
  loadDeliverableForecasts,
  missingDeliverableForecastLocationIds,
  resolveResendDelivery,
  scopeSignature,
  verifyCurrentEmailCredential,
  type ResolvedResendDelivery,
} from "../../../lib/server/supabase-email-delivery";
import { runWorkspaceForecasts } from "../../../lib/server/forecast-runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_SCHEDULES_PER_RUN = 100;
const MAX_PROVIDER_ATTEMPTS_PER_RUN = 100;
const MAX_FORECAST_GENERATIONS_PER_RUN = 100;

type ScheduleRow = {
  id: string;
  workspace_id: string;
  cadence: "daily" | "weekdays" | "weekly" | "custom";
  weekday_mask: number;
  local_send_time: string;
  timezone_rule: "earliest_assigned_location" | "workspace" | "user_selected";
  workspace_time_zone: string | null;
  forecast_horizon: "today" | "tomorrow" | "next_7_days";
};

type JobSummary = {
  schedulesChecked: number;
  recipientsChecked: number;
  sent: number;
  skipped: number;
  failed: number;
  limited: boolean;
  failureCodes: Record<string, number>;
};

type ScheduledRecipient =
  | { kind: "user"; id: string; timeZoneOverride: string | null; email: string }
  | { kind: "contact"; id: string; timeZoneOverride: null; email: string };

function addFailure(summary: JobSummary, code: string) {
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "delivery_failed";
  summary.failed += 1;
  summary.failureCodes[safeCode] = (summary.failureCodes[safeCode] ?? 0) + 1;
}

function forecastRunSignature(forecasts: readonly { locationId: string; runId: string }[]) {
  return JSON.stringify(
    forecasts
      .map((forecast) => ({ locationId: forecast.locationId, runId: forecast.runId }))
      .sort((left, right) => left.locationId.localeCompare(right.locationId)),
  );
}

async function scheduleStillEnabled(
  admin: SupabaseClient,
  scheduleId: string,
  workspaceId: string,
  recipient: ScheduledRecipient,
): Promise<boolean> {
  const [schedule, workspace, recipientState] = await Promise.all([
    admin.from("ia_email_schedules").select("id")
      .eq("workspace_id", workspaceId).eq("id", scheduleId).eq("enabled", true).maybeSingle(),
    admin.from("ia_workspaces").select("id")
      .eq("id", workspaceId).eq("status", "active").eq("email_sending_enabled", true).maybeSingle(),
    recipient.kind === "user"
      ? admin.from("ia_email_recipient_preferences").select("enabled")
        .eq("workspace_id", workspaceId).eq("schedule_id", scheduleId)
        .eq("user_id", recipient.id).maybeSingle()
      : admin.from("ia_email_contacts").select("enabled")
        .eq("workspace_id", workspaceId).eq("schedule_id", scheduleId)
        .eq("id", recipient.id).eq("enabled", true).is("archived_at", null).maybeSingle(),
  ]);
  if (schedule.error || workspace.error || recipientState.error) {
    throw new EmailOperationError("storage_failed", "The live email schedule could not be rechecked.");
  }
  return Boolean(
    schedule.data && workspace.data &&
    (recipient.kind === "user" ? recipientState.data?.enabled !== false : recipientState.data?.enabled === true),
  );
}

function loadScheduledRecipientScope(
  admin: SupabaseClient,
  schedule: ScheduleRow,
  recipient: ScheduledRecipient,
) {
  return recipient.kind === "user"
    ? loadActiveRecipientScope(admin, schedule.workspace_id, recipient.id)
    : loadActiveEmailContactScope(admin, schedule.workspace_id, schedule.id, recipient.id);
}

export async function POST(request: Request) {
  try {
    const cronSecret = String(process.env.CRON_SECRET ?? "").trim();
    if (cronSecret.length < 32) {
      throw new HttpError(503, "Scheduled jobs are unavailable until CRON_SECRET is configured.", "cron_not_configured");
    }
    if (!isAuthorizedCronRequest(request.headers.get("authorization"), cronSecret)) {
      throw new HttpError(401, "This scheduled job request is not authorized.", "invalid_cron_authorization");
    }
    if (String(process.env.EMAIL_DELIVERY_ENABLED ?? "").trim() !== "true") {
      throw new HttpError(503, "Automatic email delivery is disabled by the server safety switch.", "email_delivery_disabled");
    }

    const admin = createSupabaseAdminClient();
    const now = new Date();
    const scheduleResult = await admin.from("ia_email_schedules")
      .select("id, workspace_id, cadence, weekday_mask, local_send_time, timezone_rule, workspace_time_zone, forecast_horizon")
      .eq("enabled", true)
      .order("id")
      .limit(MAX_SCHEDULES_PER_RUN + 1);
    if (scheduleResult.error) {
      throw new HttpError(500, "Enabled email schedules could not be loaded.", "schedule_lookup_failed");
    }
    const allSchedules = (scheduleResult.data ?? []) as ScheduleRow[];
    const schedules = allSchedules.slice(0, MAX_SCHEDULES_PER_RUN);
    const summary: JobSummary = {
      schedulesChecked: schedules.length,
      recipientsChecked: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      limited: allSchedules.length > schedules.length,
      failureCodes: {},
    };
    let providerAttempts = 0;
    let forecastGenerations = 0;
    const deliveryCache = new Map<string, Promise<ResolvedResendDelivery>>();
    const verificationCache = new Map<string, Promise<boolean>>();
    const generationCache = new Map<string, Promise<void>>();
    const policyReconciliationCache = new Map<string, Promise<void>>();

    for (const schedule of schedules) {
      const { data: workspace, error: workspaceError } = await admin.from("ia_workspaces")
        .select("name, status, email_sending_enabled")
        .eq("id", schedule.workspace_id)
        .maybeSingle();
      if (workspaceError) {
        addFailure(summary, "workspace_lookup_failed");
        continue;
      }
      if (!workspace || workspace.status !== "active" || workspace.email_sending_enabled !== true) {
        summary.skipped += 1;
        continue;
      }
      const [membershipResult, preferenceResult, contactResult] = await Promise.all([
        admin.from("ia_workspace_memberships")
          .select("user_id")
          .eq("workspace_id", schedule.workspace_id)
          .eq("status", "active")
          .eq("email_enabled", true)
          .order("user_id"),
        admin.from("ia_email_recipient_preferences")
          .select("user_id, enabled, time_zone_override")
          .eq("workspace_id", schedule.workspace_id)
          .eq("schedule_id", schedule.id),
        admin.from("ia_email_contacts")
          .select("id, email")
          .eq("workspace_id", schedule.workspace_id)
          .eq("schedule_id", schedule.id)
          .eq("enabled", true)
          .is("archived_at", null)
          .order("id"),
      ]);
      if (membershipResult.error || contactResult.error) {
        addFailure(summary, "recipient_lookup_failed");
        continue;
      }
      if (preferenceResult.error) {
        addFailure(summary, "recipient_preference_lookup_failed");
        continue;
      }
      const preferences = new Map((preferenceResult.data ?? []).map((row) => [String(row.user_id), row]));
      const userIds = (membershipResult.data ?? []).map((membership) => String(membership.user_id));
      const profileResult = userIds.length
        ? await admin.from("ia_profiles").select("user_id, email").in("user_id", userIds)
        : { data: [], error: null };
      if (profileResult.error) {
        addFailure(summary, "recipient_lookup_failed");
        continue;
      }
      const emailByUser = new Map((profileResult.data ?? []).map((profile) => [String(profile.user_id), String(profile.email)]));
      const recipients: ScheduledRecipient[] = [
        ...userIds.flatMap((userId) => {
          const preference = preferences.get(userId);
          return preference?.enabled === false ? [] : [{
            kind: "user" as const,
            id: userId,
            timeZoneOverride: preference?.time_zone_override ? String(preference.time_zone_override) : null,
            email: emailByUser.get(userId) ?? "",
          }];
        }),
        ...(contactResult.data ?? []).map((contact) => ({
          kind: "contact" as const,
          id: String(contact.id),
          timeZoneOverride: null,
          email: String(contact.email),
        })),
      ];
      const emailCounts = new Map<string, number>();
      recipients.forEach((recipient) => {
        const email = recipient.email.trim().toLocaleLowerCase();
        if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
      });
      const duplicateEmails = new Set([...emailCounts].filter(([, count]) => count > 1).map(([email]) => email));

      for (const recipient of recipients) {
        if (!recipient.email || duplicateEmails.has(recipient.email.toLocaleLowerCase())) {
          addFailure(summary, recipient.email ? "recipient_collision" : "recipient_not_eligible");
          continue;
        }
        summary.recipientsChecked += 1;
        let scope;
        try {
          scope = await loadScheduledRecipientScope(admin, schedule, recipient);
        } catch (error) {
          if (error instanceof EmailOperationError && error.code === "recipient_has_no_locations") {
            summary.skipped += 1;
          } else {
            addFailure(summary, error instanceof EmailOperationError ? error.code : "recipient_scope_failed");
          }
          continue;
        }
        let due;
        try {
          due = evaluateDueEmailSchedule({
            cadence: schedule.cadence,
            weekdayMask: Number(schedule.weekday_mask),
            localSendTime: String(schedule.local_send_time).slice(0, 8),
            timezoneRule: schedule.timezone_rule,
            workspaceTimeZone: schedule.workspace_time_zone,
            recipientTimeZone: recipient.timeZoneOverride,
            locationTimeZones: scope.locations.map((location) => location.timeZone),
            forecastHorizon: schedule.forecast_horizon,
          }, now);
        } catch {
          addFailure(summary, "invalid_schedule");
          continue;
        }
        if (!due) {
          summary.skipped += 1;
          continue;
        }
        if (providerAttempts >= MAX_PROVIDER_ATTEMPTS_PER_RUN) {
          summary.limited = true;
          summary.skipped += 1;
          continue;
        }
        try {
          const [currentScope, enabled] = await Promise.all([
            loadScheduledRecipientScope(admin, schedule, recipient),
            scheduleStillEnabled(admin, schedule.id, schedule.workspace_id, recipient),
          ]);
          if (!enabled || scopeSignature(currentScope) !== scopeSignature(scope)) {
            summary.skipped += 1;
            continue;
          }
          scope = currentScope;
        } catch (error) {
          addFailure(summary, error instanceof EmailOperationError ? error.code : "recipient_scope_failed");
          continue;
        }

        let delivery: ResolvedResendDelivery;
        try {
          if (!deliveryCache.has(schedule.workspace_id)) {
            deliveryCache.set(schedule.workspace_id, resolveResendDelivery({
              admin,
              workspaceId: schedule.workspace_id,
              requireVerifiedConnection: true,
            }));
          }
          delivery = await deliveryCache.get(schedule.workspace_id)!;
          if (!verificationCache.has(schedule.workspace_id)) {
            verificationCache.set(schedule.workspace_id, verifyCurrentEmailCredential(
              admin,
              schedule.workspace_id,
              delivery,
            ));
          }
          if (!await verificationCache.get(schedule.workspace_id)!) {
            throw new EmailOperationError(
              "resend_not_verified",
              "The current Resend credential and sender have not passed an internal delivery test.",
            );
          }
        } catch (error) {
          addFailure(summary, error instanceof EmailOperationError ? error.code : "resend_configuration_failed");
          continue;
        }

        try {
          if (!policyReconciliationCache.has(schedule.workspace_id)) {
            policyReconciliationCache.set(schedule.workspace_id, reconcileAnalysisPolicy({
              admin,
              workspaceId: schedule.workspace_id,
              encryptionKey: String(process.env.APP_SECRET_ENCRYPTION_KEY ?? "").trim(),
            }).then(() => undefined));
          }
          await policyReconciliationCache.get(schedule.workspace_id);
          const requirements = await loadCurrentForecastRequirements(admin, schedule.workspace_id);
          const missingLocationIds = await missingDeliverableForecastLocationIds({
            admin,
            workspaceId: schedule.workspace_id,
            locationIds: scope.locations.map((location) => location.id),
            periodStart: due.periodStart,
            periodEnd: due.periodEnd,
            requirements,
          });
          await Promise.all(missingLocationIds.map(async (locationId) => {
            const location = scope.locations.find((candidate) => candidate.id === locationId)!;
            const generationKey = [schedule.workspace_id, locationId, due.periodStart, due.periodEnd].join(":");
            if (!generationCache.has(generationKey)) {
              if (forecastGenerations >= MAX_FORECAST_GENERATIONS_PER_RUN) {
                summary.limited = true;
                throw new Error("forecast_generation_limit");
              }
              forecastGenerations += 1;
              generationCache.set(generationKey, (async () => {
                const days = Math.round((
                  new Date(`${due.periodEnd}T00:00:00.000Z`).getTime() -
                  new Date(`${due.periodStart}T00:00:00.000Z`).getTime()
                ) / 86_400_000) + 1;
                await runWorkspaceForecasts({
                  supabase: admin,
                  admin,
                  workspaceId: schedule.workspace_id,
                  locations: [{
                    id: location.id,
                    brand_id: location.brandId,
                    brand_name: location.brandName,
                    name: location.name,
                    time_zone: location.timeZone,
                    street_address: location.streetAddress,
                    city: location.city,
                    region: location.region,
                    postal_code: location.postalCode,
                    country_code: location.countryCode,
                    research_area: location.researchArea,
                  }],
                  grouping: days === 1 ? "day" : "week",
                  runSource: "scheduled",
                  encryptionKey: String(process.env.APP_SECRET_ENCRYPTION_KEY ?? "").trim(),
                  periodOverride: { startDate: due.periodStart, endDate: due.periodEnd },
                });
              })());
            }
            await generationCache.get(generationKey);
          }));
        } catch (error) {
          addFailure(summary, error instanceof AnalysisPolicyUnavailableError
            ? error.code
            : error instanceof EmailOperationError
              ? error.code
              : "forecast_generation_failed");
          continue;
        }

        let forecasts;
        try {
          const currentRequirements = await loadCurrentForecastRequirements(admin, schedule.workspace_id);
          forecasts = await loadDeliverableForecasts({
            admin,
            scope,
            exactPeriod: { start: due.periodStart, end: due.periodEnd },
            requirements: currentRequirements,
          });
        } catch (error) {
          addFailure(summary, error instanceof EmailOperationError ? error.code : "forecast_lookup_failed");
          continue;
        }
        const idempotencyKey = buildEmailIdempotencyKey({
          workspaceId: schedule.workspace_id,
          recipientKey: scope.recipientKey,
          scheduleId: schedule.id,
          forecastStartDate: due.periodStart,
          forecastEndDate: due.periodEnd,
        });
        let claim;
        try {
          claim = await claimScheduledDelivery({
            admin,
            workspaceId: schedule.workspace_id,
            scheduleId: schedule.id,
            recipientUserId: scope.recipientUserId,
            recipientContactId: scope.recipientContactId,
            periodStart: due.periodStart,
            periodEnd: due.periodEnd,
            dueAt: due.scheduledFor,
            idempotencyKey,
            forecasts,
            now,
          });
        } catch (error) {
          addFailure(summary, error instanceof EmailOperationError ? error.code : "delivery_claim_failed");
          continue;
        }
        if (!claim) {
          summary.skipped += 1;
          continue;
        }

        providerAttempts += 1;
        try {
          const [currentScope, enabled] = await Promise.all([
            loadScheduledRecipientScope(admin, schedule, recipient),
            scheduleStillEnabled(admin, schedule.id, schedule.workspace_id, recipient),
          ]);
          if (!enabled || scopeSignature(currentScope) !== scopeSignature(scope)) {
            await finishScheduledDelivery({
              admin,
              workspaceId: schedule.workspace_id,
              claim,
              outcome: "cancelled",
              failureCode: "recipient_scope_changed",
            });
            summary.skipped += 1;
            continue;
          }
          await reconcileAnalysisPolicy({
            admin,
            workspaceId: schedule.workspace_id,
            encryptionKey: String(process.env.APP_SECRET_ENCRYPTION_KEY ?? "").trim(),
          });
          const finalRequirements = await loadCurrentForecastRequirements(admin, schedule.workspace_id);
          const finalForecasts = await loadDeliverableForecasts({
            admin,
            scope: currentScope,
            exactPeriod: { start: due.periodStart, end: due.periodEnd },
            requirements: finalRequirements,
          });
          if (forecastRunSignature(finalForecasts) !== forecastRunSignature(forecasts)) {
            throw new EmailOperationError(
              "forecast_changed",
              "The current forecast set changed after delivery was claimed. Retry with a fresh claim.",
            );
          }
          forecasts = finalForecasts;
          const currentDelivery = await resolveResendDelivery({
            admin,
            workspaceId: schedule.workspace_id,
            requireVerifiedConnection: true,
          });
          if (
            currentDelivery.credentialFingerprint !== delivery.credentialFingerprint ||
            currentDelivery.sender !== delivery.sender ||
            !await verifyCurrentEmailCredential(admin, schedule.workspace_id, currentDelivery)
          ) {
            throw new EmailOperationError(
              "resend_not_verified",
              "The Resend credential or sender changed after delivery was claimed.",
            );
          }
          delivery = currentDelivery;
          const message = composeCombinedForecastEmail({
            workspaceName: String(workspace.name),
            recipientName: currentScope.displayName,
            locations: forecasts,
          });
          const receipt = await new ResendEmailClient({
            apiKey: delivery.apiKey,
            from: delivery.sender,
          }).send({
            recipient: currentScope.email,
            subject: message.subject,
            html: message.html,
            text: message.text,
            idempotencyKey,
          });
          await finishScheduledDelivery({
            admin,
            workspaceId: schedule.workspace_id,
            claim,
            outcome: "sent",
            providerMessageId: receipt.id,
          });
          summary.sent += 1;
        } catch (error) {
          const failureCode = error instanceof ResendError
            ? error.code
            : error instanceof AnalysisPolicyUnavailableError
              ? error.code
            : error instanceof EmailOperationError
              ? error.code
              : "delivery_failed";
          try {
            await finishScheduledDelivery({
              admin,
              workspaceId: schedule.workspace_id,
              claim,
              outcome: "failed",
              failureCode,
            });
          } catch {
            // The durable provider idempotency key still prevents a second email.
          }
          addFailure(summary, failureCode);
        }
      }
    }

    return jsonOk(summary, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
