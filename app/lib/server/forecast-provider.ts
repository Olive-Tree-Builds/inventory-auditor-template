import type { ForecastHistoricalEvidence } from "./forecast-evidence";

export type ForecastGrouping = "day" | "week" | "month" | "quarter" | "year";

export type ActiveForecastVariable = { id: string; name: string };
export type ForecastProduct = { id: string; name: string };

export type ForecastLocationContext = {
  id: string;
  name: string;
  brandId: string;
  brandName: string;
  timeZone: string;
  streetAddress: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  countryCode: string;
  /** A deterministic, address-bounded search label; never a free-form scope expansion. */
  researchArea: string;
};

export function buildForecastResearchArea(input: Pick<
  ForecastLocationContext,
  "streetAddress" | "city" | "region" | "postalCode" | "countryCode"
>): string {
  return [input.streetAddress, input.city, input.region, input.postalCode, input.countryCode]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim())
    .join(", ");
}

export type HistoricalForecastRow = {
  date: string;
  locationId: string;
  productId: string;
  product: string;
  quantity: number;
};

export type HistoricalBaseline = {
  locationId: string;
  productId: string;
  product: string;
  quantity: number;
  method: string;
  sampleSize: number;
  confidence: "high" | "medium" | "low";
};

/** This object must be assembled only after server-side authorization succeeds. */
export type ForecastProviderRequest = {
  requestId: string;
  analysisPolicy: string;
  policySha256: string;
  scope: {
    workspaceId: string;
    brandId: string;
    brandName: string;
    locationIds: string[];
    timeZone: string;
    locations: ForecastLocationContext[];
  };
  period: {
    grouping: ForecastGrouping;
    startDate: string;
    endDate: string;
  };
  products: ForecastProduct[];
  activeVariables: ActiveForecastVariable[];
  /** Compact, checksummed evidence calculated from authorized history by the host. */
  historicalEvidence: ForecastHistoricalEvidence;
  baselines: HistoricalBaseline[];
  signal?: AbortSignal;
};

export interface ForecastProvider {
  readonly providerName: string;
  readonly model: string;
  readonly supportsLiveWebResearch: true;
  generate(request: ForecastProviderRequest): Promise<unknown>;
}
