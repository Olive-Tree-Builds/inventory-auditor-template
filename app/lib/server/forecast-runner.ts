import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateHistoricalBaselines } from "./historical-baseline";
import type { ActiveForecastVariable, ForecastGrouping, ForecastProduct, HistoricalForecastRow } from "./forecast-provider";
import { OpenAIResponsesForecastProvider } from "./openai-responses-forecast";
import { validateForecastOutput, type ForecastOutput } from "./forecast-output";
import { resolveProviderCredential } from "./credential-resolver";
import { SupabaseCredentialStore } from "./supabase-credential-store";
import {
  AnalysisPolicyUnavailableError,
  reconcileAnalysisPolicy,
  type ActiveAnalysisPolicyRecord,
} from "./analysis-policy";
import { claimForecastGeneration, failForecastGeneration } from "./forecast-claims";
import {
  SupabaseIntegrationConnectionRepository,
  summarizeProviderConnections,
} from "./integration-connections";

type LocationRecord = {
  id: string;
  brand_id: string;
  brand_name: string;
  name: string;
  time_zone: string;
  street_address: string | null;
  city: string;
  region: string | null;
  postal_code: string | null;
  country_code: string;
  research_area: string;
};

type StoredForecast = {
  runId: string;
  locationId: string;
  brandId: string;
  status: string;
  researchCompleted: boolean;
  warning: string | null;
};

const DAY_MS = 86_400_000;

function dateParts(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function utcDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, amount: number) {
  return isoDate(new Date(utcDate(value).getTime() + amount * DAY_MS));
}

function validateExactPeriod(period: { startDate: string; endDate: string }) {
  const start = utcDate(period.startDate);
  const end = utcDate(period.endDate);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(period.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(period.endDate) ||
    isoDate(start) !== period.startDate || isoDate(end) !== period.endDate ||
    end < start || (end.getTime() - start.getTime()) / DAY_MS > 365
  ) throw new Error("The exact forecast period is invalid.");
  return period;
}

export function forecastPeriod(grouping: ForecastGrouping, timeZone: string, now = new Date()) {
  const anchor = dateParts(now, timeZone);
  const date = utcDate(anchor);
  if (grouping === "day") return { startDate: anchor, endDate: anchor };
  if (grouping === "week") {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const startDate = addDays(anchor, -mondayOffset);
    return { startDate, endDate: addDays(startDate, 6) };
  }
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  if (grouping === "month") {
    const startDate = isoDate(new Date(Date.UTC(year, month, 1)));
    return { startDate, endDate: isoDate(new Date(Date.UTC(year, month + 1, 0))) };
  }
  if (grouping === "quarter") {
    const quarterMonth = Math.floor(month / 3) * 3;
    return {
      startDate: isoDate(new Date(Date.UTC(year, quarterMonth, 1))),
      endDate: isoDate(new Date(Date.UTC(year, quarterMonth + 3, 0))),
    };
  }
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

function activeVariables(input: unknown): ActiveForecastVariable[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as { id?: unknown; name?: unknown };
    return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
  });
}

async function aiProvider(input: {
  admin: SupabaseClient;
  workspaceId: string;
  encryptionKey: string;
}): Promise<{ provider: OpenAIResponsesForecastProvider; name: string; model: string } | null> {
  const repository = new SupabaseIntegrationConnectionRepository(input.admin);
  const summaries = summarizeProviderConnections(await repository.list(input.workspaceId));
  const summary = summaries.find((item) => item.provider === "ai");
  if (!summary?.configured || summary.status !== "connected" || !summary.configuration) return null;
  const configuration = summary.configuration as { providerName?: unknown; modelName?: unknown; baseUrl?: unknown };
  if (![configuration.providerName, configuration.modelName, configuration.baseUrl].every((value) => typeof value === "string" && value)) return null;
  const credential = await resolveProviderCredential({
    workspaceId: input.workspaceId,
    provider: "ai",
    name: "apiKey",
    store: new SupabaseCredentialStore(input.admin),
    encryptionKey: input.encryptionKey,
  });
  const name = String(configuration.providerName);
  const model = String(configuration.modelName);
  return {
    name,
    model,
    provider: new OpenAIResponsesForecastProvider({
      apiKey: credential.value,
      providerName: name,
      model,
      baseUrl: String(configuration.baseUrl),
    }),
  };
}

function baselineItems(baselines: ReturnType<typeof calculateHistoricalBaselines>) {
  return baselines.map((baseline) => ({
    product_id: baseline.productId,
    baseline_quantity: baseline.quantity,
    adjustments: [],
    recommended_quantity: baseline.quantity,
    confidence: baseline.confidence,
    explanation: baseline.sampleSize
      ? `Historical baseline from ${baseline.sampleSize} recent comparable observations. No verified external adjustment was applied.`
      : "No comparable historical observations were available; review this zero baseline before using it.",
    source_keys: [],
  }));
}

