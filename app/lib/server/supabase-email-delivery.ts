import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileAnalysisPolicy } from "./analysis-policy";
import {
  CredentialResolutionError,
  resolveProviderCredential,
} from "./credential-resolver";
import {
  buildInternalTestIdempotencyKey,
  composeCombinedForecastEmail,
  DELIVERABLE_FORECAST_STATUSES,
  type CombinedForecastEmailLocation,
  type DeliverableForecastStatus,
} from "./email-delivery";
import { ResendEmailClient, ResendError } from "./resend-email";
import type { AnalysisSkillDocument } from "./github-analysis-skill";
import { decodeEncryptionKey, fingerprintSecret } from "./secret-crypto";
import { SupabaseCredentialStore } from "./supabase-credential-store";

type Environment = Record<string, string | undefined>;

export type EmailOperationErrorCode =
  | "recipient_not_eligible"
  | "recipient_has_no_locations"
  | "recipient_scope_changed"
  | "recipient_collision"
  | "schedule_missing"
  | "email_delivery_disabled"
  | "forecast_missing"
  | "forecast_invalid"
  | "forecast_changed"
  | "resend_not_configured"
  | "resend_not_verified"
  | "resend_send_failed"
  | "storage_failed";

export class EmailOperationError extends Error {
  constructor(
    public readonly code: EmailOperationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmailOperationError";
  }
}

type ProviderRow = {
  sender_email: string | null;
  status: "unconfigured" | "untested" | "connected" | "failing" | "disabled";
  masked_hint: string | null;
};

export type ResolvedResendDelivery = {
  apiKey: string;
  sender: string;
  credentialFingerprint: string;
  source: "stored" | "environment";
  connectionStatus: ProviderRow["status"] | null;
};

function stringValue(environment: Environment, name: string): string {
  return String(environment[name] ?? "").trim();
}

function validSender(sender: string): boolean {
  const mailbox = sender.match(/<([^<>]+)>$/)?.[1] ?? sender;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox) && !/[\r\n]/.test(sender) && sender.length <= 320;
}

export async function resolveResendDelivery(input: {
  admin: SupabaseClient;
  workspaceId: string;
  environment?: Environment;
  requireVerifiedConnection?: boolean;
}): Promise<ResolvedResendDelivery> {
  const environment = input.environment ?? process.env;
  const encryptionKey = stringValue(environment, "APP_SECRET_ENCRYPTION_KEY");
  try {
    decodeEncryptionKey(encryptionKey);
  } catch {
    throw new EmailOperationError(
      "resend_not_configured",
      "Email delivery requires the app encryption key before provider credentials can be used.",
    );
  }

  const { data, error } = await input.admin
    .from("ia_provider_connections")
    .select("sender_email, status, masked_hint")
    .eq("workspace_id", input.workspaceId)
    .eq("provider_kind", "resend")
    .maybeSingle();
  if (error) throw new EmailOperationError("storage_failed", "The Resend connection could not be checked.");
  const row = data as ProviderRow | null;
  if (row?.status === "disabled") {
    throw new EmailOperationError("resend_not_configured", "The Resend connection is disabled.");
  }
  if (input.requireVerifiedConnection && row && row.status !== "connected") {
    throw new EmailOperationError(
      "resend_not_verified",
      "Send another internal test after changing the Resend connection.",
    );
  }

  let credential: Awaited<ReturnType<typeof resolveProviderCredential>>;
  try {
    credential = await resolveProviderCredential({
      workspaceId: input.workspaceId,
      provider: "resend",
      name: "apiKey",
      store: new SupabaseCredentialStore(input.admin),
      encryptionKey,
      environment,
    });
  } catch (error) {
    if (error instanceof CredentialResolutionError) {
      throw new EmailOperationError(
        "resend_not_configured",
        error.code === "stored_credential_unreadable"
          ? "Replace the saved Resend credential before sending email."
          : "Connect Resend and enter its API key before sending email.",
      );
    }
    throw error;
  }
  if (row?.masked_hint && credential.source !== "stored") {
    throw new EmailOperationError(
      "resend_not_configured",
      "The saved Resend credential is unavailable. Replace it before sending email.",
    );
  }

  const sender = row?.sender_email?.trim() || stringValue(environment, "RESEND_FROM_EMAIL");
  if (!validSender(sender)) {
    throw new EmailOperationError(
      "resend_not_configured",
      "Enter a valid verified Resend sender address before sending email.",
    );
  }
  const fingerprint = fingerprintSecret(
    credential.value,
    encryptionKey,
    `inventory-auditor:${input.workspaceId}:resend:delivery-verification:${sender}`,
  );
  return {
    apiKey: credential.value,
    sender,
    credentialFingerprint: fingerprint,
    source: credential.source,
    connectionStatus: row?.status ?? null,
  };
}

