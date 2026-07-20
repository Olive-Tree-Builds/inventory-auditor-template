import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildManualSendDedupeKey,
  buildManualSendIdempotencyKey,
  composeCombinedForecastEmail,
  type CombinedForecastEmailLocation,
} from "./email-delivery";
import { reconcileAnalysisPolicy } from "./analysis-policy";
import { ResendEmailClient, ResendError } from "./resend-email";
import {
  claimScheduledDelivery,
  EmailOperationError,
  finishScheduledDelivery,
  loadActiveEmailContactScope,
  loadActiveRecipientScope,
  loadCurrentForecastRequirements,
  loadDeliverableForecasts,
  loadRecipientLocations,
  resolveResendDelivery,
  restrictRecipientScope,
  scopeSignature,
  verifyCurrentEmailCredential,
  type RecipientScope,
  type ResolvedResendDelivery,
} from "./supabase-email-delivery";

type Environment = Record<string, string | undefined>;

type RecipientReference =
  | { kind: "user"; id: string }
  | { kind: "contact"; id: string };

export type ManualEmailResult = {
  recipientsChecked: number;
  sent: number;
  skipped: number;
  failed: number;
  failureCodes: Record<string, number>;
};

function runSignature(rows: readonly CombinedForecastEmailLocation[]): string {
  return JSON.stringify(rows
    .map((row) => ({ locationId: row.locationId, runId: row.runId }))
    .sort((left, right) => left.locationId.localeCompare(right.locationId)));
}

function addFailure(result: ManualEmailResult, code: string) {
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : "delivery_failed";
  result.failed += 1;
  result.failureCodes[safeCode] = (result.failureCodes[safeCode] ?? 0) + 1;
}

async function assertAnalysisPolicyCurrent(
  admin: SupabaseClient,
  workspaceId: string,
  environment: Environment,
) {
  try {
    await reconcileAnalysisPolicy({
      admin,
      workspaceId,
      encryptionKey: String(environment.APP_SECRET_ENCRYPTION_KEY ?? "").trim(),
      environment,
    });
  } catch {
    throw new EmailOperationError(
      "forecast_invalid",
      "The current Analysis Skill could not be verified before delivery. Reconnect GitHub or activate the latest policy, then try again.",
    );
  }
}

async function assertActorScope(
  admin: SupabaseClient,
  workspaceId: string,
  actorUserId: string,
  locationIds: readonly string[],
) {
  const [membershipResult, assignmentResult] = await Promise.all([
    admin.from("ia_workspace_memberships")
      .select("role")
      .eq("workspace_id", workspaceId)
      .eq("user_id", actorUserId)
      .eq("status", "active")
      .maybeSingle(),
    admin.from("ia_user_location_assignments")
      .select("location_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", actorUserId)
      .eq("is_active", true),
  ]);
  if (membershipResult.error || assignmentResult.error) {
    throw new EmailOperationError("storage_failed", "The sender's live location access could not be checked.");
  }
  if (!membershipResult.data || !["super_admin", "admin"].includes(String(membershipResult.data.role))) {
    throw new EmailOperationError("recipient_scope_changed", "Administrator access changed before email delivery.");
  }
  const allowed = new Set((assignmentResult.data ?? []).map((row) => String(row.location_id)));
  if (locationIds.some((locationId) => !allowed.has(locationId))) {
    throw new EmailOperationError("recipient_scope_changed", "Location access changed before email delivery.");
  }
}

async function loadManualRecipientScope(
  admin: SupabaseClient,
  workspaceId: string,
  scheduleId: string,
  reference: RecipientReference,
): Promise<RecipientScope> {
  if (reference.kind === "contact") {
    return loadActiveEmailContactScope(admin, workspaceId, scheduleId, reference.id);
  }
  const scope = await loadActiveRecipientScope(admin, workspaceId, reference.id);
  const { data, error } = await admin.from("ia_email_recipient_preferences")
    .select("enabled")
    .eq("workspace_id", workspaceId)
    .eq("schedule_id", scheduleId)
    .eq("user_id", reference.id)
    .maybeSingle();
  if (error) throw new EmailOperationError("storage_failed", "The recipient preference could not be checked.");
  if (data?.enabled === false) {
    throw new EmailOperationError("recipient_not_eligible", "The recipient disabled this email schedule.");
  }
  return scope;
}

