import { createHash } from "node:crypto";
import type {
  ForecastGrouping,
  ForecastProduct,
  HistoricalBaseline,
  HistoricalForecastRow,
} from "./forecast-provider";

const DAY_MS = 86_400_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export type ForecastEvidenceProduct = {
  locationId: string;
  productId: string;
  product: string;
  baseline: {
    quantity: number;
    method: string;
    sampleSize: number;
    confidence: "high" | "medium" | "low";
  };
  recentDailyAverage: { days7: number | null; days28: number | null; days90: number | null };
  trendPercent: number | null;
  previousComparableQuantity: number | null;
  priorYearComparableQuantity: number | null;
  volatilityPercent: number | null;
  observedDays: number;
  missingDays: number;
  outlierCount: number;
  weekdayProfile: Array<{ weekday: number; average: number; samples: number }>;
  monthProfile: Array<{ month: number; average: number; samples: number }>;
  monthlyTotals: Array<{ month: string; quantity: number; samples: number }>;
  representativeDailySeries: Array<[date: string, quantity: number]>;
};

export type ForecastHistoricalEvidence = {
  calculationVersion: "2.0.0";
  sha256: string;
  forecastPeriod: {
    grouping: ForecastGrouping;
    startDate: string;
    endDate: string;
  };
  history: {
    startDate: string;
    endDate: string;
    rowsUsed: number;
    issues: string[];
  };
  products: ForecastEvidenceProduct[];
};