export type RecipientLocation = {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  timeZone: string;
  streetAddress: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  researchArea: string;
};

export type RecipientScope = {
  workspaceId: string;
  recipientKind: "user" | "contact";
  recipientKey: string;
  recipientUserId: string | null;
  recipientContactId: string | null;
  email: string;
  displayName: string;
  locations: RecipientLocation[];
};

export async function loadRecipientLocations(
  admin: SupabaseClient,
  workspaceId: string,
  locationIds: readonly string[],
): Promise<RecipientLocation[]> {
  if (!locationIds.length) {
    throw new EmailOperationError(
      "recipient_has_no_locations",
      "Assign the recipient to at least one active location before sending a forecast email.",
    );
  }
  const { data: locations, error: locationError } = await admin
    .from("ia_locations")
    .select("id, brand_id, name, time_zone, street_address, city, region, postal_code, country_code")
    .eq("workspace_id", workspaceId)
    .eq("is_active", true)
    .in("id", [...new Set(locationIds)]);
  if (locationError) throw new EmailOperationError("storage_failed", "Assigned locations could not be checked.");
  if (!locations?.length || locations.length !== new Set(locationIds).size) {
    throw new EmailOperationError(
      "recipient_has_no_locations",
      "Assign the recipient to at least one active location before sending a forecast email.",
    );
  }
  const brandIds = [...new Set(locations.map((row) => String(row.brand_id)))];
  const { data: brands, error: brandError } = await admin
    .from("ia_brands")
    .select("id, name")
    .eq("workspace_id", workspaceId)
    .is("archived_at", null)
    .in("id", brandIds);
  if (brandError) throw new EmailOperationError("storage_failed", "Assigned brands could not be checked.");
  const brandNames = new Map((brands ?? []).map((row) => [String(row.id), String(row.name)]));
  const scopedLocations = locations.map((row) => ({
    id: String(row.id),
    brandId: String(row.brand_id),
    brandName: brandNames.get(String(row.brand_id)) ?? "",
    name: String(row.name),
    timeZone: String(row.time_zone),
    streetAddress: typeof row.street_address === "string" ? row.street_address : null,
    city: String(row.city),
    region: typeof row.region === "string" ? row.region : null,
    postalCode: typeof row.postal_code === "string" ? row.postal_code : null,
    countryCode: String(row.country_code),
    researchArea: [row.street_address, row.city, row.region, row.postal_code, row.country_code]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", "),
  }));
  if (scopedLocations.some((location) => !location.brandName || !location.timeZone || !location.researchArea)) {
    throw new EmailOperationError("storage_failed", "An assigned location has incomplete delivery settings.");
  }
  return scopedLocations.sort((left, right) => left.name.localeCompare(right.name));
}

export async function loadActiveRecipientScope(
  admin: SupabaseClient,
  workspaceId: string,
  recipientUserId: string,
): Promise<RecipientScope> {
  const [membershipResult, profileResult] = await Promise.all([
    admin.from("ia_workspace_memberships")
      .select("user_id, status, email_enabled")
      .eq("workspace_id", workspaceId)
      .eq("user_id", recipientUserId)
      .maybeSingle(),
    admin.from("ia_profiles")
      .select("email, display_name")
      .eq("user_id", recipientUserId)
      .maybeSingle(),
  ]);
  if (membershipResult.error || profileResult.error) {
    throw new EmailOperationError("storage_failed", "The email recipient could not be checked.");
  }
  const membership = membershipResult.data as { status?: string; email_enabled?: boolean } | null;
  const profile = profileResult.data as { email?: string; display_name?: string } | null;
  if (
    membership?.status !== "active" || membership.email_enabled !== true ||
    !profile?.email || !profile.display_name || !validSender(profile.email)
  ) {
    throw new EmailOperationError(
      "recipient_not_eligible",
      "Choose an active workspace user whose forecast email setting is enabled.",
    );
  }

  const { data: assignments, error: assignmentError } = await admin
    .from("ia_user_location_assignments")
    .select("location_id")
    .eq("workspace_id", workspaceId)
    .eq("user_id", recipientUserId)
    .eq("is_active", true);
  if (assignmentError) throw new EmailOperationError("storage_failed", "Location assignments could not be checked.");
  const locationIds = [...new Set((assignments ?? []).map((row) => String(row.location_id)).filter(Boolean))];
  if (!locationIds.length) {
    throw new EmailOperationError(
      "recipient_has_no_locations",
      "Assign the recipient to at least one active location before sending a forecast email.",
    );
  }

  const scopedLocations = await loadRecipientLocations(admin, workspaceId, locationIds);
  return {
    workspaceId,
    recipientKind: "user",
    recipientKey: `user:${recipientUserId}`,
    recipientUserId,
    recipientContactId: null,
    email: profile.email,
    displayName: profile.display_name,
    locations: scopedLocations,
  };
}