async function assertCurrentDelivery(
  admin: SupabaseClient,
  workspaceId: string,
  environment: Environment,
  expected: ResolvedResendDelivery,
): Promise<ResolvedResendDelivery> {
  const current = await resolveResendDelivery({
    admin,
    workspaceId,
    environment,
    requireVerifiedConnection: true,
  });
  if (
    current.credentialFingerprint !== expected.credentialFingerprint ||
    current.sender !== expected.sender ||
    !await verifyCurrentEmailCredential(admin, workspaceId, current)
  ) {
    throw new EmailOperationError(
      "resend_not_verified",
      "The current Resend credential and sender have not passed an internal delivery test.",
    );
  }
  return current;
}

export async function sendManualForecastEmails(input: {
  admin: SupabaseClient;
  workspaceId: string;
  actorUserId: string;
  locationIds: readonly string[];
  periodStart: string;
  periodEnd: string;
  expectedRunIds: readonly string[];
  environment?: Environment;
  fetch?: typeof fetch;
  now?: Date;
}): Promise<ManualEmailResult> {
  const now = input.now ?? new Date();
  const environment = input.environment ?? process.env;
  const selectedLocationIds = [...new Set(input.locationIds)];
  await assertActorScope(input.admin, input.workspaceId, input.actorUserId, selectedLocationIds);
  await assertAnalysisPolicyCurrent(input.admin, input.workspaceId, environment);

  const [workspaceResult, scheduleResult] = await Promise.all([
    input.admin.from("ia_workspaces")
      .select("name, status, email_sending_enabled")
      .eq("id", input.workspaceId)
      .maybeSingle(),
    input.admin.from("ia_email_schedules")
      .select("id")
      .eq("workspace_id", input.workspaceId)
      .maybeSingle(),
  ]);
  if (workspaceResult.error || scheduleResult.error) {
    throw new EmailOperationError("storage_failed", "The workspace email settings could not be checked.");
  }
  if (!workspaceResult.data || workspaceResult.data.status !== "active") {
    throw new EmailOperationError("storage_failed", "The active workspace could not be checked.");
  }
  if (workspaceResult.data.email_sending_enabled !== true) {
    throw new EmailOperationError(
      "email_delivery_disabled",
      "Send a successful internal test email before using manual delivery.",
    );
  }
  if (!scheduleResult.data?.id) {
    throw new EmailOperationError("schedule_missing", "Save an email schedule before using manual delivery.");
  }
  const scheduleId = String(scheduleResult.data.id);

  const delivery = await resolveResendDelivery({
    admin: input.admin,
    workspaceId: input.workspaceId,
    environment,
    requireVerifiedConnection: true,
  });
  if (!await verifyCurrentEmailCredential(input.admin, input.workspaceId, delivery)) {
    throw new EmailOperationError(
      "resend_not_verified",
      "The current Resend credential and sender have not passed an internal delivery test.",
    );
  }

  const selectedLocations = await loadRecipientLocations(input.admin, input.workspaceId, selectedLocationIds);
  const selectedScope: RecipientScope = {
    workspaceId: input.workspaceId,
    recipientKind: "user",
    recipientKey: `actor:${input.actorUserId}`,
    recipientUserId: input.actorUserId,
    recipientContactId: null,
    email: "actor-scope@invalid.example",
    displayName: "Manual delivery scope",
    locations: selectedLocations,
  };
  const requirements = await loadCurrentForecastRequirements(input.admin, input.workspaceId);
  const selectedForecasts = await loadDeliverableForecasts({
    admin: input.admin,
    scope: selectedScope,
    exactPeriod: { start: input.periodStart, end: input.periodEnd },
    requirements,
  });
  const expectedRuns = [...new Set(input.expectedRunIds)].sort();
  const actualRuns = selectedForecasts.map((row) => row.runId).sort();
  if (expectedRuns.length !== actualRuns.length || expectedRuns.some((runId, index) => runId !== actualRuns[index])) {
    throw new EmailOperationError(
      "forecast_changed",
      "The selected forecast changed before delivery. Refresh the dashboard and review it again.",
    );
  }

  const [userLocationResult, contactLocationResult] = await Promise.all([
    input.admin.from("ia_user_location_assignments")
      .select("user_id")
      .eq("workspace_id", input.workspaceId)
      .eq("is_active", true)
      .in("location_id", selectedLocationIds),
    input.admin.from("ia_email_contact_locations")
      .select("contact_id")
      .eq("workspace_id", input.workspaceId)
      .in("location_id", selectedLocationIds),
  ]);
  if (userLocationResult.error || contactLocationResult.error) {
    throw new EmailOperationError("storage_failed", "Location-scoped email recipients could not be loaded.");
  }
  const candidateUserIds = [...new Set((userLocationResult.data ?? []).map((row) => String(row.user_id)))];
  const candidateContactIds = [...new Set((contactLocationResult.data ?? []).map((row) => String(row.contact_id)))];
  const [membershipResult, preferenceResult, contactResult] = await Promise.all([
    candidateUserIds.length
      ? input.admin.from("ia_workspace_memberships")
        .select("user_id")
        .eq("workspace_id", input.workspaceId)
        .eq("status", "active")
        .eq("email_enabled", true)
        .in("user_id", candidateUserIds)
        .order("user_id")
      : Promise.resolve({ data: [], error: null }),
    candidateUserIds.length
      ? input.admin.from("ia_email_recipient_preferences")
        .select("user_id, enabled")
        .eq("workspace_id", input.workspaceId)
        .eq("schedule_id", scheduleId)
        .in("user_id", candidateUserIds)
      : Promise.resolve({ data: [], error: null }),
    candidateContactIds.length
      ? input.admin.from("ia_email_contacts")
        .select("id")
        .eq("workspace_id", input.workspaceId)
        .eq("schedule_id", scheduleId)
        .eq("enabled", true)
        .is("archived_at", null)
        .in("id", candidateContactIds)
        .order("id")
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (membershipResult.error || preferenceResult.error || contactResult.error) {
    throw new EmailOperationError("storage_failed", "Email recipients could not be loaded.");
  }
  const disabledUserIds = new Set((preferenceResult.data ?? [])
    .filter((row) => row.enabled === false)
    .map((row) => String(row.user_id)));
  const references: RecipientReference[] = [
    ...(membershipResult.data ?? []).flatMap((row) => {
      const id = String(row.user_id);
      return disabledUserIds.has(id) ? [] : [{ kind: "user" as const, id }];
    }),
    ...(contactResult.data ?? []).map((row) => ({ kind: "contact" as const, id: String(row.id) })),
  ];
  if (!references.length) {
    throw new EmailOperationError(
      "recipient_not_eligible",
      "Enable email for at least one assigned user or add an email recipient before sending.",
    );
  }
  if (references.length > 100) {
    throw new EmailOperationError("recipient_not_eligible", "Manual delivery is limited to one hundred recipients at a time.");
  }

  const { error: startAuditError } = await input.admin.from("ia_audit_events").insert({
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    event_type: "email.manual_send.started",
    entity_type: "email_schedule",
    entity_id: scheduleId,
    outcome: "success",
    metadata: {
      period_start: input.periodStart,
      period_end: input.periodEnd,
      location_count: selectedLocationIds.length,
      forecast_run_count: expectedRuns.length,
      recipients_checked: references.length,
    },
  });
  if (startAuditError) {
    throw new EmailOperationError("storage_failed", "The manual email attempt could not be recorded safely.");
  }

  const result: ManualEmailResult = {
    recipientsChecked: references.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    failureCodes: {},
  };
  const loaded = await Promise.all(references.map(async (reference) => {
    try {
      const fullScope = await loadManualRecipientScope(input.admin, input.workspaceId, scheduleId, reference);
      const scope = restrictRecipientScope(fullScope, new Set(selectedLocationIds));
      return { reference, fullScope, scope, error: null as unknown };
    } catch (error) {
      return { reference, fullScope: null, scope: null, error };
    }
  }));
  loaded.filter((entry) => entry.error).forEach((entry) => {
    if (
      entry.error instanceof EmailOperationError &&
      ["recipient_not_eligible", "recipient_has_no_locations"].includes(entry.error.code)
    ) {
      result.skipped += 1;
      return;
    }
    addFailure(result, entry.error instanceof EmailOperationError ? entry.error.code : "recipient_scope_failed");
  });

  const eligible = loaded.filter((entry): entry is typeof entry & {
    fullScope: RecipientScope;
    scope: RecipientScope;
  } => Boolean(entry.fullScope && entry.scope));
  const emailCounts = new Map<string, number>();
  eligible.forEach((entry) => {
    const email = entry.scope.email.toLocaleLowerCase();
    emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
  });
  const duplicateEmails = new Set([...emailCounts].filter(([, count]) => count > 1).map(([email]) => email));

  for (const entry of eligible) {
    if (duplicateEmails.has(entry.scope.email.toLocaleLowerCase())) {
      addFailure(result, "recipient_collision");
      continue;
    }
    if (!entry.scope.locations.length) {
      result.skipped += 1;
      continue;
    }
    let forecasts = selectedForecasts.filter((row) => entry.scope.locations.some((location) => location.id === row.locationId));
    const idempotencyKey = buildManualSendIdempotencyKey({
      workspaceId: input.workspaceId,
      recipientKey: entry.scope.recipientKey,
      runIds: forecasts.map((forecast) => forecast.runId),
      now,
    });
    const manualDedupeKey = buildManualSendDedupeKey({
      workspaceId: input.workspaceId,
      recipientKey: entry.scope.recipientKey,
      runIds: forecasts.map((forecast) => forecast.runId),
    });
    let claim;
    try {
      claim = await claimScheduledDelivery({
        admin: input.admin,
        workspaceId: input.workspaceId,
        scheduleId,
        recipientUserId: entry.scope.recipientUserId,
        recipientContactId: entry.scope.recipientContactId,
        deliverySource: "manual",
        triggeredBy: input.actorUserId,
        manualDedupeKey,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        dueAt: now.toISOString(),
        idempotencyKey,
        forecasts,
        now,
      });
    } catch (error) {
      addFailure(result, error instanceof EmailOperationError ? error.code : "delivery_claim_failed");
      continue;
    }
    if (!claim) {
      result.skipped += 1;
      continue;
    }

    try {
      await assertActorScope(input.admin, input.workspaceId, input.actorUserId, selectedLocationIds);
      const currentFullScope = await loadManualRecipientScope(
        input.admin,
        input.workspaceId,
        scheduleId,
        entry.reference,
      );
      const currentScope = restrictRecipientScope(currentFullScope, new Set(selectedLocationIds));
      if (!currentScope.locations.length || scopeSignature(currentScope) !== scopeSignature(entry.scope)) {
        throw new EmailOperationError(
          "recipient_scope_changed",
          "A recipient's location scope changed before delivery.",
        );
      }
      await assertAnalysisPolicyCurrent(input.admin, input.workspaceId, environment);
      const currentRequirements = await loadCurrentForecastRequirements(input.admin, input.workspaceId);
      const currentForecasts = await loadDeliverableForecasts({
        admin: input.admin,
        scope: currentScope,
        exactPeriod: { start: input.periodStart, end: input.periodEnd },
        requirements: currentRequirements,
      });
      if (runSignature(currentForecasts) !== runSignature(forecasts)) {
        throw new EmailOperationError("forecast_changed", "The forecast set changed after delivery was claimed.");
      }
      forecasts = currentForecasts;
      const currentDelivery = await assertCurrentDelivery(
        input.admin,
        input.workspaceId,
        environment,
        delivery,
      );
      const message = composeCombinedForecastEmail({
        workspaceName: String(workspaceResult.data.name),
        recipientName: currentScope.displayName,
        locations: forecasts,
      });
      const receipt = await new ResendEmailClient({
        apiKey: currentDelivery.apiKey,
        from: currentDelivery.sender,
        fetch: input.fetch,
      }).send({
        recipient: currentScope.email,
        subject: message.subject,
        html: message.html,
        text: message.text,
        idempotencyKey,
      });
      await finishScheduledDelivery({
        admin: input.admin,
        workspaceId: input.workspaceId,
        claim,
        outcome: "sent",
        providerMessageId: receipt.id,
      });
      result.sent += 1;
    } catch (error) {
      const failureCode = error instanceof ResendError
        ? error.code
        : error instanceof EmailOperationError
          ? error.code
          : "delivery_failed";
      try {
        await finishScheduledDelivery({
          admin: input.admin,
          workspaceId: input.workspaceId,
          claim,
          outcome: error instanceof EmailOperationError && ["recipient_scope_changed", "forecast_changed"].includes(error.code)
            ? "cancelled"
            : "failed",
          failureCode,
        });
      } catch {
        // The provider idempotency key still protects a retry if ledger finalization fails.
      }
      addFailure(result, failureCode);
    }
  }

  const { error: completedAuditError } = await input.admin.from("ia_audit_events").insert({
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    event_type: "email.manual_send.completed",
    entity_type: "email_schedule",
    entity_id: scheduleId,
    outcome: result.failed > 0 && result.sent === 0 ? "failed" : "success",
    metadata: {
      period_start: input.periodStart,
      period_end: input.periodEnd,
      location_count: selectedLocationIds.length,
      recipients_checked: result.recipientsChecked,
      sent: result.sent,
      skipped: result.skipped,
      failed: result.failed,
      failure_codes: result.failureCodes,
    },
  });
  if (completedAuditError) addFailure(result, "audit_write_failed");
  return result;
}