async function storeResult(input: {
  supabase: SupabaseClient;
  location: LocationRecord;
  policy: ActiveAnalysisPolicyRecord;
  grouping: ForecastGrouping;
  period: { startDate: string; endDate: string };
  historyStart: string;
  historyEnd: string;
  rowsUsed: number;
  output: ForecastOutput | null;
  baselines: ReturnType<typeof calculateHistoricalBaselines>;
  warning: string | null;
  runSource: "manual" | "scheduled" | "email_test";
  actorUserId?: string;
  claimToken: string;
}) {
  const output = input.output;
  const storedAt = new Date().toISOString();
  const items = output ? output.recommendations.map((recommendation) => ({
    product_id: recommendation.product_id,
    baseline_quantity: recommendation.baseline_quantity,
    adjustments: recommendation.adjustments,
    recommended_quantity: recommendation.recommended_quantity,
    confidence: recommendation.confidence,
    explanation: recommendation.explanation,
    source_keys: [...new Set(recommendation.adjustments.flatMap((adjustment) => adjustment.source_ids))],
  })) : baselineItems(input.baselines);
  const sources = output ? output.sources.map((source) => ({
    source_key: source.id,
    title: source.title,
    publisher: source.publisher,
    url: source.url,
    published_or_updated_date: source.published_or_updated_date,
    accessed_at: storedAt,
    fact_used: source.fact_used,
  })) : [];
  const status = output?.status ?? "baseline_only";
  const { data, error } = await input.supabase.rpc("ia_store_forecast_result", {
    p_claim_token: input.claimToken,
    p_run: {
      brand_id: input.location.brand_id,
      location_id: input.location.id,
      policy_revision_id: input.policy.id,
      period_grouping: input.grouping,
      period_start: input.period.startDate,
      period_end: input.period.endDate,
      location_time_zone: input.location.time_zone,
      status,
      run_source: input.runSource,
      actor_user_id: input.runSource === "scheduled" ? null : input.actorUserId ?? null,
      research_completed: output?.method.research_completed ?? false,
      ai_provider: output?.audit.ai_provider ?? "",
      ai_model: output?.audit.ai_model ?? "",
      provider_request_id: output?.audit.run_id ?? "",
      baseline_method: output?.method.baseline_method ?? input.baselines[0]?.method ?? "Historical baseline",
      adjustment_method: output?.method.adjustment_method ?? "No external adjustment",
      rounding_rule: output?.method.rounding_rule ?? "Round to the nearest whole unit and never below zero.",
      historical_start_date: input.historyStart,
      historical_end_date: input.historyEnd,
      rows_used: input.rowsUsed,
      data_quality_issues: output?.data_quality.issues ?? (input.rowsUsed ? [] : ["No historical rows were available."]),
      warnings: [...(output?.warnings ?? []), ...(input.warning ? [input.warning] : [])],
      generated_at: storedAt,
    },
    p_items: items,
    p_sources: sources,
  });
  if (error) throw new Error("The forecast was calculated but could not be stored safely.");
  const row = Array.isArray(data) ? data[0] : data;
  const runId = String((row as { run_id?: unknown } | null)?.run_id || "");
  if (!runId) throw new Error("Supabase did not return a forecast receipt.");
  return { runId, status, researchCompleted: output?.method.research_completed ?? false };
}