export async function loadActiveEmailContactScope(
  admin: SupabaseClient,
  workspaceId: string,
  scheduleId: string,
  contactId: string,
): Promise<RecipientScope> {
  const { data: contact, error: contactError } = await admin
    .from("ia_email_contacts")
    .select("id, schedule_id, email, display_name, enabled, archived_at")
    .eq("workspace_id", workspaceId)
    .eq("schedule_id", scheduleId)
    .eq("id", contactId)
    .maybeSingle();
  if (contactError) throw new EmailOperationError("storage_failed", "The email contact could not be checked.");
  if (
    !contact || contact.enabled !== true || contact.archived_at ||
    !contact.email || !contact.display_name || !validSender(String(contact.email))
  ) {
    throw new EmailOperationError("recipient_not_eligible", "Choose an enabled additional email recipient.");
  }
  const { data: assignments, error: assignmentError } = await admin
    .from("ia_email_contact_locations")
    .select("location_id")
    .eq("workspace_id", workspaceId)
    .eq("contact_id", contactId);
  if (assignmentError) throw new EmailOperationError("storage_failed", "Contact locations could not be checked.");
  const locationIds = [...new Set((assignments ?? []).map((row) => String(row.location_id)).filter(Boolean))];
  const locations = await loadRecipientLocations(admin, workspaceId, locationIds);
  return {
    workspaceId,
    recipientKind: "contact",
    recipientKey: `contact:${contactId}`,
    recipientUserId: null,
    recipientContactId: contactId,
    email: String(contact.email),
    displayName: String(contact.display_name),
    locations,
  };
}

export function restrictRecipientScope(
  scope: RecipientScope,
  allowedLocationIds: ReadonlySet<string>,
): RecipientScope {
  return { ...scope, locations: scope.locations.filter((location) => allowedLocationIds.has(location.id)) };
}

type ForecastPeriod = { start: string; end: string };

export type CurrentForecastRequirements = {
  policyRevisionId: string;
  historyWatermark: string | null;
};

