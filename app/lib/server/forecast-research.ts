import type { ActiveForecastVariable, ForecastProduct, HistoricalBaseline } from "./forecast-provider";
import {
  validateForecastOutput,
  type ForecastOutput,
  type ForecastValidationContext,
} from "./forecast-output";

export const FORECAST_RESEARCH_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "assessments", "sources", "warnings"],
  properties: {
    status: { type: "string", enum: ["complete", "needs_review"] },
    assessments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["location_id", "product_id", "variable_id", "direction", "adjustment_percent", "confidence", "relevance", "evidence", "source_ids"],
        properties: {
          location_id: { type: "string" },
          product_id: { type: "string" },
          variable_id: { type: "string" },
          direction: { type: "string", enum: ["increase", "decrease", "neutral"] },
          adjustment_percent: { type: "number" },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          relevance: { type: "string" },
          evidence: { type: "string" },
          source_ids: { type: "array", items: { type: "string" } },
        },
      },
    },
    sources: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "publisher", "url", "published_or_updated_date", "fact_used"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          publisher: { type: "string" },
          url: { type: "string" },
          published_or_updated_date: { anyOf: [{ type: "string" }, { type: "null" }] },
          fact_used: { type: "string" },
        },
      },
    },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

type UnknownRecord = Record<string, unknown>;

export type ForecastResearchOutput = {
  status: "complete" | "needs_review";
  assessments: Array<{
    location_id: string;
    product_id: string;
    variable_id: string;
    direction: "increase" | "decrease" | "neutral";
    adjustment_percent: number;
    confidence: "high" | "medium" | "low";
    relevance: string;
    evidence: string;
    source_ids: string[];
  }>;
  sources: Array<{
    id: string;
    title: string;
    publisher: string;
    url: string;
    published_or_updated_date: string | null;
    fact_used: string;
  }>;
  warnings: string[];
};

export class ForecastResearchValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super("The forecasting provider returned invalid or out-of-scope research.");
    this.name = "ForecastResearchValidationError";
    this.issues = issues;
  }
}

function object(value: unknown, path: string, issues: string[]): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${path} must be an object.`);
    return {};
  }
  return value as UnknownRecord;
}

function string(record: UnknownRecord, key: string, path: string, issues: string[]): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
    issues.push(`${path}.${key} must be a bounded non-empty string.`);
    return "";
  }
  return value;
}

function strings(record: UnknownRecord, key: string, path: string, issues: string[]): string[] {
  const value = record[key];
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
    issues.push(`${path}.${key} must be an array of bounded non-empty strings.`);
    return [];
  }
  return value as string[];
}

function number(record: UnknownRecord, key: string, path: string, issues: string[]): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${path}.${key} must be a finite number.`);
    return Number.NaN;
  }
  return value;
}

function dateOnly(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function directHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return false;
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    return !(
      ((host.endsWith("google.com") || host === "bing.com") && url.pathname.startsWith("/search")) ||
      host === "search.yahoo.com" || host === "duckduckgo.com"
    );
  } catch {
    return false;
  }
}

function exactSet(actual: string[], expected: string[]): boolean {
  return actual.length === new Set(actual).size && actual.length === expected.length && expected.every((value) => actual.includes(value));
}

