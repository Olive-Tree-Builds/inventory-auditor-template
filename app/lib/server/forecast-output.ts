import type { ActiveForecastVariable, ForecastGrouping, ForecastProduct } from "./forecast-provider";

export const FORECAST_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "scope", "forecast_period", "policy", "method", "recommendations", "sources", "data_quality", "warnings", "audit"],
  properties: {
    status: { type: "string", enum: ["complete", "baseline_only", "needs_review", "policy_unavailable"] },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["workspace_id", "brand_id", "location_ids", "timezone"],
      properties: {
        workspace_id: { type: "string" },
        brand_id: { type: "string" },
        location_ids: { type: "array", items: { type: "string" } },
        timezone: { type: "string" },
      },
    },
    forecast_period: {
      type: "object",
      additionalProperties: false,
      required: ["grouping", "start_date", "end_date"],
      properties: {
        grouping: { type: "string", enum: ["day", "week", "month", "quarter", "year"] },
        start_date: { type: "string" },
        end_date: { type: "string" },
      },
    },
    policy: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version", "sha256", "output_schema_version"],
      properties: {
        id: { type: "string" },
        version: { type: "string" },
        sha256: { type: "string" },
        output_schema_version: { type: "string" },
      },
    },
    method: {
      type: "object",
      additionalProperties: false,
      required: ["baseline_method", "adjustment_method", "rounding_rule", "research_completed"],
      properties: {
        baseline_method: { type: "string" },
        adjustment_method: { type: "string" },
        rounding_rule: { type: "string" },
        research_completed: { type: "boolean" },
      },
    },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["location_id", "product_id", "product", "baseline_quantity", "adjustments", "recommended_quantity", "confidence", "explanation"],
        properties: {
          location_id: { type: "string" },
          product_id: { type: "string" },
          product: { type: "string" },
          baseline_quantity: { type: "integer", minimum: 0 },
          adjustments: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: [
                "variable_id", "variable", "historical_basis", "direction", "adjustment_percent",
                "confidence", "relevance", "evidence", "source_ids", "rough_direction",
                "rough_adjustment_percent", "rough_confidence", "rough_reasoning",
              ],
              properties: {
                variable_id: { type: "string" },
                variable: { type: "string" },
                historical_basis: { type: "string", enum: ["supported", "unavailable", "not_relevant"] },
                direction: { type: "string", enum: ["increase", "decrease", "neutral"] },
                adjustment_percent: { type: "number" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                relevance: { type: "string" },
                evidence: { type: "string" },
                source_ids: { type: "array", items: { type: "string" } },
                rough_direction: { type: "string", enum: ["increase", "decrease", "neutral"] },
                rough_adjustment_percent: { type: "number" },
                rough_confidence: { type: "string", enum: ["low"] },
                rough_reasoning: { type: "string" },
              },
            },
          },
          recommended_quantity: { type: "integer", minimum: 0 },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          explanation: { type: "string" },
        },
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "publisher", "url", "published_or_updated_date", "accessed_at", "fact_used"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string" },
          url: { type: "string" },
          published_or_updated_date: { anyOf: [{ type: "string" }, { type: "null" }] },
          accessed_at: { type: "string" },
          fact_used: { type: "string" },
        },
      },
    },
    data_quality: {
      type: "object",
      additionalProperties: false,
      required: ["historical_start_date", "historical_end_date", "rows_used", "issues"],
      properties: {
        historical_start_date: { type: "string" },
        historical_end_date: { type: "string" },
        rows_used: { type: "integer", minimum: 0 },
        issues: { type: "array", items: { type: "string" } },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
    audit: {
      type: "object",
      additionalProperties: false,
      required: ["run_id", "generated_at", "ai_provider", "ai_model"],
      properties: {
        run_id: { type: "string" },
        generated_at: { type: "string" },
        ai_provider: { type: "string" },
        ai_model: { type: "string" },
      },
    },
  },
} as const;