function date(value: string): Date {
  if (!DATE_ONLY.test(value)) throw new Error("Forecast evidence dates must use YYYY-MM-DD.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (parsed.toISOString().slice(0, 10) !== value) throw new Error("Forecast evidence contains an invalid calendar date.");
  return parsed;
}

function iso(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function addDays(value: string, amount: number): string {
  return iso(new Date(date(value).getTime() + amount * DAY_MS));
}

function shiftYears(value: string, amount: number): string {
  const source = date(value);
  const targetYear = source.getUTCFullYear() + amount;
  const month = source.getUTCMonth();
  const day = Math.min(source.getUTCDate(), new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate());
  return iso(new Date(Date.UTC(targetYear, month, day)));
}

function daysInclusive(startDate: string, endDate: string): number {
  const value = Math.floor((date(endDate).getTime() - date(startDate).getTime()) / DAY_MS) + 1;
  if (value < 1) throw new Error("Forecast evidence date ranges must not end before they start.");
  return value;
}

function forecastDaysInclusive(startDate: string, endDate: string): number {
  const value = daysInclusive(startDate, endDate);
  if (value > 366) throw new Error("Forecast periods must contain no more than 366 days.");
  return value;
}

function rounded(value: number, digits = 2): number {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function average(values: number[]): number | null {
  return values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function windowRows(rows: HistoricalForecastRow[], startDate: string, endDate: string): HistoricalForecastRow[] {
  return rows.filter((row) => row.date >= startDate && row.date <= endDate);
}

function exactPeriodQuantity(rows: HistoricalForecastRow[], startDate: string, endDate: string): number | null {
  const selected = windowRows(rows, startDate, endDate);
  return selected.length ? sum(selected.map((row) => row.quantity)) : null;
}

function percentile(sorted: number[], fraction: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function outlierCount(values: number[]): number {
  if (values.length < 8) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const q1 = percentile(sorted, 0.25);
  const q3 = percentile(sorted, 0.75);
  const spread = q3 - q1;
  const low = q1 - spread * 1.5;
  const high = q3 + spread * 1.5;
  return values.filter((value) => value < low || value > high).length;
}

function volatility(values: number[]): number | null {
  const mean = average(values);
  if (mean === null || mean === 0 || values.length < 2) return null;
  const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  return rounded((Math.sqrt(variance) / mean) * 100);
}

function groupedProfile(
  rows: HistoricalForecastRow[],
  key: (row: HistoricalForecastRow) => number,
  values: number[],
  label: "weekday" | "month",
): Array<{ weekday: number; average: number; samples: number }> | Array<{ month: number; average: number; samples: number }> {
  return values.map((value) => {
    const quantities = rows.filter((row) => key(row) === value).map((row) => row.quantity);
    return { [label]: value, average: average(quantities) ?? 0, samples: quantities.length };
  }) as Array<{ weekday: number; average: number; samples: number }> | Array<{ month: number; average: number; samples: number }>;
}

function monthlyTotals(rows: HistoricalForecastRow[]): Array<{ month: string; quantity: number; samples: number }> {
  const groups = new Map<string, HistoricalForecastRow[]>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    groups.set(month, [...(groups.get(month) ?? []), row]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(-24)
    .map(([month, values]) => ({ month, quantity: sum(values.map((row) => row.quantity)), samples: values.length }));
}

function representativeSeries(input: {
  rows: HistoricalForecastRow[];
  forecastStartDate: string;
  forecastEndDate: string;
  historyEndDate: string;
}): Array<[string, number]> {
  const periodDays = forecastDaysInclusive(input.forecastStartDate, input.forecastEndDate);
  if (periodDays > 92) return [];
  const recentDays = periodDays <= 7 ? 42 : periodDays <= 31 ? 60 : 90;
  const comparablePaddingDays = periodDays <= 7 ? 3 : 7;
  const windows = [{ start: addDays(input.historyEndDate, -(recentDays - 1)), end: input.historyEndDate }];
  for (const years of [-1, -2]) {
    windows.push({
      start: addDays(shiftYears(input.forecastStartDate, years), -comparablePaddingDays),
      end: addDays(shiftYears(input.forecastEndDate, years), comparablePaddingDays),
    });
  }
  const selected = input.rows.filter((row) => windows.some((window) => row.date >= window.start && row.date <= window.end));
  return selected
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-90)
    .map((row) => [row.date, row.quantity]);
}

function pairKey(locationId: string, productId: string): string {
  return `${locationId}\u0000${productId}`;
}

export function buildForecastEvidence(input: {
  historicalRows: HistoricalForecastRow[];
  baselines: HistoricalBaseline[];
  locations: string[];
  products: ForecastProduct[];
  grouping: ForecastGrouping;
  forecastStartDate: string;
  forecastEndDate: string;
  historyStartDate: string;
  historyEndDate: string;
}): ForecastHistoricalEvidence {
  date(input.historyStartDate);
  date(input.historyEndDate);
  date(input.forecastStartDate);
  date(input.forecastEndDate);
  if (input.historyStartDate > input.historyEndDate || input.historyEndDate >= input.forecastStartDate) {
    throw new Error("Forecast evidence history must end before the forecast period.");
  }
  forecastDaysInclusive(input.forecastStartDate, input.forecastEndDate);
  const locationIds = new Set(input.locations);
  const productNames = new Map(input.products.map((product) => [product.id, product.name]));
  if (locationIds.size !== input.locations.length || productNames.size !== input.products.length) {
    throw new Error("Forecast evidence locations and products must be unique.");
  }
  if (input.historicalRows.some((row) => (
    !locationIds.has(row.locationId) || productNames.get(row.productId) !== row.product ||
    row.date < input.historyStartDate || row.date > input.historyEndDate ||
    !Number.isSafeInteger(row.quantity) || row.quantity < 0
  ))) throw new Error("Forecast evidence contains invalid or out-of-scope historical rows.");

  const baselines = new Map<string, HistoricalBaseline>();
  for (const baseline of input.baselines) {
    const key = pairKey(baseline.locationId, baseline.productId);
    if (
      baselines.has(key) || !locationIds.has(baseline.locationId) ||
      productNames.get(baseline.productId) !== baseline.product ||
      !Number.isSafeInteger(baseline.quantity) || baseline.quantity < 0
    ) throw new Error("Forecast evidence contains an invalid baseline.");
    baselines.set(key, baseline);
  }
  const expectedPairs = input.locations.flatMap((locationId) => input.products.map((product) => pairKey(locationId, product.id)));
  if (baselines.size !== expectedPairs.length || expectedPairs.some((key) => !baselines.has(key))) {
    throw new Error("Forecast evidence requires one baseline for every location and product.");
  }

  const historyDays = daysInclusive(input.historyStartDate, input.historyEndDate);
  const evidenceProducts = input.locations.flatMap((locationId) => input.products.map((product) => {
    const rows = input.historicalRows
      .filter((row) => row.locationId === locationId && row.productId === product.id)
      .sort((left, right) => left.date.localeCompare(right.date));
    const baseline = baselines.get(pairKey(locationId, product.id))!;
    const observedDates = new Set(rows.map((row) => row.date));
    const recent = (days: number) => windowRows(rows, addDays(input.historyEndDate, -(days - 1)), input.historyEndDate).map((row) => row.quantity);
    const recent28 = recent(28);
    const preceding28 = windowRows(rows, addDays(input.historyEndDate, -55), addDays(input.historyEndDate, -28)).map((row) => row.quantity);
    const recentAverage = average(recent28);
    const precedingAverage = average(preceding28);
    const periodDays = forecastDaysInclusive(input.forecastStartDate, input.forecastEndDate);
    const previousEnd = addDays(input.forecastStartDate, -1);
    const previousStart = addDays(previousEnd, -(periodDays - 1));
    return {
      locationId,
      productId: product.id,
      product: product.name,
      baseline: {
        quantity: baseline.quantity,
        method: baseline.method,
        sampleSize: baseline.sampleSize,
        confidence: baseline.confidence,
      },
      recentDailyAverage: { days7: average(recent(7)), days28: recentAverage, days90: average(recent(90)) },
      trendPercent: recentAverage !== null && precedingAverage !== null && precedingAverage !== 0
        ? rounded(((recentAverage - precedingAverage) / precedingAverage) * 100)
        : null,
      previousComparableQuantity: exactPeriodQuantity(rows, previousStart, previousEnd),
      priorYearComparableQuantity: exactPeriodQuantity(
        rows,
        shiftYears(input.forecastStartDate, -1),
        shiftYears(input.forecastEndDate, -1),
      ),
      volatilityPercent: volatility(recent(90)),
      observedDays: observedDates.size,
      missingDays: Math.max(0, historyDays - observedDates.size),
      outlierCount: outlierCount(rows.map((row) => row.quantity)),
      weekdayProfile: groupedProfile(rows, (row) => date(row.date).getUTCDay(), [0, 1, 2, 3, 4, 5, 6], "weekday") as ForecastEvidenceProduct["weekdayProfile"],
      monthProfile: groupedProfile(rows, (row) => date(row.date).getUTCMonth() + 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "month") as ForecastEvidenceProduct["monthProfile"],
      monthlyTotals: monthlyTotals(rows),
      representativeDailySeries: representativeSeries({
        rows,
        forecastStartDate: input.forecastStartDate,
        forecastEndDate: input.forecastEndDate,
        historyEndDate: input.historyEndDate,
      }),
    } satisfies ForecastEvidenceProduct;
  }));

  const issues = evidenceProducts.flatMap((product) => {
    const prefix = `${product.locationId}/${product.productId}`;
    return [
      ...(product.observedDays < Math.min(28, historyDays) ? [`${prefix}: fewer than 28 observed sales dates.`] : []),
      ...(product.missingDays > historyDays * 0.25 ? [`${prefix}: more than 25% of dates have no uploaded observation; missing dates were not treated as zero.`] : []),
      ...(product.outlierCount ? [`${prefix}: ${product.outlierCount} statistically unusual quantities were retained and disclosed.`] : []),
    ];
  });
  const unsigned = {
    calculationVersion: "2.0.0" as const,
    forecastPeriod: { grouping: input.grouping, startDate: input.forecastStartDate, endDate: input.forecastEndDate },
    history: { startDate: input.historyStartDate, endDate: input.historyEndDate, rowsUsed: input.historicalRows.length, issues },
    products: evidenceProducts,
  };
  const sha256 = createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex");
  return { ...unsigned, sha256 };
}

export function verifyForecastEvidenceChecksum(evidence: ForecastHistoricalEvidence): boolean {
  const { sha256, ...unsigned } = evidence;
  return /^[a-f0-9]{64}$/i.test(sha256) &&
    createHash("sha256").update(JSON.stringify(unsigned), "utf8").digest("hex") === sha256.toLowerCase();
}