export function validateForecastResearchOutput(raw: unknown, context: {
  locationIds: string[];
  products: ForecastProduct[];
  activeVariables: ActiveForecastVariable[];
  maxAbsFactorAdjustmentPercent?: number;
  maxAbsCombinedAdjustmentPercent?: number;
}): ForecastResearchOutput {
  const issues: string[] = [];
  const root = object(raw, "research", issues);
  const status = string(root, "status", "research", issues);
  if (!(["complete", "needs_review"] as string[]).includes(status)) issues.push("research.status is unsupported.");
  const warnings = strings(root, "warnings", "research", issues);
  const productIds = new Set(context.products.map((product) => product.id));
  const variableIds = new Set(context.activeVariables.map((variable) => variable.id));
  const maxFactor = context.maxAbsFactorAdjustmentPercent ?? 25;
  const maxCombined = context.maxAbsCombinedAdjustmentPercent ?? 50;

  const sourceRows = root.sources;
  if (!Array.isArray(sourceRows) || sourceRows.length > 100) issues.push("research.sources must be a bounded array.");
  const sources: ForecastResearchOutput["sources"] = [];
  const sourceIds = new Set<string>();
  for (const [index, value] of (Array.isArray(sourceRows) ? sourceRows : []).entries()) {
    const path = `research.sources[${index}]`;
    const source = object(value, path, issues);
    const id = string(source, "id", path, issues);
    const title = string(source, "title", path, issues);
    const publisher = string(source, "publisher", path, issues);
    const url = string(source, "url", path, issues);
    const fact = string(source, "fact_used", path, issues);
    const published = source.published_or_updated_date;
    if (sourceIds.has(id)) issues.push(`${path}.id is duplicated.`);
    if (id) sourceIds.add(id);
    if (!directHttpsUrl(url)) issues.push(`${path}.url must be a direct HTTPS source URL.`);
    if (published !== null && (typeof published !== "string" || !dateOnly(published))) {
      issues.push(`${path}.published_or_updated_date must be a date-only value or null.`);
    }
    sources.push({ id, title, publisher, url, published_or_updated_date: published as string | null, fact_used: fact });
  }

  const assessmentRows = root.assessments;
  const expectedCount = context.locationIds.length * context.products.length * context.activeVariables.length;
  if (!Array.isArray(assessmentRows) || assessmentRows.length !== expectedCount) {
    issues.push("research.assessments must contain every authorized location/product/variable combination exactly once.");
  }
  const assessments: ForecastResearchOutput["assessments"] = [];
  const seen = new Set<string>();
  const referencedSources = new Set<string>();
  const combined = new Map<string, number>();
  for (const [index, value] of (Array.isArray(assessmentRows) ? assessmentRows : []).entries()) {
    const path = `research.assessments[${index}]`;
    const assessment = object(value, path, issues);
    const locationId = string(assessment, "location_id", path, issues);
    const productId = string(assessment, "product_id", path, issues);
    const variableId = string(assessment, "variable_id", path, issues);
    const direction = string(assessment, "direction", path, issues);
    const percent = number(assessment, "adjustment_percent", path, issues);
    const confidence = string(assessment, "confidence", path, issues);
    const relevance = string(assessment, "relevance", path, issues);
    const evidence = string(assessment, "evidence", path, issues);
    const assessmentSourceIds = strings(assessment, "source_ids", path, issues);
    const key = `${locationId}\u0000${productId}\u0000${variableId}`;
    if (seen.has(key)) issues.push(`${path} is duplicated.`);
    seen.add(key);
    if (!context.locationIds.includes(locationId)) issues.push(`${path}.location_id is outside the authorized scope.`);
    if (!productIds.has(productId)) issues.push(`${path}.product_id is outside the requested products.`);
    if (!variableIds.has(variableId)) issues.push(`${path}.variable_id is not active.`);
    if (!(["increase", "decrease", "neutral"] as string[]).includes(direction)) issues.push(`${path}.direction is unsupported.`);
    if (!(["high", "medium", "low"] as string[]).includes(confidence)) issues.push(`${path}.confidence is unsupported.`);
    if (!Number.isFinite(percent) || Math.abs(percent) > maxFactor) issues.push(`${path}.adjustment_percent exceeds the deterministic factor cap.`);
    if ((percent > 0 && direction !== "increase") || (percent < 0 && direction !== "decrease") || (percent === 0 && direction !== "neutral")) {
      issues.push(`${path}.direction does not match its signed adjustment.`);
    }
    if (assessmentSourceIds.length === 0) issues.push(`${path} requires a direct source showing that the active variable was researched, including for a neutral result.`);
    if (assessmentSourceIds.length !== new Set(assessmentSourceIds).size) issues.push(`${path}.source_ids contains duplicates.`);
    for (const sourceId of assessmentSourceIds) {
      referencedSources.add(sourceId);
      if (!sourceIds.has(sourceId)) issues.push(`${path} references an unknown source ID.`);
    }
    const pair = `${locationId}\u0000${productId}`;
    combined.set(pair, (combined.get(pair) ?? 0) + (Number.isFinite(percent) ? percent : 0));
    assessments.push({
      location_id: locationId,
      product_id: productId,
      variable_id: variableId,
      direction: direction as ForecastResearchOutput["assessments"][number]["direction"],
      adjustment_percent: percent,
      confidence: confidence as ForecastResearchOutput["assessments"][number]["confidence"],
      relevance,
      evidence,
      source_ids: assessmentSourceIds,
    });
  }
  const expectedKeys = context.locationIds.flatMap((locationId) => context.products.flatMap((product) => (
    context.activeVariables.map((variable) => `${locationId}\u0000${product.id}\u0000${variable.id}`)
  )));
  if (!exactSet([...seen], expectedKeys)) issues.push("research.assessments do not exactly match the authorized combinations.");
  for (const total of combined.values()) if (Math.abs(total) > maxCombined) issues.push("A product's combined adjustment exceeds the deterministic cap.");
  for (const sourceId of sourceIds) if (!referencedSources.has(sourceId)) issues.push(`Source “${sourceId}” is not referenced by an assessment.`);
  if (issues.length) throw new ForecastResearchValidationError(issues);
  return { status: status as ForecastResearchOutput["status"], assessments, sources, warnings };
}