export type ForecastOutput = {
  status: "complete" | "baseline_only" | "needs_review" | "policy_unavailable";
  scope: { workspace_id: string; brand_id: string; location_ids: string[]; timezone: string };
  forecast_period: { grouping: ForecastGrouping; start_date: string; end_date: string };
  policy: { id: string; version: string; sha256: string; output_schema_version: string };
  method: { baseline_method: string; adjustment_method: string; rounding_rule: string; research_completed: boolean };
  recommendations: Array<{
    location_id: string;
    product_id: string;
    product: string;
    baseline_quantity: number;
    adjustments: Array<{
      variable_id: string;
      variable: string;
      historical_basis: "supported" | "unavailable" | "not_relevant";
      direction: "increase" | "decrease" | "neutral";
      adjustment_percent: number;
      confidence: "high" | "medium" | "low";
      relevance: string;
      evidence: string;
      source_ids: string[];
      rough_direction: "increase" | "decrease" | "neutral";
      rough_adjustment_percent: number;
      rough_confidence: "low";
      rough_reasoning: string;
    }>;
    recommended_quantity: number;
    confidence: "high" | "medium" | "low";
    explanation: string;
  }>;
  sources: Array<{
    id: string;
    title: string;
    publisher: string;
    url: string;
    published_or_updated_date: string | null;
    accessed_at: string;
    fact_used: string;
  }>;
  data_quality: { historical_start_date: string; historical_end_date: string; rows_used: number; issues: string[] };
  warnings: string[];
  audit: { run_id: string; generated_at: string; ai_provider: string; ai_model: string };
};

export type ForecastValidationContext = {
  runId: string;
  workspaceId: string;
  brandId: string;
  locationIds: string[];
  timeZone: string;
  products: ForecastProduct[];
  baselines: Array<{ locationId: string; productId: string; quantity: number }>;
  activeVariables: ActiveForecastVariable[];
  period: { grouping: ForecastGrouping; startDate: string; endDate: string };
  history: { startDate: string; endDate: string; rowsUsed: number };
  /** Host timestamp captured after the provider response is received. */
  serverTimestamp: string;
  policy: { id: string; version: string; sha256: string; outputSchemaVersion: string };
  provider: { name: string; model: string };
  maxQuantity?: number;
  maxAbsAdjustmentPercent?: number;
  maxAbsRoughFactorAdjustmentPercent?: number;
  maxAbsCombinedRoughAdjustmentPercent?: number;
};

export class ForecastOutputValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("The forecast provider returned an invalid or out-of-scope result.");
    this.name = "ForecastOutputValidationError";
    this.issues = issues;
  }
}

type UnknownRecord = Record<string, unknown>;

function object(value: unknown, path: string, issues: string[]): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return {};
  }
  return value as UnknownRecord;
}

function string(record: UnknownRecord, key: string, path: string, issues: string[]): string {
  const candidate = record[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    issues.push(`${path}.${key} must be a non-empty string.`);
    return "";
  }
  return candidate;
}

function stringArray(record: UnknownRecord, key: string, path: string, issues: string[]): string[] {
  const candidate = record[key];
  if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issues.push(`${path}.${key} must be an array of non-empty strings.`);
    return [];
  }
  return candidate as string[];
}

function number(record: UnknownRecord, key: string, path: string, issues: string[]): number {
  const candidate = record[key];
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    issues.push(`${path}.${key} must be a finite number.`);
    return Number.NaN;
  }
  return candidate;
}

function integer(record: UnknownRecord, key: string, path: string, issues: string[]): number {
  const candidate = number(record, key, path, issues);
  if (Number.isFinite(candidate) && !Number.isInteger(candidate)) issues.push(`${path}.${key} must be a whole number.`);
  return candidate;
}

function boolean(record: UnknownRecord, key: string, path: string, issues: string[]): boolean {
  const candidate = record[key];
  if (typeof candidate !== "boolean") issues.push(`${path}.${key} must be a boolean.`);
  return candidate === true;
}

function isDateOnly(candidate: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return false;
  try {
    return new Date(`${candidate}T00:00:00.000Z`).toISOString().slice(0, 10) === candidate;
  } catch {
    return false;
  }
}

function isIsoTimestamp(candidate: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T/.test(candidate) && Number.isFinite(Date.parse(candidate));
}

function exactSet(actual: string[], expected: string[]): boolean {
  return actual.length === new Set(actual).size && actual.length === expected.length && expected.every((entry) => actual.includes(entry));
}

function isDirectHttpsUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.replace(/^www\./, "").toLocaleLowerCase();
    if ((host.endsWith("google.com") || host === "bing.com") && url.pathname.startsWith("/search")) return false;
    if (host === "search.yahoo.com" || host === "duckduckgo.com") return false;
    return true;
  } catch {
    return false;
  }
}

function enumValue(value: string, allowed: readonly string[], path: string, issues: string[]): void {
  if (value && !allowed.includes(value)) issues.push(`${path} is unsupported.`);
}