export async function runWorkspaceForecasts(input: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  workspaceId: string;
  locations: LocationRecord[];
  grouping: ForecastGrouping;
  runSource?: "manual" | "scheduled" | "email_test";
  encryptionKey: string;
  periodOverride?: { startDate: string; endDate: string };
  /** Authorized run actor; omitted only for scheduled service work. */
  actorUserId?: string;
  /** Set only when the run actor is an active workspace administrator. */
  policyActivationActorUserId?: string;
}): Promise<StoredForecast[]> {
  const runSource = input.runSource ?? "manual";
  if (runSource !== "scheduled" && !input.actorUserId) {
    throw new Error("An authorized forecast actor is required.");
  }
  const policy = await reconcileAnalysisPolicy({
    admin: input.admin,
    workspaceId: input.workspaceId,
    encryptionKey: input.encryptionKey,
    actorUserId: input.policyActivationActorUserId,
  });
  const variables = activeVariables(policy.active_variables);
  let provider: Awaited<ReturnType<typeof aiProvider>> = null;
  let providerWarning: string | null = null;
  if (variables.length) {
    try {
      provider = await aiProvider({ admin: input.admin, workspaceId: input.workspaceId, encryptionKey: input.encryptionKey });
      if (!provider) providerWarning = "AI live research is not connected and tested; this run is historical baseline only.";
    } catch {
      providerWarning = "AI live research could not be used; this run is historical baseline only.";
    }
  }

  const stored: StoredForecast[] = [];
  const exactPeriod = input.periodOverride ? validateExactPeriod(input.periodOverride) : null;
  for (const location of input.locations) {
    const period = exactPeriod ?? forecastPeriod(input.grouping, location.time_zone);
    const claimToken = await claimForecastGeneration({
      admin: input.admin,
      workspaceId: input.workspaceId,
      locationId: location.id,
      period,
      policyRevisionId: policy.id,
      runSource,
      actorUserId: input.actorUserId,
    });
    if (!claimToken) continue;

    try {
    const historyEnd = addDays(period.startDate, -1);
    const historyStart = addDays(historyEnd, -730);
    const { data, error } = await input.supabase.rpc("ia_forecast_input", {
      p_location_id: location.id,
      p_history_start: historyStart,
      p_history_end: historyEnd,
    });
    if (error) throw new Error(`Historical data for ${location.name} could not be loaded.`);
    const rows = (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>;
    const products: ForecastProduct[] = [...new Map(rows.map((row) => [String(row.product_id), { id: String(row.product_id), name: String(row.product_name) }])).values()];
    if (!products.length) throw new Error(`${location.name} has no imported product history to forecast.`);
    const historicalRows: HistoricalForecastRow[] = rows.map((row) => ({
      date: String(row.business_date), locationId: String(row.location_id), productId: String(row.product_id), product: String(row.product_name), quantity: Number(row.quantity),
    }));
    const baselines = calculateHistoricalBaselines({ historicalRows, locations: [location.id], products, startDate: period.startDate, endDate: period.endDate });
    let output: ForecastOutput | null = null;
    let warning = variables.length ? providerWarning : "No external variables are active in the Analysis Skill; this run is historical baseline only.";
    if (variables.length && provider) {
      try {
        const requestId = randomUUID();
        const raw = await provider.provider.generate({
          requestId,
          analysisPolicy: policy.markdown_content,
          policySha256: policy.sha256,
          scope: {
            workspaceId: input.workspaceId,
            brandId: location.brand_id,
            brandName: location.brand_name,
            locationIds: [location.id],
            timeZone: location.time_zone,
            locations: [{
              id: location.id,
              name: location.name,
              brandId: location.brand_id,
              brandName: location.brand_name,
              timeZone: location.time_zone,
              streetAddress: location.street_address,
              city: location.city,
              region: location.region,
              postalCode: location.postal_code,
              countryCode: location.country_code,
              researchArea: location.research_area,
            }],
          },
          period: { grouping: input.grouping, startDate: period.startDate, endDate: period.endDate },
          products,
          activeVariables: variables,
          historicalRows,
          baselines,
        });
        output = validateForecastOutput(raw, {
          runId: requestId,
          workspaceId: input.workspaceId,
          brandId: location.brand_id,
          locationIds: [location.id],
          timeZone: location.time_zone,
          products,
          baselines,
          activeVariables: variables,
          period: { grouping: input.grouping, startDate: period.startDate, endDate: period.endDate },
          history: { startDate: historyStart, endDate: historyEnd, rowsUsed: rows.length },
          serverTimestamp: new Date().toISOString(),
          policy: { id: policy.policy_id, version: policy.policy_version, sha256: policy.sha256, outputSchemaVersion: policy.output_schema_version },
          provider: { name: provider.name, model: provider.model },
        });
        warning = null;
      } catch {
        output = null;
        warning = "Live research failed validation; this run was stored as historical baseline only. Review the AI connection before relying on multivariate forecasting.";
      }
    }
    const currentPolicy = await reconcileAnalysisPolicy({
      admin: input.admin,
      workspaceId: input.workspaceId,
      encryptionKey: input.encryptionKey,
      actorUserId: input.policyActivationActorUserId,
    });
    if (currentPolicy.id !== policy.id || currentPolicy.sha256 !== policy.sha256) {
      throw new AnalysisPolicyUnavailableError(
        "ANALYSIS_SKILL.md changed during forecast generation. Run the forecast again with the current policy.",
      );
    }
    const receipt = await storeResult({
      supabase: input.admin, location, policy, grouping: input.grouping, period,
      historyStart, historyEnd, rowsUsed: rows.length, output, baselines, warning,
      runSource,
      actorUserId: input.actorUserId,
      claimToken,
    });
    stored.push({ ...receipt, locationId: location.id, brandId: location.brand_id, warning });
    } catch (error) {
      try {
        await failForecastGeneration({
          admin: input.admin,
          workspaceId: input.workspaceId,
          locationId: location.id,
          period,
          policyRevisionId: policy.id,
          runSource,
          actorUserId: input.actorUserId,
          claimToken,
        });
      } catch {
        // The 15-minute claim timeout permits a safe retry if finalization is unavailable.
      }
      throw error;
    }
  }
  return stored;
}