function weakestConfidence(values: Array<"high" | "medium" | "low">): "high" | "medium" | "low" {
  if (values.includes("low")) return "low";
  if (values.includes("medium")) return "medium";
  return "high";
}

export function assembleForecastOutputFromResearch(input: {
  rawResearch: unknown;
  context: ForecastValidationContext;
  baselines: HistoricalBaseline[];
  activeVariables: ActiveForecastVariable[];
  dataQualityIssues: string[];
}): ForecastOutput {
  const research = validateForecastResearchOutput(input.rawResearch, {
    locationIds: input.context.locationIds,
    products: input.context.products,
    activeVariables: input.activeVariables,
  });
  const variableNames = new Map(input.activeVariables.map((variable) => [variable.id, variable.name]));
  const productNames = new Map(input.context.products.map((product) => [product.id, product.name]));
  const recommendations = input.baselines.map((baseline) => {
    const assessments = research.assessments.filter((assessment) => (
      assessment.location_id === baseline.locationId && assessment.product_id === baseline.productId
    ));
    const adjustmentTotal = assessments.reduce((sum, assessment) => sum + assessment.adjustment_percent, 0);
    const recommended = Math.max(0, Math.round(baseline.quantity * (1 + adjustmentTotal / 100)));
    const confidence = weakestConfidence([baseline.confidence, ...assessments.map((assessment) => assessment.confidence)]);
    return {
      location_id: baseline.locationId,
      product_id: baseline.productId,
      product: productNames.get(baseline.productId) ?? baseline.product,
      baseline_quantity: baseline.quantity,
      adjustments: assessments.map((assessment) => ({
        variable_id: assessment.variable_id,
        variable: variableNames.get(assessment.variable_id) ?? assessment.variable_id,
        direction: assessment.direction,
        adjustment_percent: assessment.adjustment_percent,
        confidence: assessment.confidence,
        relevance: assessment.relevance,
        evidence: assessment.evidence,
        source_ids: assessment.source_ids,
      })),
      recommended_quantity: recommended,
      confidence,
      explanation: `The server applied ${adjustmentTotal >= 0 ? "+" : ""}${Math.round(adjustmentTotal * 100) / 100}% in validated research adjustments to the ${baseline.quantity}-unit historical baseline and rounded to ${recommended} units.`,
    };
  });
  const baselineMethods = [...new Set(input.baselines.map((baseline) => baseline.method))];
  const finalCandidate: ForecastOutput = {
    status: research.status,
    scope: {
      workspace_id: input.context.workspaceId,
      brand_id: input.context.brandId,
      location_ids: input.context.locationIds,
      timezone: input.context.timeZone,
    },
    forecast_period: {
      grouping: input.context.period.grouping,
      start_date: input.context.period.startDate,
      end_date: input.context.period.endDate,
    },
    policy: {
      id: input.context.policy.id,
      version: input.context.policy.version,
      sha256: input.context.policy.sha256,
      output_schema_version: input.context.policy.outputSchemaVersion,
    },
    method: {
      baseline_method: baselineMethods.join(" "),
      adjustment_method: "Server-applied additive percentage adjustments from validated AI research assessments.",
      rounding_rule: "Round to the nearest whole unit and never below zero.",
      research_completed: true,
    },
    recommendations,
    sources: research.sources.map((source) => ({ ...source, accessed_at: input.context.serverTimestamp })),
    data_quality: {
      historical_start_date: input.context.history.startDate,
      historical_end_date: input.context.history.endDate,
      rows_used: input.context.history.rowsUsed,
      issues: input.dataQualityIssues,
    },
    warnings: research.warnings,
    audit: {
      run_id: input.context.runId,
      generated_at: input.context.serverTimestamp,
      ai_provider: input.context.provider.name,
      ai_model: input.context.provider.model,
    },
  };
  return validateForecastOutput(finalCandidate, { ...input.context, maxAbsAdjustmentPercent: 50 });
}
