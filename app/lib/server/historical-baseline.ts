import type { HistoricalBaseline, HistoricalForecastRow } from "./forecast-provider";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value: string) {
  if (!DATE_ONLY.test(value)) throw new Error("Dates must use YYYY-MM-DD.");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (date.toISOString().slice(0, 10) !== value) throw new Error("Dates must be real calendar dates.");
  return date;
}

function dateRange(startDate: string, endDate: string) {
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  if (start > end) throw new Error("Forecast start must not be after its end.");
  const dates: Date[] = [];
  for (let value = start.getTime(); value <= end.getTime(); value += 86_400_000) {
    dates.push(new Date(value));
    if (dates.length > 366) throw new Error("Forecast periods cannot exceed 366 days.");
  }
  return dates;
}

function average(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function calculateHistoricalBaselines(input: {
  historicalRows: HistoricalForecastRow[];
  locations: string[];
  products: Array<{ id: string; name: string }>;
  startDate: string;
  endDate: string;
}): HistoricalBaseline[] {
  const targetDates = dateRange(input.startDate, input.endDate);
  const targetStart = parseDate(input.startDate).getTime();
  const locationSet = new Set(input.locations);
  const productNames = new Map(input.products.map((product) => [product.id, product.name]));
  if (locationSet.size !== input.locations.length || productNames.size !== input.products.length) {
    throw new Error("Location and product IDs must be unique.");
  }

  const rows = input.historicalRows.map((row) => {
    const date = parseDate(row.date);
    if (!locationSet.has(row.locationId) || productNames.get(row.productId) !== row.product) {
      throw new Error("Historical rows must stay inside the authorized scope.");
    }
    if (!Number.isSafeInteger(row.quantity) || row.quantity < 0) throw new Error("Historical quantities must be whole numbers of zero or more.");
    if (date.getTime() >= targetStart) throw new Error("Historical rows must occur before the forecast period.");
    return { ...row, dateValue: date };
  });

  return input.locations.flatMap((locationId) => input.products.map((product) => {
    const pairRows = rows.filter((row) => row.locationId === locationId && row.productId === product.id);
    let quantity = 0;
    let samples = 0;
    for (const targetDate of targetDates) {
      const sameWeekday = pairRows
        .filter((row) => row.dateValue.getUTCDay() === targetDate.getUTCDay())
        .sort((left, right) => right.dateValue.getTime() - left.dateValue.getTime())
        .slice(0, 12);
      const comparisonRows = sameWeekday.length >= 3
        ? sameWeekday
        : pairRows.sort((left, right) => right.dateValue.getTime() - left.dateValue.getTime()).slice(0, 28);
      quantity += average(comparisonRows.map((row) => row.quantity));
      samples += comparisonRows.length;
    }

    const effectiveSamples = targetDates.length ? Math.floor(samples / targetDates.length) : 0;
    return {
      locationId,
      productId: product.id,
      product: product.name,
      quantity: Math.max(0, Math.round(quantity)),
      method: "Recent same-weekday averages per forecast date, with a recent-sales fallback when fewer than three comparable weekdays exist.",
      sampleSize: effectiveSamples,
      confidence: effectiveSamples >= 8 ? "high" : effectiveSamples >= 3 ? "medium" : "low",
    } satisfies HistoricalBaseline;
  }));
}