export async function loadCurrentForecastRequirements(
  admin: SupabaseClient,
  workspaceId: string,
): Promise<CurrentForecastRequirements> {
  const [stateResult, importResult] = await Promise.all([
    admin.from("ia_workspace_analysis_state")
      .select("active_policy_revision_id")
      .eq("workspace_id", workspaceId)
      .maybeSingle(),
    admin.from("ia_import_batches")
      .select("committed_at")
      .eq("workspace_id", workspaceId)
      .eq("status", "committed")
      .order("committed_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (stateResult.error || importResult.error) {
    throw new EmailOperationError("storage_failed", "The current forecast policy and history revision could not be checked.");
  }
  const policyRevisionId = stateResult.data?.active_policy_revision_id
    ? String(stateResult.data.active_policy_revision_id)
    : "";
  if (!policyRevisionId) {
    throw new EmailOperationError("forecast_missing", "Activate the Analysis Skill before sending forecast email.");
  }
  return {
    policyRevisionId,
    historyWatermark: importResult.data?.committed_at ? String(importResult.data.committed_at) : null,
  };
}

type ForecastRunRow = {
  id: string;
  location_id: string;
  period_start: string;
  period_end: string;
  status: DeliverableForecastStatus;
  generated_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export async function loadDeliverableForecasts(input: {
  admin: SupabaseClient;
  scope: RecipientScope;
  exactPeriod?: ForecastPeriod;
  requirements?: CurrentForecastRequirements;
}): Promise<CombinedForecastEmailLocation[]> {
  const requirements = input.requirements ?? await loadCurrentForecastRequirements(
    input.admin,
    input.scope.workspaceId,
  );
  const runResults = await Promise.all(input.scope.locations.map(async (location) => {
    let query = input.admin
      .from("ia_forecast_runs")
      .select("id, location_id, period_start, period_end, status, generated_at, completed_at, created_at")
      .eq("workspace_id", input.scope.workspaceId)
      .eq("location_id", location.id)
      .eq("policy_revision_id", requirements.policyRevisionId)
      .in("status", [...DELIVERABLE_FORECAST_STATUSES]);
    if (requirements.historyWatermark) {
      query = query.gte("created_at", requirements.historyWatermark);
    }
    if (input.exactPeriod) {
      query = query
        .eq("period_start", input.exactPeriod.start)
        .eq("period_end", input.exactPeriod.end);
    }
    const result = await query
      .order("completed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { location, ...result };
  }));
  const failed = runResults.find((result) => result.error);
  if (failed?.error) throw new EmailOperationError("storage_failed", "Stored forecasts could not be checked.");
  const missing = runResults.filter((result) => !result.data).map((result) => result.location.name);
  if (missing.length) {
    const periodMessage = input.exactPeriod
      ? ` for ${input.exactPeriod.start}${input.exactPeriod.start === input.exactPeriod.end ? "" : ` through ${input.exactPeriod.end}`}`
      : "";
    throw new EmailOperationError(
      "forecast_missing",
      `Create a complete, baseline-only, or reviewable stored forecast${periodMessage} for: ${missing.join(", ")}.`,
    );
  }

  const runs = runResults.map((result) => result.data as ForecastRunRow);
  const runIds = runs.map((run) => String(run.id));
  const [itemsResult, sourcesResult] = await Promise.all([
    input.admin.from("ia_forecast_items")
      .select("forecast_run_id, product_id, recommended_quantity, confidence, explanation")
      .eq("workspace_id", input.scope.workspaceId)
      .in("forecast_run_id", runIds),
    input.admin.from("ia_forecast_sources")
      .select("forecast_run_id, title, url")
      .eq("workspace_id", input.scope.workspaceId)
      .in("forecast_run_id", runIds),
  ]);
  if (itemsResult.error || sourcesResult.error) {
    throw new EmailOperationError("storage_failed", "Stored forecast details could not be checked.");
  }
  const productIds = [...new Set((itemsResult.data ?? []).map((row) => String(row.product_id)))];
  if (!productIds.length) throw new EmailOperationError("forecast_invalid", "A stored forecast has no recommendations.");
  const { data: products, error: productError } = await input.admin
    .from("ia_products")
    .select("id, name")
    .eq("workspace_id", input.scope.workspaceId)
    .is("archived_at", null)
    .in("id", productIds);
  if (productError) throw new EmailOperationError("storage_failed", "Forecast products could not be checked.");
  const productNames = new Map((products ?? []).map((row) => [String(row.id), String(row.name)]));
  const runByLocation = new Map(runs.map((run) => [String(run.location_id), run]));

  return input.scope.locations.map((location) => {
    const run = runByLocation.get(location.id);
    if (!run) throw new EmailOperationError("forecast_missing", `A stored forecast is missing for ${location.name}.`);
    const productsForRun = (itemsResult.data ?? [])
      .filter((item) => String(item.forecast_run_id) === String(run.id))
      .map((item) => ({
        name: productNames.get(String(item.product_id)) ?? "",
        recommendedQuantity: Number(item.recommended_quantity),
        confidence: String(item.confidence) as "high" | "medium" | "low",
        explanation: String(item.explanation),
      }));
    if (!productsForRun.length || productsForRun.some((product) => !product.name)) {
      throw new EmailOperationError("forecast_invalid", `The stored forecast for ${location.name} is incomplete.`);
    }
    return {
      locationId: location.id,
      runId: String(run.id),
      brandName: location.brandName,
      locationName: location.name,
      periodStart: String(run.period_start),
      periodEnd: String(run.period_end),
      status: run.status,
      generatedAt: String(run.generated_at || run.completed_at || run.created_at),
      products: productsForRun,
      sources: (sourcesResult.data ?? [])
        .filter((source) => String(source.forecast_run_id) === String(run.id))
        .map((source) => ({ title: String(source.title), url: String(source.url) })),
    };
  });
}

function scopeSignature(scope: RecipientScope): string {
  return JSON.stringify({
    recipientKey: scope.recipientKey,
    email: scope.email.toLocaleLowerCase(),
    locations: scope.locations.map((location) => ({
      id: location.id,
      brandId: location.brandId,
      brandName: location.brandName,
      name: location.name,
      timeZone: location.timeZone,
      researchArea: location.researchArea,
    })).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

export async function verifyCurrentEmailCredential(
  admin: SupabaseClient,
  workspaceId: string,
  delivery: ResolvedResendDelivery,
): Promise<boolean> {
  const { data, error } = await admin.rpc("ia_server_email_verification_matches", {
    p_workspace_id: workspaceId,
    p_credential_fingerprint: delivery.credentialFingerprint,
    p_sender_email: delivery.sender,
  });
  if (error) throw new EmailOperationError("storage_failed", "Email delivery verification could not be checked.");
  return data === true;
}

export async function missingDeliverableForecastLocationIds(input: {
  admin: SupabaseClient;
  workspaceId: string;
  locationIds: readonly string[];
  periodStart: string;
  periodEnd: string;
  requirements?: CurrentForecastRequirements;
}): Promise<string[]> {
  if (!input.locationIds.length) return [];
  const requirements = input.requirements ?? await loadCurrentForecastRequirements(input.admin, input.workspaceId);
  const { data, error } = await input.admin.from("ia_forecast_runs")
    .select("location_id, policy_revision_id, created_at")
    .eq("workspace_id", input.workspaceId)
    .eq("period_start", input.periodStart)
    .eq("period_end", input.periodEnd)
    .eq("policy_revision_id", requirements.policyRevisionId)
    .in("location_id", [...new Set(input.locationIds)])
    .in("status", [...DELIVERABLE_FORECAST_STATUSES]);
  if (error) throw new EmailOperationError("storage_failed", "Existing scheduled forecasts could not be checked.");
  const existing = new Set((data ?? [])
    .filter((row) => !requirements.historyWatermark || new Date(String(row.created_at)).getTime() >= new Date(requirements.historyWatermark).getTime())
    .map((row) => String(row.location_id)));
  return [...new Set(input.locationIds)].filter((locationId) => !existing.has(locationId));
}

export async function sendInternalForecastTest(input: {
  admin: SupabaseClient;
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  environment?: Environment;
  fetch?: typeof fetch;
  now?: Date;
  repositoryPolicyLoader?: () => Promise<AnalysisSkillDocument>;
}): Promise<{ locationCount: number }> {
  const assertCurrentPolicy = async () => {
    try {
      await reconcileAnalysisPolicy({
        admin: input.admin,
        workspaceId: input.workspaceId,
        encryptionKey: stringValue(input.environment ?? process.env, "APP_SECRET_ENCRYPTION_KEY"),
        environment: input.environment,
        repositoryPolicyLoader: input.repositoryPolicyLoader,
      });
    } catch {
      throw new EmailOperationError(
        "forecast_changed",
        "The GitHub Analysis Skill is unavailable or is not the active reviewed policy. Review and activate it before sending email.",
      );
    }
  };
  await assertCurrentPolicy();
  const { data: workspace, error: workspaceError } = await input.admin
    .from("ia_workspaces")
    .select("name, status")
    .eq("id", input.workspaceId)
    .maybeSingle();
  if (workspaceError || !workspace || workspace.status !== "active") {
    throw new EmailOperationError("storage_failed", "The active workspace could not be checked.");
  }
  const [scope, delivery] = await Promise.all([
    loadActiveRecipientScope(input.admin, input.workspaceId, input.recipientUserId),
    resolveResendDelivery({
      admin: input.admin,
      workspaceId: input.workspaceId,
      environment: input.environment,
      requireVerifiedConnection: false,
    }),
  ]);
  let forecasts = await loadDeliverableForecasts({ admin: input.admin, scope });

  // Authorization is intentionally re-read immediately before the provider call.
  const currentScope = await loadActiveRecipientScope(input.admin, input.workspaceId, input.recipientUserId);
  if (scopeSignature(currentScope) !== scopeSignature(scope)) {
    throw new EmailOperationError(
      "recipient_scope_changed",
      "The recipient's location access changed during the test. Review assignments and try again.",
    );
  }
  await assertCurrentPolicy();
  const currentForecasts = await loadDeliverableForecasts({ admin: input.admin, scope: currentScope });
  const runSignature = (rows: readonly CombinedForecastEmailLocation[]) => JSON.stringify(
    rows.map((row) => ({ locationId: row.locationId, runId: row.runId }))
      .sort((left, right) => left.locationId.localeCompare(right.locationId)),
  );
  if (runSignature(currentForecasts) !== runSignature(forecasts)) {
    throw new EmailOperationError(
      "forecast_changed",
      "The forecast set changed during the email test. Review the current forecasts and try again.",
    );
  }
  forecasts = currentForecasts;
  const message = composeCombinedForecastEmail({
    workspaceName: String(workspace.name),
    recipientName: currentScope.displayName,
    locations: forecasts,
    internalTest: true,
  });
  const idempotencyKey = buildInternalTestIdempotencyKey({
    workspaceId: input.workspaceId,
    actorUserId: input.actorUserId,
    recipientUserId: input.recipientUserId,
    runIds: forecasts.map((forecast) => forecast.runId),
    now: input.now,
  });

  let providerMessageId: string;
  try {
    const receipt = await new ResendEmailClient({
      apiKey: delivery.apiKey,
      from: delivery.sender,
      fetch: input.fetch,
    }).send({
      recipient: currentScope.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      idempotencyKey,
    });
    providerMessageId = receipt.id;
  } catch (error) {
    if (error instanceof ResendError) {
      throw new EmailOperationError(
        error.code === "invalid_configuration" ? "resend_not_configured" : "resend_send_failed",
        error.code === "invalid_configuration"
          ? "The Resend sender configuration is invalid."
          : "Resend did not accept the internal test email. Check the connection and verified sender.",
      );
    }
    throw error;
  }

  const { error: verificationError } = await input.admin.rpc("ia_server_mark_email_verified", {
    p_workspace_id: input.workspaceId,
    p_actor_user_id: input.actorUserId,
    p_recipient_user_id: input.recipientUserId,
    p_credential_fingerprint: delivery.credentialFingerprint,
    p_sender_email: delivery.sender,
    p_provider_message_id: providerMessageId,
    p_location_ids: currentScope.locations.map((location) => location.id),
  });
  if (verificationError) {
    throw new EmailOperationError(
      "storage_failed",
      "The test email was accepted, but its verification could not be saved. Keep automatic delivery off and contact the app maintainer.",
    );
  }
  return { locationCount: currentScope.locations.length };
}

export type DeliveryClaim = {
  deliveryId: string;
  attemptId: string;
  attemptNumber: number;
};

export async function claimScheduledDelivery(input: {
  admin: SupabaseClient;
  workspaceId: string;
  scheduleId: string;
  recipientUserId?: string | null;
  recipientContactId?: string | null;
  deliverySource?: "scheduled" | "manual";
  triggeredBy?: string | null;
  manualDedupeKey?: string | null;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  idempotencyKey: string;
  forecasts: readonly CombinedForecastEmailLocation[];
  now?: Date;
}): Promise<DeliveryClaim | null> {
  const now = input.now ?? new Date();
  // Reserve the attempt identity on the delivery before writing child rows. A
  // crashed worker then leaves a pointer that a later worker can compare-swap.
  const attemptId = randomUUID();
  const recipientUserId = input.recipientUserId ?? null;
  const recipientContactId = input.recipientContactId ?? null;
  const deliverySource = input.deliverySource ?? "scheduled";
  const triggeredBy = input.triggeredBy ?? null;
  const manualDedupeKey = input.manualDedupeKey ?? null;
  if ((recipientUserId ? 1 : 0) + (recipientContactId ? 1 : 0) !== 1) {
    throw new EmailOperationError("storage_failed", "The email delivery recipient identity is invalid.");
  }
  if ((deliverySource === "scheduled" && triggeredBy) || (deliverySource === "manual" && !triggeredBy)) {
    throw new EmailOperationError("storage_failed", "The email delivery source identity is invalid.");
  }
  if (
    (deliverySource === "manual") !== Boolean(manualDedupeKey) ||
    (manualDedupeKey && !/^inventory-auditor:manual-dedupe:[0-9a-f]{64}$/.test(manualDedupeKey))
  ) {
    throw new EmailOperationError("storage_failed", "The manual delivery deduplication identity is invalid.");
  }

  const inserted = deliverySource === "manual"
    ? await input.admin.rpc("ia_server_claim_manual_email_delivery", {
      p_workspace_id: input.workspaceId,
      p_schedule_id: input.scheduleId,
      p_recipient_user_id: recipientUserId,
      p_recipient_contact_id: recipientContactId,
      p_triggered_by: triggeredBy,
      p_period_start: input.periodStart,
      p_period_end: input.periodEnd,
      p_due_at: input.dueAt,
      p_idempotency_key: input.idempotencyKey,
      p_manual_dedupe_key: manualDedupeKey,
    }).then(({ data, error }) => ({
      data: data ? { id: data, status: "sending" } : null,
      error,
    }))
    : await input.admin.from("ia_email_deliveries").insert({
      workspace_id: input.workspaceId,
      schedule_id: input.scheduleId,
      recipient_user_id: recipientUserId,
      recipient_contact_id: recipientContactId,
      delivery_source: deliverySource,
      triggered_by: triggeredBy,
      manual_dedupe_key: null,
      forecast_period_start: input.periodStart,
      forecast_period_end: input.periodEnd,
      due_at: input.dueAt,
      status: "sending",
      idempotency_key: input.idempotencyKey,
      current_attempt_id: attemptId,
    }).select("id, status").maybeSingle();

  if (deliverySource === "manual" && !inserted.error && !inserted.data) return null;

  let deliveryId: string;
  let attemptNumber = 1;
  let attemptPointerReserved = false;
  if (!inserted.error && inserted.data) {
    deliveryId = String(inserted.data.id);
    attemptPointerReserved = deliverySource === "scheduled";
  } else if (inserted.error?.code === "23505") {
    const existing = await input.admin.from("ia_email_deliveries")
      .select("id, status, created_at, current_attempt_id")
      .eq("workspace_id", input.workspaceId)
      .eq("idempotency_key", input.idempotencyKey)
      .maybeSingle();
    if (existing.error || !existing.data) {
      throw new EmailOperationError("storage_failed", "The scheduled delivery ledger could not be checked.");
    }
    deliveryId = String(existing.data.id);
    const attempts = await input.admin.from("ia_email_delivery_attempts")
      .select("id, attempt_number, attempted_at, status")
      .eq("workspace_id", input.workspaceId)
      .eq("delivery_id", deliveryId)
      .order("attempt_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (attempts.error) throw new EmailOperationError("storage_failed", "Delivery retry history could not be checked.");
    const previousNumber = Number(attempts.data?.attempt_number ?? 0);
    const previousAt = attempts.data?.attempted_at
      ? new Date(String(attempts.data.attempted_at)).getTime()
      : new Date(String(existing.data.created_at)).getTime();
    if (existing.data.status === "sending") {
      if (!Number.isFinite(previousAt) || now.getTime() - previousAt < 15 * 60_000) return null;
      const expectedAttemptId = existing.data.current_attempt_id
        ? String(existing.data.current_attempt_id)
        : null;
      const staleDeliveryPointer = input.admin.from("ia_email_deliveries")
        .update({ status: "failed", failure_code: "stale_attempt_reclaimed", current_attempt_id: null })
        .eq("workspace_id", input.workspaceId)
        .eq("id", deliveryId)
        .eq("status", "sending");
      const staleDelivery = await (
        expectedAttemptId
          ? staleDeliveryPointer.eq("current_attempt_id", expectedAttemptId)
          // Also recover rows created by older/interrupted workers before an
          // attempt pointer was bound; never compare NULL to an empty string.
          : staleDeliveryPointer.is("current_attempt_id", null)
      )
        .select("id")
        .maybeSingle();
      if (staleDelivery.error) throw new EmailOperationError("storage_failed", "A stale delivery could not be reclaimed.");
      if (!staleDelivery.data) return null;
      if (attempts.data?.status === "started") {
        const staleAttempt = await input.admin.from("ia_email_delivery_attempts")
          .update({ status: "failed", failure_code: "stale_attempt_reclaimed" })
          .eq("workspace_id", input.workspaceId)
          .eq("delivery_id", deliveryId)
          .eq("id", String(attempts.data.id))
          .eq("status", "started")
          .select("id")
          .maybeSingle();
        if (staleAttempt.error || !staleAttempt.data) {
          throw new EmailOperationError("storage_failed", "A stale delivery attempt could not be closed.");
        }
      }
    } else if (existing.data.status !== "failed") {
      return null;
    }
    if (previousNumber >= 3) return null;
    if (previousAt && now.getTime() - previousAt < 15 * 60_000) return null;
    const claimed = await input.admin.from("ia_email_deliveries")
      .update({ status: "sending", failure_code: null, current_attempt_id: attemptId })
      .eq("workspace_id", input.workspaceId)
      .eq("id", deliveryId)
      .eq("status", "failed")
      .select("id")
      .maybeSingle();
    if (claimed.error) throw new EmailOperationError("storage_failed", "The scheduled delivery retry could not be claimed.");
    if (!claimed.data) return null;
    attemptPointerReserved = true;
    attemptNumber = previousNumber + 1;
    const removed = await input.admin.from("ia_email_delivery_locations")
      .delete().eq("workspace_id", input.workspaceId).eq("delivery_id", deliveryId);
    if (removed.error) throw new EmailOperationError("storage_failed", "The scheduled delivery scope could not be refreshed.");
  } else {
    throw new EmailOperationError("storage_failed", "The scheduled delivery could not be claimed safely.");
  }

  if (!attemptPointerReserved) {
    const reserved = await input.admin.from("ia_email_deliveries")
      .update({ current_attempt_id: attemptId })
      .eq("workspace_id", input.workspaceId)
      .eq("id", deliveryId)
      .eq("status", "sending")
      .is("current_attempt_id", null)
      .select("id")
      .maybeSingle();
    if (reserved.error || !reserved.data) {
      throw new EmailOperationError("storage_failed", "The delivery attempt could not be reserved safely.");
    }
  }

  const mappings = input.forecasts.map((forecast) => ({
    workspace_id: input.workspaceId,
    delivery_id: deliveryId,
    location_id: forecast.locationId,
    forecast_run_id: forecast.runId,
  }));
  const mappingResult = await input.admin.from("ia_email_delivery_locations").insert(mappings);
  if (mappingResult.error) {
    await input.admin.from("ia_email_deliveries")
      .update({ status: "failed", failure_code: "delivery_scope_storage_failed", current_attempt_id: null })
      .eq("workspace_id", input.workspaceId).eq("id", deliveryId)
      .eq("status", "sending").eq("current_attempt_id", attemptId);
    throw new EmailOperationError("storage_failed", "The scheduled delivery scope could not be recorded.");
  }
  const attempt = await input.admin.from("ia_email_delivery_attempts").insert({
    id: attemptId,
    workspace_id: input.workspaceId,
    delivery_id: deliveryId,
    attempt_number: attemptNumber,
    status: "started",
  }).select("id").maybeSingle();
  if (attempt.error || !attempt.data || String(attempt.data.id) !== attemptId) {
    await input.admin.from("ia_email_deliveries")
      .update({ status: "failed", failure_code: "delivery_attempt_storage_failed", current_attempt_id: null })
      .eq("workspace_id", input.workspaceId).eq("id", deliveryId)
      .eq("status", "sending").eq("current_attempt_id", attemptId);
    throw new EmailOperationError("storage_failed", "The scheduled delivery attempt could not be recorded.");
  }
  return { deliveryId, attemptId, attemptNumber };
}

export async function finishScheduledDelivery(input: {
  admin: SupabaseClient;
  workspaceId: string;
  claim: DeliveryClaim;
  outcome: "sent" | "failed" | "cancelled";
  providerMessageId?: string;
  failureCode?: string;
}): Promise<void> {
  const { data, error } = await input.admin.rpc("ia_server_finish_email_delivery", {
    p_workspace_id: input.workspaceId,
    p_delivery_id: input.claim.deliveryId,
    p_attempt_id: input.claim.attemptId,
    p_outcome: input.outcome,
    p_provider_message_id: input.outcome === "sent" ? input.providerMessageId ?? null : null,
    p_failure_code: input.outcome === "sent" ? null : input.failureCode || "delivery_failed",
  });
  if (error || data !== true) {
    throw new EmailOperationError("storage_failed", "The scheduled delivery result could not be recorded.");
  }
}

export { scopeSignature };