export function validateForecastOutput(raw: unknown, context: ForecastValidationContext): ForecastOutput {
  const issues: string[] = [];
  const root = object(raw, "forecast", issues);
  const status = string(root, "status", "forecast", issues);
  enumValue(status, ["complete", "baseline_only", "needs_review", "policy_unavailable"], "forecast.status", issues);
  if (status === "policy_unavailable") issues.push("The AI provider cannot declare policy_unavailable; the host must stop before calling it.");

  const scope = object(root.scope, "forecast.scope", issues);
  const workspaceId = string(scope, "workspace_id", "forecast.scope", issues);
  const brandId = string(scope, "brand_id", "forecast.scope", issues);
  const locationIds = stringArray(scope, "location_ids", "forecast.scope", issues);
  const timeZone = string(scope, "timezone", "forecast.scope", issues);
  if (workspaceId !== context.workspaceId) issues.push("forecast.scope.workspace_id is outside the authorized workspace.");
  if (brandId !== context.brandId) issues.push("forecast.scope.brand_id is outside the authorized brand.");
  if (!exactSet(locationIds, context.locationIds)) issues.push("forecast.scope.location_ids must exactly match the authorized request.");
  if (timeZone !== context.timeZone) issues.push("forecast.scope.timezone does not match the authorized request.");

  const period = object(root.forecast_period, "forecast.forecast_period", issues);
  const grouping = string(period, "grouping", "forecast.forecast_period", issues);
  const startDate = string(period, "start_date", "forecast.forecast_period", issues);
  const endDate = string(period, "end_date", "forecast.forecast_period", issues);
  enumValue(grouping, ["day", "week", "month", "quarter", "year"], "forecast.forecast_period.grouping", issues);
  if (!isDateOnly(startDate) || !isDateOnly(endDate)) issues.push("Forecast dates must be valid date-only values.");
  if (grouping !== context.period.grouping || startDate !== context.period.startDate || endDate !== context.period.endDate) {
    issues.push("forecast.forecast_period does not exactly match the requested period.");
  }

  const policy = object(root.policy, "forecast.policy", issues);
  const policyId = string(policy, "id", "forecast.policy", issues);
  const policyVersion = string(policy, "version", "forecast.policy", issues);
  const policySha = string(policy, "sha256", "forecast.policy", issues);
  const outputSchemaVersion = string(policy, "output_schema_version", "forecast.policy", issues);
  if (
    policyId !== context.policy.id || policyVersion !== context.policy.version ||
    policySha !== context.policy.sha256 || outputSchemaVersion !== context.policy.outputSchemaVersion
  ) issues.push("forecast.policy does not match the host-verified policy revision.");

  const method = object(root.method, "forecast.method", issues);
  string(method, "baseline_method", "forecast.method", issues);
  string(method, "adjustment_method", "forecast.method", issues);
  string(method, "rounding_rule", "forecast.method", issues);
  const researchCompleted = boolean(method, "research_completed", "forecast.method", issues);
  if (status === "complete" && !researchCompleted) issues.push("A complete multivariate forecast must confirm live research.");
  if (status === "baseline_only" && researchCompleted) issues.push("A baseline-only forecast cannot claim live research.");
  if (context.activeVariables.length === 0 && researchCompleted) issues.push("Live external research is forbidden when no variables are active.");
  if (status === "complete" && context.activeVariables.length === 0) issues.push("An empty active-variable set must produce baseline_only, not complete.");

  const sourceRows = root.sources;
  if (!Array.isArray(sourceRows)) issues.push("forecast.sources must be an array.");
  const sourceIds = new Set<string>();
  const sources = Array.isArray(sourceRows) ? sourceRows : [];
  sources.forEach((entry, index) => {
    const path = `forecast.sources[${index}]`;
    const source = object(entry, path, issues);
    const id = string(source, "id", path, issues);
    string(source, "title", path, issues);
    string(source, "publisher", path, issues);
    const url = string(source, "url", path, issues);
    const published = source.published_or_updated_date;
    const accessedAt = string(source, "accessed_at", path, issues);
    string(source, "fact_used", path, issues);
    if (id && sourceIds.has(id)) issues.push(`${path}.id is duplicated.`);
    if (id) sourceIds.add(id);
    if (!isDirectHttpsUrl(url)) issues.push(`${path}.url must be a direct HTTPS source URL, not a search result.`);
    if (published !== null && (typeof published !== "string" || !isDateOnly(published))) {
      issues.push(`${path}.published_or_updated_date must be a date-only value or null.`);
    }
    if (!isIsoTimestamp(accessedAt)) issues.push(`${path}.accessed_at must be an ISO timestamp.`);
  });

  const maxQuantity = context.maxQuantity ?? 1_000_000;
  const maxAbsAdjustment = context.maxAbsAdjustmentPercent ?? 100;
  const maxAbsFactorAdjustment = Math.min(25, maxAbsAdjustment);
  const maxAbsRoughFactorAdjustment = context.maxAbsRoughFactorAdjustmentPercent ?? 15;
  const maxAbsCombinedRoughAdjustment = context.maxAbsCombinedRoughAdjustmentPercent ?? 30;
  const variableNames = new Map(context.activeVariables.map((entry) => [entry.id, entry.name]));
  const productNames = new Map(context.products.map((entry) => [entry.id, entry.name]));
  const baselineQuantities = new Map(context.baselines.map((entry) => [`${entry.locationId}\u0000${entry.productId}`, entry.quantity]));
  if (variableNames.size !== context.activeVariables.length) issues.push("Host active-variable IDs are not unique.");
  if (productNames.size !== context.products.length) issues.push("Host product IDs are not unique.");
  if (baselineQuantities.size !== context.baselines.length) issues.push("Host baseline location/product pairs are not unique.");
  if (context.baselines.some((entry) => !Number.isInteger(entry.quantity) || entry.quantity < 0 || entry.quantity > maxQuantity)) {
    issues.push("Host baseline quantities are outside the permitted range.");
  }

  const recommendationRows = root.recommendations;
  if (!Array.isArray(recommendationRows)) issues.push("forecast.recommendations must be an array.");
  const recommendations = Array.isArray(recommendationRows) ? recommendationRows : [];
  const seenPairs = new Set<string>();
  const referencedSourceIds = new Set<string>();
  recommendations.forEach((entry, index) => {
    const path = `forecast.recommendations[${index}]`;
    const recommendation = object(entry, path, issues);
    const locationId = string(recommendation, "location_id", path, issues);
    const productId = string(recommendation, "product_id", path, issues);
    const product = string(recommendation, "product", path, issues);
    const baseline = integer(recommendation, "baseline_quantity", path, issues);
    const recommended = integer(recommendation, "recommended_quantity", path, issues);
    const confidence = string(recommendation, "confidence", path, issues);
    string(recommendation, "explanation", path, issues);
    enumValue(confidence, ["high", "medium", "low"], `${path}.confidence`, issues);
    if (!context.locationIds.includes(locationId)) issues.push(`${path}.location_id is outside the authorized location scope.`);
    if (!productNames.has(productId)) issues.push(`${path}.product_id is outside the requested product scope.`);
    if (productNames.has(productId) && product !== productNames.get(productId)) issues.push(`${path}.product does not match the authorized product ID.`);
    if (!Number.isInteger(baseline) || baseline < 0 || baseline > maxQuantity) issues.push(`${path}.baseline_quantity is outside the permitted range.`);
    if (!Number.isInteger(recommended) || recommended < 0 || recommended > maxQuantity) issues.push(`${path}.recommended_quantity is outside the permitted range.`);
    const pair = `${locationId}\u0000${productId}`;
    if (seenPairs.has(pair)) issues.push(`${path} duplicates a location/product recommendation.`);
    seenPairs.add(pair);
    if (!baselineQuantities.has(pair) || baseline !== baselineQuantities.get(pair)) {
      issues.push(`${path}.baseline_quantity does not match the host-calculated baseline.`);
    }

    const adjustmentRows = recommendation.adjustments;
    if (!Array.isArray(adjustmentRows)) issues.push(`${path}.adjustments must be an array.`);
    const adjustments = Array.isArray(adjustmentRows) ? adjustmentRows : [];
    const seenVariables = new Set<string>();
    let adjustmentTotal = 0;
    let roughAdjustmentTotal = 0;
    adjustments.forEach((adjustmentEntry, adjustmentIndex) => {
      const adjustmentPath = `${path}.adjustments[${adjustmentIndex}]`;
      const adjustment = object(adjustmentEntry, adjustmentPath, issues);
      const variableId = string(adjustment, "variable_id", adjustmentPath, issues);
      const variable = string(adjustment, "variable", adjustmentPath, issues);
      const historicalBasis = string(adjustment, "historical_basis", adjustmentPath, issues);
      const direction = string(adjustment, "direction", adjustmentPath, issues);
      const percent = number(adjustment, "adjustment_percent", adjustmentPath, issues);
      const adjustmentConfidence = string(adjustment, "confidence", adjustmentPath, issues);
      string(adjustment, "relevance", adjustmentPath, issues);
      string(adjustment, "evidence", adjustmentPath, issues);
      const adjustmentSourceIds = stringArray(adjustment, "source_ids", adjustmentPath, issues);
      const roughDirection = string(adjustment, "rough_direction", adjustmentPath, issues);
      const roughPercent = number(adjustment, "rough_adjustment_percent", adjustmentPath, issues);
      const roughConfidence = string(adjustment, "rough_confidence", adjustmentPath, issues);
      string(adjustment, "rough_reasoning", adjustmentPath, issues);
      enumValue(historicalBasis, ["supported", "unavailable", "not_relevant"], `${adjustmentPath}.historical_basis`, issues);
      enumValue(direction, ["increase", "decrease", "neutral"], `${adjustmentPath}.direction`, issues);
      enumValue(adjustmentConfidence, ["high", "medium", "low"], `${adjustmentPath}.confidence`, issues);
      enumValue(roughDirection, ["increase", "decrease", "neutral"], `${adjustmentPath}.rough_direction`, issues);
      if (!variableNames.has(variableId)) issues.push(`${adjustmentPath}.variable_id is not active for this run.`);
      if (variableNames.has(variableId) && variable !== variableNames.get(variableId)) issues.push(`${adjustmentPath}.variable does not match the active variable snapshot.`);
      if (seenVariables.has(variableId)) issues.push(`${adjustmentPath}.variable_id is duplicated for this recommendation.`);
      if (variableId) seenVariables.add(variableId);
      if (!Number.isFinite(percent) || Math.abs(percent) > maxAbsFactorAdjustment) issues.push(`${adjustmentPath}.adjustment_percent exceeds the configured safety bound.`);
      if ((percent > 0 && direction !== "increase") || (percent < 0 && direction !== "decrease") || (percent === 0 && direction !== "neutral")) {
        issues.push(`${adjustmentPath}.direction does not match its signed adjustment.`);
      }
      if (!Number.isFinite(roughPercent) || Math.abs(roughPercent) > maxAbsRoughFactorAdjustment) issues.push(`${adjustmentPath}.rough_adjustment_percent exceeds the configured rough safety bound.`);
      if ((roughPercent > 0 && roughDirection !== "increase") || (roughPercent < 0 && roughDirection !== "decrease") || (roughPercent === 0 && roughDirection !== "neutral")) {
        issues.push(`${adjustmentPath}.rough_direction does not match its signed rough adjustment.`);
      }
      if (roughConfidence !== "low") issues.push(`${adjustmentPath}.rough_confidence must remain low.`);
      if (historicalBasis === "supported" && roughPercent !== 0) issues.push(`${adjustmentPath} cannot use a rough adjustment with supported factor history.`);
      if (historicalBasis === "unavailable" && (percent !== 0 || direction !== "neutral" || adjustmentConfidence !== "low")) {
        issues.push(`${adjustmentPath} must keep the evidence-backed track neutral and low-confidence when factor history is unavailable.`);
      }
      if (historicalBasis === "not_relevant" && (percent !== 0 || roughPercent !== 0 || direction !== "neutral" || roughDirection !== "neutral")) {
        issues.push(`${adjustmentPath} must keep both tracks neutral when the factor is not relevant.`);
      }
      if (researchCompleted && adjustmentSourceIds.length === 0) issues.push(`${adjustmentPath} needs a direct source showing that the factor was researched.`);
      if (adjustmentSourceIds.length !== new Set(adjustmentSourceIds).size) issues.push(`${adjustmentPath}.source_ids contains duplicates.`);
      adjustmentSourceIds.forEach((sourceId) => {
        referencedSourceIds.add(sourceId);
        if (!sourceIds.has(sourceId)) issues.push(`${adjustmentPath} references an unknown source ID.`);
      });
      if (Number.isFinite(percent)) adjustmentTotal += percent;
      if (Number.isFinite(roughPercent)) roughAdjustmentTotal += roughPercent;
    });

    if (researchCompleted && !exactSet([...seenVariables], context.activeVariables.map((variable) => variable.id))) {
      issues.push(`${path}.adjustments must assess every active variable exactly once.`);
    }
    if (!researchCompleted && adjustments.length) issues.push(`${path}.adjustments must be empty when research was not completed.`);
    if (Math.abs(adjustmentTotal) > maxAbsAdjustment) issues.push(`${path} has an unsafe combined adjustment magnitude.`);
    if (Math.abs(roughAdjustmentTotal) > maxAbsCombinedRoughAdjustment) issues.push(`${path} has an unsafe combined rough adjustment magnitude.`);
    if (Math.abs(adjustmentTotal + roughAdjustmentTotal) > maxAbsAdjustment) issues.push(`${path} has an unsafe combined AI-advised adjustment magnitude.`);
    if (status === "complete" && roughAdjustmentTotal !== 0) issues.push(`${path} uses a rough estimate and must be marked needs_review.`);
    if (Number.isFinite(baseline)) {
      const reconciled = Math.max(0, Math.round(baseline * (1 + adjustmentTotal / 100 + roughAdjustmentTotal / 100)));
      if (recommended !== reconciled) issues.push(`${path}.recommended_quantity does not reconcile with the baseline and adjustments.`);
    }
  });

  const expectedPairs = context.locationIds.flatMap((locationId) => context.products.map((product) => `${locationId}\u0000${product.id}`));
  if (!exactSet([...baselineQuantities.keys()], expectedPairs)) issues.push("Host baselines must cover every requested location/product pair exactly once.");
  if (!exactSet([...seenPairs], expectedPairs)) issues.push("Forecast recommendations must cover every requested location/product pair exactly once.");
  if (!researchCompleted && sources.length) issues.push("Sources must be empty when live research was not completed.");
  sourceIds.forEach((sourceId) => {
    if (!referencedSourceIds.has(sourceId)) issues.push(`Source “${sourceId}” is not referenced by an adjustment.`);
  });

  const dataQuality = object(root.data_quality, "forecast.data_quality", issues);
  const historicalStart = string(dataQuality, "historical_start_date", "forecast.data_quality", issues);
  const historicalEnd = string(dataQuality, "historical_end_date", "forecast.data_quality", issues);
  const rowsUsed = integer(dataQuality, "rows_used", "forecast.data_quality", issues);
  stringArray(dataQuality, "issues", "forecast.data_quality", issues);
  if (!isDateOnly(historicalStart) || !isDateOnly(historicalEnd) || historicalStart > historicalEnd) {
    issues.push("forecast.data_quality historical dates are invalid.");
  }
  if (!Number.isInteger(rowsUsed) || rowsUsed < 0) issues.push("forecast.data_quality.rows_used must be a non-negative whole number.");
  if (
    !isDateOnly(context.history.startDate) || !isDateOnly(context.history.endDate) ||
    context.history.startDate > context.history.endDate ||
    !Number.isInteger(context.history.rowsUsed) || context.history.rowsUsed < 0
  ) {
    issues.push("The host historical input audit is invalid.");
  }
  if (
    historicalStart !== context.history.startDate ||
    historicalEnd !== context.history.endDate ||
    rowsUsed !== context.history.rowsUsed
  ) {
    issues.push("forecast.data_quality must exactly match the host-owned historical input audit.");
  }
  stringArray(root, "warnings", "forecast", issues);

  const audit = object(root.audit, "forecast.audit", issues);
  const runId = string(audit, "run_id", "forecast.audit", issues);
  const generatedAt = string(audit, "generated_at", "forecast.audit", issues);
  const provider = string(audit, "ai_provider", "forecast.audit", issues);
  const model = string(audit, "ai_model", "forecast.audit", issues);
  if (!isIsoTimestamp(generatedAt)) issues.push("forecast.audit.generated_at must be an ISO timestamp.");
  if (!isIsoTimestamp(context.serverTimestamp)) issues.push("The host validation timestamp is invalid.");
  if (runId !== context.runId) issues.push("forecast.audit.run_id does not match the host run identifier.");
  if (provider !== context.provider.name || model !== context.provider.model) issues.push("forecast.audit provider metadata does not match the configured provider.");

  if (issues.length) throw new ForecastOutputValidationError(issues);
  const validated = raw as ForecastOutput;
  return {
    ...validated,
    sources: validated.sources.map((source) => ({
      ...source,
      accessed_at: context.serverTimestamp,
    })),
    data_quality: {
      ...validated.data_quality,
      historical_start_date: context.history.startDate,
      historical_end_date: context.history.endDate,
      rows_used: context.history.rowsUsed,
    },
    audit: {
      ...validated.audit,
      generated_at: context.serverTimestamp,
    },
  };
}
