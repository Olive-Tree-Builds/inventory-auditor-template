"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownRight,
  ArrowUpRight,
  CalendarDays,
  ChevronDown,
  Download,
  ExternalLink,
  Info,
  Mail,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  X,
} from "lucide-react";
import type { AppBootstrapData } from "../lib/app-data";
import {
  anchorFromDashboardPeriodInput,
  dashboardPeriodBounds,
  dashboardPeriodInputValue,
  dashboardPeriodOptions,
  type DashboardPeriod,
} from "../lib/period-selection";

type Period = DashboardPeriod;

type HistorySeriesPoint = { date: string; quantity: number };
type HistoryChartSeries = {
  id: string;
  name: string;
  color: string;
  points: HistorySeriesPoint[];
};
type HistoryRow = {
  locationId: string;
  productId: string;
  productName: string;
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  currentQuantity: number;
  previousQuantity: number;
  series: HistorySeriesPoint[];
};
type HistoryData = {
  rows: HistoryRow[];
  current: number;
  previous: number;
  changePercent: number | null;
  currentStart: string;
  currentEnd: string;
};

type ForecastAdjustment = {
  variableId: string;
  variableName: string;
  percent: number;
  relevance: string;
  evidence: string;
  sourceIds: string[];
};
type ForecastRecommendation = {
  runId: string;
  locationId: string;
  productId: string;
  productName: string;
  baselineQuantity: number;
  recommendedQuantity: number;
  confidence: "high" | "medium" | "low";
  explanation: string;
  adjustments: ForecastAdjustment[];
};
type ForecastRun = {
  id: string;
  locationId: string;
  period: Period | null;
  periodStart: string;
  periodEnd: string;
  status: string;
  researchCompleted: boolean;
  policyVersion: string;
  generatedAt: string;
  provider: string;
  model: string;
  warnings: string[];
};
type ForecastSource = {
  runId: string;
  id: string;
  title: string;
  publisher: string;
  url: string;
  factUsed: string;
};
type ForecastData = {
  runs: ForecastRun[];
  recommendations: ForecastRecommendation[];
  sources: ForecastSource[];
};
type ForecastAvailability = "ready" | "not-installed" | "setup-required";
type ManualSendResult = { recipientsChecked: number; sent: number; skipped: number; failed: number; failureCodes: Record<string, number> };

type DashboardScreenProps = {
  notify: (message: string) => void;
  appData: AppBootstrapData;
  onDataChanged: () => Promise<void>;
  brandId: string;
  locationId: string;
  historyProductId: string;
  onHistoryProductChange: (productId: string) => void;
};

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolean(value: unknown): boolean {
  return value === true || value === "true";
}

function first(source: JsonRecord, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

function strings(value: unknown): string[] {
  return array(value).map(text).filter(Boolean);
}

function dateOnlyToday(timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        timeZone,
      }).formatToParts(new Date());
      const values = new Map(parts.map((part) => [part.type, part.value]));
      if (values.get("year") && values.get("month") && values.get("day")) {
        return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
      }
    } catch {
      // Fall back to a UTC date if the configured timezone is invalid.
    }
  }
  return new Date().toISOString().slice(0, 10);
}

function titleCase(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(value);
}

function formatDate(value: string, options?: Intl.DateTimeFormatOptions): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return value || "Date unavailable";
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat(undefined, options ?? { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed);
}

function formatDateTime(value: string): string {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

function formatHeaderDate(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      timeZone,
    }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(new Date());
  }
}

function formatRange(start: string, end: string): string {
  if (!start && !end) return "Selected period";
  if (!end || start === end) return formatDate(start);
  return `${formatDate(start, { month: "short", day: "numeric", timeZone: "UTC" })} – ${formatDate(end)}`;
}

function daysInclusive(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime < startTime) return 1;
  return Math.floor((endTime - startTime) / 86_400_000) + 1;
}

function apiError(payload: unknown, fallback: string): string {
  const root = record(payload);
  const error = record(root.error);
  return text(error.message) || text(root.message) || fallback;
}

function unwrapApiData(payload: unknown): unknown {
  const root = record(payload);
  return root.data ?? payload;
}

function parseHistoryPayload(payload: unknown): HistoryData {
  const data = record(unwrapApiData(payload));
  const rows = array(data.rows).map((entry): HistoryRow => {
    const row = record(entry);
    return {
      locationId: text(first(row, "locationId", "location_id")),
      productId: text(first(row, "productId", "product_id")),
      productName: text(first(row, "productName", "product_name")) || "Unnamed product",
      currentStart: text(first(row, "currentStart", "current_start")),
      currentEnd: text(first(row, "currentEnd", "current_end")),
      previousStart: text(first(row, "previousStart", "previous_start")),
      previousEnd: text(first(row, "previousEnd", "previous_end")),
      currentQuantity: Math.max(0, number(first(row, "currentQuantity", "current_quantity"))),
      previousQuantity: Math.max(0, number(first(row, "previousQuantity", "previous_quantity"))),
      series: array(row.series).map((point): HistorySeriesPoint => {
        const item = record(point);
        return {
          date: text(first(item, "date", "bucketDate", "bucket_date")),
          quantity: Math.max(0, number(item.quantity)),
        };
      }).filter((point) => Boolean(point.date)),
    };
  });
  const totals = record(data.totals);
  const selection = record(data.selection);
  const current = rows.length ? rows.reduce((sum, row) => sum + row.currentQuantity, 0) : Math.max(0, number(totals.current));
  const previous = rows.length ? rows.reduce((sum, row) => sum + row.previousQuantity, 0) : Math.max(0, number(totals.previous));
  return {
    rows,
    current,
    previous,
    changePercent: previous > 0 ? ((current - previous) / previous) * 100 : null,
    currentStart: text(first(selection, "startDate", "start_date")) || rows[0]?.currentStart || "",
    currentEnd: text(first(selection, "endDate", "end_date")) || rows[0]?.currentEnd || "",
  };
}

function normalizePeriod(value: unknown): Period | null {
  const candidate = text(value).toLowerCase();
  return dashboardPeriodOptions.includes(candidate as Period) ? candidate as Period : null;
}

function normalizeAdjustments(value: unknown): ForecastAdjustment[] {
  return array(value).map((entry): ForecastAdjustment => {
    const adjustment = record(entry);
    return {
      variableId: text(first(adjustment, "variableId", "variable_id")),
      variableName: text(first(adjustment, "variableName", "variable_name", "variable")) || "Configured variable",
      percent: number(first(adjustment, "percent", "adjustmentPercent", "adjustment_percent")),
      relevance: text(adjustment.relevance),
      evidence: text(adjustment.evidence),
      sourceIds: strings(first(adjustment, "sourceIds", "source_ids", "sourceKeys", "source_keys")),
    };
  });
}

function normalizeRecommendation(value: unknown, runId = "", locationId = ""): ForecastRecommendation {
  const item = record(value);
  const confidence = text(item.confidence).toLowerCase();
  return {
    runId: text(first(item, "runId", "run_id", "forecastRunId", "forecast_run_id")) || runId,
    locationId: text(first(item, "locationId", "location_id")) || locationId,
    productId: text(first(item, "productId", "product_id")),
    productName: text(first(item, "productName", "product_name", "product")) || "Unnamed product",
    baselineQuantity: Math.max(0, number(first(item, "baselineQuantity", "baseline_quantity"))),
    recommendedQuantity: Math.max(0, number(first(item, "recommendedQuantity", "recommended_quantity"))),
    confidence: confidence === "high" || confidence === "low" ? confidence : "medium",
    explanation: text(first(item, "explanation", "reason")),
    adjustments: normalizeAdjustments(item.adjustments),
  };
}

function normalizeRun(value: unknown): ForecastRun {
  const run = record(value);
  const audit = record(run.audit);
  const policy = record(run.policy);
  const scope = record(run.scope);
  const forecastPeriod = record(first(run, "forecastPeriod", "forecast_period"));
  const method = record(run.method);
  return {
    id: text(first(run, "id", "runId", "run_id")) || text(first(audit, "runId", "run_id")),
    locationId: text(first(run, "locationId", "location_id")) || strings(first(scope, "locationIds", "location_ids"))[0] || "",
    period: normalizePeriod(first(run, "period", "periodGrouping", "period_grouping") ?? first(forecastPeriod, "grouping")),
    periodStart: text(first(run, "periodStart", "period_start")) || text(first(forecastPeriod, "startDate", "start_date")),
    periodEnd: text(first(run, "periodEnd", "period_end")) || text(first(forecastPeriod, "endDate", "end_date")),
    status: text(run.status) || "status unavailable",
    researchCompleted: boolean(first(run, "researchCompleted", "research_completed") ?? first(method, "researchCompleted", "research_completed")),
    policyVersion: text(first(run, "policyVersion", "policy_version")) || text(policy.version),
    generatedAt: text(first(run, "generatedAt", "generated_at", "completedAt", "completed_at")) || text(first(audit, "generatedAt", "generated_at")),
    provider: text(first(run, "provider", "aiProvider", "ai_provider")) || text(first(audit, "aiProvider", "ai_provider")),
    model: text(first(run, "model", "aiModel", "ai_model")) || text(first(audit, "aiModel", "ai_model")),
    warnings: strings(run.warnings),
  };
}

function normalizeSource(value: unknown, runId = ""): ForecastSource {
  const source = record(value);
  return {
    runId: text(first(source, "runId", "run_id", "forecastRunId", "forecast_run_id")) || runId,
    id: text(first(source, "key", "sourceKey", "source_key", "sourceId", "source_id", "id")),
    title: text(source.title) || "Forecast evidence",
    publisher: text(source.publisher),
    url: text(source.url),
    factUsed: text(first(source, "factUsed", "fact_used")),
  };
}

function parseForecastPayload(payload: unknown): ForecastData {
  const rawData = unwrapApiData(payload);
  const data = record(rawData);
  const rootRuns = Array.isArray(rawData) ? rawData : array(first(data, "runs", "forecasts", "results"));
  const runs = rootRuns.map(normalizeRun);
  const recommendations: ForecastRecommendation[] = rootRuns.length === 0 && data.status
    ? []
    : array(data.recommendations).map((item) => normalizeRecommendation(item));
  const sources: ForecastSource[] = rootRuns.length === 0 && data.status
    ? []
    : array(data.sources).map((source) => normalizeSource(source));

  rootRuns.forEach((entry, index) => {
    const run = record(entry);
    const normalizedRun = runs[index];
    const scopedLocation = normalizedRun.locationId;
    array(first(run, "recommendations", "items")).forEach((item) => {
      recommendations.push(normalizeRecommendation(item, normalizedRun.id, scopedLocation));
    });
    array(run.sources).forEach((source) => sources.push(normalizeSource(source, normalizedRun.id)));
  });

  if (rootRuns.length === 0 && (data.status || data.recommendations)) {
    const run = normalizeRun(data);
    runs.push(run);
    array(data.recommendations).forEach((item) => {
      const normalized = normalizeRecommendation(item, run.id, run.locationId);
      const duplicate = recommendations.some((candidate) => candidate.runId === normalized.runId && candidate.locationId === normalized.locationId && candidate.productId === normalized.productId);
      if (!duplicate) recommendations.push(normalized);
    });
    array(data.sources).forEach((source) => {
      const normalized = normalizeSource(source, run.id);
      const duplicate = sources.some((candidate) => candidate.runId === normalized.runId && candidate.id === normalized.id);
      if (!duplicate) sources.push(normalized);
    });
  }

  return { runs, recommendations, sources: sources.filter((source) => /^https:\/\//i.test(source.url)) };
}

function PeriodSelector({ value, onChange, label }: { value: Period; onChange: (period: Period) => void; label: string }) {
  return (
    <div className="period-selector" aria-label={label}>
      {dashboardPeriodOptions.map((period) => (
        <button
          key={period}
          type="button"
          className={value === period ? "is-active" : ""}
          aria-pressed={value === period}
          onClick={() => onChange(period)}
        >
          {titleCase(period)}
        </button>
      ))}
    </div>
  );
}

function PeriodValueSelector({
  period,
  anchor,
  onChange,
  label,
}: {
  period: Period;
  anchor: string;
  onChange: (anchor: string) => void;
  label: string;
}) {
  const inputValue = dashboardPeriodInputValue(period, anchor);
  const bounds = dashboardPeriodBounds(period, anchor);
  const update = (value: string) => {
    if (!value) return;
    try {
      onChange(anchorFromDashboardPeriodInput(period, value));
    } catch {
      // Native controls can emit an incomplete value while the user is editing.
    }
  };
  const inputId = `${label.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}-${period}`;
  const prompt = `Choose ${period === "day" ? "a day" : period === "week" ? "a week" : period === "month" ? "a month" : period === "quarter" ? "a quarter" : "a year"}`;

  return (
    <div className="period-value-selector">
      <span className="period-value-prompt">{prompt}</span>
      {period === "day" || period === "week" || period === "month" ? (
        <label htmlFor={inputId}>
          <span className="sr-only">{label} {period}</span>
          <input
            id={inputId}
            type={period === "day" ? "date" : period}
            value={inputValue}
            onChange={(event) => update(event.target.value)}
          />
        </label>
      ) : null}
      {period === "quarter" ? (
        <div className="quarter-value-fields">
          <label>
            <span className="sr-only">{label} quarter</span>
            <select
              value={inputValue.slice(-2)}
              onChange={(event) => update(`${inputValue.slice(0, 4)}-${event.target.value}`)}
            >
              <option value="Q1">Q1</option>
              <option value="Q2">Q2</option>
              <option value="Q3">Q3</option>
              <option value="Q4">Q4</option>
            </select>
          </label>
          <label>
            <span className="sr-only">{label} quarter year</span>
            <input
              key={inputValue.slice(0, 4)}
              type="number"
              min="1900"
              max="9999"
              defaultValue={inputValue.slice(0, 4)}
              onChange={(event) => {
                if (/^\d{4}$/.test(event.target.value)) update(`${event.target.value}-${inputValue.slice(-2)}`);
              }}
            />
          </label>
        </div>
      ) : null}
      {period === "year" ? (
        <label htmlFor={inputId}>
          <span className="sr-only">{label} year</span>
          <input
            key={inputValue}
            id={inputId}
            type="number"
            min="1900"
            max="9999"
            defaultValue={inputValue}
            onChange={(event) => {
              if (/^\d{4}$/.test(event.target.value)) update(event.target.value);
            }}
          />
        </label>
      ) : null}
      <span className="period-value-range">{formatRange(bounds.startDate, bounds.endDate)}</span>
    </div>
  );
}

function StatePanel({ title, message, tone = "neutral" }: { title: string; message: string; tone?: "neutral" | "error" }) {
  return (
    <div className={`dashboard-state-panel${tone === "error" ? " is-error" : ""}`} role={tone === "error" ? "alert" : "status"}>
      <strong>{title}</strong>
      <p>{message}</p>
    </div>
  );
}

function historySeriesColor(productId: string): string {
  let hash = 0;
  for (const character of productId) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 54% 38%)`;
}

function groupHistorySeriesByProduct(rows: HistoryRow[]): HistoryChartSeries[] {
  const products = new Map<string, { id: string; name: string; totals: Map<string, number> }>();
  rows.forEach((row) => {
    const product = products.get(row.productId) ?? {
      id: row.productId,
      name: row.productName,
      totals: new Map<string, number>(),
    };
    row.series.forEach((point) => {
      product.totals.set(point.date, (product.totals.get(point.date) ?? 0) + point.quantity);
    });
    products.set(row.productId, product);
  });

  return [...products.values()]
    .map((product) => ({
      id: product.id,
      name: product.name,
      color: historySeriesColor(product.id),
      points: [...product.totals.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, quantity]) => ({ date, quantity })),
    }))
    .filter((series) => series.points.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function HistoricalChart({
  series,
  label,
  title,
  description,
}: {
  series: HistoryChartSeries[];
  label: string;
  title: string;
  description: string;
}) {
  const dates = [...new Set(series.flatMap((productSeries) => productSeries.points.map((point) => point.date)))]
    .sort((left, right) => left.localeCompare(right));
  if (dates.length === 0) {
    return <StatePanel title="No sales in this period" message="Upload historical data or choose another period or location." />;
  }
  const width = 760;
  const height = 245;
  const left = 54;
  const right = 18;
  const top = 24;
  const bottom = 42;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const max = Math.max(...series.flatMap((productSeries) => productSeries.points.map((point) => point.quantity)), 1);
  const dateIndexes = new Map(dates.map((date, index) => [date, index]));
  const plottedSeries = series.map((productSeries) => {
    const coordinates = productSeries.points.map((point) => {
      const index = dateIndexes.get(point.date) ?? 0;
      return {
        ...point,
        x: left + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth),
        y: top + plotHeight - (point.quantity / max) * plotHeight,
      };
    });
    return {
      ...productSeries,
      coordinates,
      path: coordinates.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" "),
    };
  });
  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));

  return (
    <div className="chart-wrap live-history-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="history-chart-title history-chart-desc">
        <title id="history-chart-title">{title} over {label}</title>
        <desc id="history-chart-desc">{description}</desc>
        <g className="chart-grid" aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = top + plotHeight - ratio * plotHeight;
            return <line key={ratio} x1={left} y1={y} x2={width - right} y2={y} />;
          })}
        </g>
        <g className="chart-axis-labels" aria-hidden="true">
          <text x="12" y={top + 4}>{formatNumber(max)}</text>
          <text x="34" y={top + plotHeight + 4}>0</text>
          {dates.map((date, index) => index % labelEvery === 0 || index === dates.length - 1 ? (
            <text
              key={date}
              x={left + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth)}
              y={height - 12}
              textAnchor="middle"
            >
              {formatDate(date, { month: "short", day: "numeric", timeZone: "UTC" })}
            </text>
          ) : null)}
        </g>
        {plottedSeries.map((productSeries) => (
          <g key={productSeries.id}>
            {productSeries.coordinates.length > 1 ? (
              <path className="chart-line live-history-line" d={productSeries.path} style={{ stroke: productSeries.color }} />
            ) : null}
            {productSeries.coordinates.map((point) => (
              <circle
                key={point.date}
                className="chart-point live-history-point"
                cx={point.x}
                cy={point.y}
                r="4"
                style={{ fill: productSeries.color }}
              >
                <title>{productSeries.name} · {formatDate(point.date)}: {formatNumber(point.quantity)} units</title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="chart-legend" aria-label="Product lines">
        {series.map((productSeries) => (
          <span key={productSeries.id}>
            <i className="legend-dot" style={{ backgroundColor: productSeries.color }} aria-hidden="true" />
            {productSeries.name}
          </span>
        ))}
      </div>
      <ul className="sr-only" aria-label="Historical sales chart values">
        {series.map((productSeries) => (
          <li key={productSeries.id}>
            {productSeries.name}
            <ul>
              {productSeries.points.map((point) => (
                <li key={point.date}>{formatDate(point.date)}: {formatNumber(point.quantity)} units</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

function escapeCsv(value: string | number): string {
  let output = String(value);
  if (/^[=+\-@]/.test(output)) output = `'${output}`;
  return `"${output.replaceAll('"', '""')}"`;
}

function downloadCsv(filename: string, rows: Array<Array<string | number>>) {
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function filenameToken(value: string): string {
  return value.normalize("NFKD").toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "selection";
}

function manualFailureLabel(code: string): string {
  const labels: Record<string, string> = {
    recipient_collision: "The same email exists as more than one recipient. Remove the duplicate in Configuration.",
    recipient_scope_changed: "A recipient's location access changed. Refresh and review the scope.",
    forecast_changed: "A saved forecast changed. Refresh and review it before retrying.",
    recipient_not_eligible: "A recipient is no longer eligible for forecast email.",
    recipient_has_no_locations: "A recipient no longer has an active location.",
    resend_send_failed: "Resend did not accept the message. Test the Resend connection in Configuration.",
    delivery_failed: "The provider could not complete this delivery.",
    storage_failed: "The recipient or delivery record could not be safely verified.",
  };
  return labels[code] || "A recipient delivery failed its final safety check.";
}

export function DashboardScreen({ notify, appData, brandId, locationId, historyProductId, onHistoryProductChange }: DashboardScreenProps) {
  const [historyPeriod, setHistoryPeriod] = useState<Period>("week");
  const [forecastPeriod, setForecastPeriod] = useState<Period>("day");
  const [historyAnchor, setHistoryAnchor] = useState(() => dateOnlyToday(appData.workspace.defaultTimeZone));
  const [forecastAnchor, setForecastAnchor] = useState(() => dateOnlyToday(appData.workspace.defaultTimeZone));
  const [history, setHistory] = useState<HistoryData | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [forecast, setForecast] = useState<ForecastData | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastRunning, setForecastRunning] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [forecastAvailability, setForecastAvailability] = useState<ForecastAvailability>("ready");
  const [expandedProduct, setExpandedProduct] = useState<string | null>(null);
  const [manualSendOpen, setManualSendOpen] = useState(false);
  const [manualSending, setManualSending] = useState(false);
  const [manualSendResult, setManualSendResult] = useState<ManualSendResult | null>(null);
  const [manualSendError, setManualSendError] = useState<string | null>(null);
  const manualDialogRef = useRef<HTMLElement | null>(null);
  const manualDialogOpenerRef = useRef<HTMLElement | null>(null);
  const manualSendingRef = useRef(false);

  const activePolicy = appData.analysisSkill;
  const activeVariables = activePolicy?.variables ?? [];
  const policyUnavailable = !activePolicy;
  const canRunForecast = appData.currentUser.role === "super_admin" || appData.currentUser.role === "admin" || appData.currentUser.role === "manager";
  const assignedIdSet = useMemo(() => new Set(appData.assignedLocationIds), [appData.assignedLocationIds]);
  const assignedBrands = useMemo(() => appData.brands
    .filter((brand) => brand.active)
    .map((brand) => ({ ...brand, locations: brand.locations.filter((location) => location.active && assignedIdSet.has(location.id)) }))
    .filter((brand) => brand.locations.length > 0), [appData.brands, assignedIdSet]);
  const assignedLocations = useMemo(() => assignedBrands.flatMap((brand) => brand.locations), [assignedBrands]);
  const visibleLocations = useMemo(() => brandId === "all"
    ? assignedLocations
    : assignedBrands.find((brand) => brand.id === brandId)?.locations ?? [], [assignedBrands, assignedLocations, brandId]);
  const selectedLocations = useMemo(() => locationId === "all"
    ? visibleLocations
    : visibleLocations.filter((location) => location.id === locationId), [locationId, visibleLocations]);
  const selectedLocationIds = useMemo(() => selectedLocations.map((location) => location.id), [selectedLocations]);
  const locationById = useMemo(() => new Map(assignedLocations.map((location) => [location.id, location])), [assignedLocations]);
  const brandById = useMemo(() => new Map(assignedBrands.map((brand) => [brand.id, brand])), [assignedBrands]);
  const selectedBrandName = brandId === "all" ? "all assigned brands" : brandById.get(brandId)?.name ?? "selected brand";
  const selectedLocationName = locationId === "all" ? "all assigned locations" : locationById.get(locationId)?.name ?? "selected location";

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    if (selectedLocationIds.length === 0) {
      setHistory(null);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const parameters = new URLSearchParams({
        period: historyPeriod,
        anchor: historyAnchor,
        locations: selectedLocationIds.join(","),
      });
      const response = await fetch(`/api/history/dashboard?${parameters}`, { cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(payload, "Historical sales could not be loaded."));
      const parsed = parseHistoryPayload(payload);
      const allowed = new Set(selectedLocationIds);
      const rows = parsed.rows.filter((row) => allowed.has(row.locationId));
      const current = rows.reduce((sum, row) => sum + row.currentQuantity, 0);
      const previous = rows.reduce((sum, row) => sum + row.previousQuantity, 0);
      setHistory({
        rows,
        current,
        previous,
        changePercent: previous > 0 ? ((current - previous) / previous) * 100 : null,
        currentStart: parsed.currentStart,
        currentEnd: parsed.currentEnd,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHistory(null);
      setHistoryError(error instanceof Error ? error.message : "Historical sales could not be loaded.");
    } finally {
      if (!signal?.aborted) setHistoryLoading(false);
    }
  }, [historyAnchor, historyPeriod, selectedLocationIds]);

  const loadForecast = useCallback(async (signal?: AbortSignal) => {
    if (selectedLocationIds.length === 0) {
      setForecast(null);
      setForecastError(null);
      setForecastLoading(false);
      return;
    }
    setForecastLoading(true);
    setForecastError(null);
    try {
      const parameters = new URLSearchParams({
        period: forecastPeriod,
        anchor: forecastAnchor,
        locations: selectedLocationIds.join(","),
      });
      const response = await fetch(`/api/forecasts/latest?${parameters}`, { cache: "no-store", signal });
      const payload: unknown = await response.json().catch(() => ({}));
      if (response.status === 404) {
        setForecastAvailability("not-installed");
        setForecast(null);
        return;
      }
      if ([409, 424, 503].includes(response.status)) {
        setForecastAvailability("setup-required");
        setForecast(null);
        setForecastError(apiError(payload, "Finish the Analysis Skill and AI provider setup before running forecasts."));
        return;
      }
      if (!response.ok) throw new Error(apiError(payload, "The latest forecast could not be loaded."));
      setForecastAvailability("ready");
      setForecast(parseForecastPayload(payload));
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setForecast(null);
      setForecastError(error instanceof Error ? error.message : "The latest forecast could not be loaded.");
    } finally {
      if (!signal?.aborted) setForecastLoading(false);
    }
  }, [forecastAnchor, forecastPeriod, selectedLocationIds]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadHistory(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadHistory]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void loadForecast(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [loadForecast]);

  useEffect(() => {
    manualSendingRef.current = manualSending;
  }, [manualSending]);

  useEffect(() => {
    if (!manualSendOpen) return;
    const dialog = manualDialogRef.current;
    const opener = manualDialogOpenerRef.current;
    if (!dialog) return;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const selector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(selector)].filter((element) => element.offsetParent !== null);
    const frame = window.requestAnimationFrame(() => (dialog.querySelector<HTMLElement>("[data-dialog-initial]") || focusables()[0] || dialog).focus());
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (manualSendingRef.current) return;
        event.preventDefault();
        setManualSendOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusables();
      if (!candidates.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", keydown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      document.body.style.overflow = priorOverflow;
      opener?.focus();
    };
  }, [manualSendOpen]);

  const runForecast = async () => {
    if (selectedLocationIds.length === 0) {
      notify("Assign at least one location to your account before running a forecast.");
      return;
    }
    setForecastRunning(true);
    setForecastError(null);
    try {
      const response = await fetch("/api/forecasts/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ period: forecastPeriod, anchor: forecastAnchor, locationIds: selectedLocationIds }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (response.status === 404) {
        setForecastAvailability("not-installed");
        notify("Forecasting is not available in this deployment yet.");
        return;
      }
      if ([409, 424, 503].includes(response.status)) {
        setForecastAvailability("setup-required");
        const message = apiError(payload, "Finish the Analysis Skill and AI provider setup before running forecasts.");
        setForecastError(message);
        notify(message);
        return;
      }
      if (!response.ok) throw new Error(apiError(payload, "The forecast could not be completed."));
      setForecastAvailability("ready");
      const parsed = parseForecastPayload(payload);
      if (parsed.runs.length || parsed.recommendations.length) setForecast(parsed);
      else await loadForecast();
      notify("The forecast finished and the production plan is ready to review.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The forecast could not be completed.";
      setForecastError(message);
      notify(message);
    } finally {
      setForecastRunning(false);
    }
  };

  const historyProducts = useMemo(() => {
    const products = new Map<string, { id: string; name: string; current: number; previous: number }>();
    history?.rows.forEach((row) => {
      const existing = products.get(row.productId) ?? { id: row.productId, name: row.productName, current: 0, previous: 0 };
      existing.current += row.currentQuantity;
      existing.previous += row.previousQuantity;
      products.set(row.productId, existing);
    });
    return [...products.values()].sort((left, right) => right.current - left.current);
  }, [history]);
  const effectiveHistoryProductId = historyProductId === "all" || historyProducts.some((product) => product.id === historyProductId)
    ? historyProductId
    : "all";
  const selectedHistoryProduct = effectiveHistoryProductId === "all"
    ? null
    : historyProducts.find((product) => product.id === effectiveHistoryProductId) ?? null;
  const displayedHistoryRows = useMemo(() => effectiveHistoryProductId === "all"
    ? history?.rows ?? []
    : (history?.rows ?? []).filter((row) => row.productId === effectiveHistoryProductId), [effectiveHistoryProductId, history]);
  const displayedHistoryCurrent = displayedHistoryRows.reduce((sum, row) => sum + row.currentQuantity, 0);
  const displayedHistoryPrevious = displayedHistoryRows.reduce((sum, row) => sum + row.previousQuantity, 0);
  const displayedHistoryChange = displayedHistoryPrevious > 0
    ? ((displayedHistoryCurrent - displayedHistoryPrevious) / displayedHistoryPrevious) * 100
    : null;
  const historyChartSeries = useMemo(() => groupHistorySeriesByProduct(displayedHistoryRows), [displayedHistoryRows]);
  const locationTotals = useMemo(() => {
    const totals = new Map<string, { current: number; previous: number }>();
    displayedHistoryRows.forEach((row) => {
      const existing = totals.get(row.locationId) ?? { current: 0, previous: 0 };
      existing.current += row.currentQuantity;
      existing.previous += row.previousQuantity;
      totals.set(row.locationId, existing);
    });
    return [...totals.entries()].sort((left, right) => right[1].current - left[1].current);
  }, [displayedHistoryRows]);
  const productLocationRows = selectedLocations.map((location) => ({
    location,
    totals: locationTotals.find(([locationId]) => locationId === location.id)?.[1] ?? { current: 0, previous: 0 },
  }));
  const historyBounds = dashboardPeriodBounds(historyPeriod, historyAnchor);
  const historyStart = history?.currentStart || historyBounds.startDate;
  const historyEnd = history?.currentEnd || historyBounds.endDate;
  const bestProduct = historyProducts.find((product) => product.current > 0);
  const strongestLocation = locationTotals.find(([, totals]) => totals.current > 0);
  const showAggregateRankingCards = locationId === "all" && !selectedHistoryProduct;

  const scopedForecast = useMemo(() => {
    if (!forecast) return null;
    const allowed = new Set(selectedLocationIds);
    const eligibleRuns = forecast.runs.filter((run) => (!run.locationId || allowed.has(run.locationId)) && (!run.period || run.period === forecastPeriod));
    const newestByLocation = new Map<string, ForecastRun>();
    eligibleRuns.forEach((run) => {
      const key = run.locationId || run.id;
      const existing = newestByLocation.get(key);
      if (!existing || Date.parse(run.generatedAt || "0") > Date.parse(existing.generatedAt || "0")) newestByLocation.set(key, run);
    });
    const runs = [...newestByLocation.values()];
    const runIds = new Set(runs.map((run) => run.id).filter(Boolean));
    const recommendations = forecast.recommendations.filter((item) => item.productId && allowed.has(item.locationId) && (!item.runId || runIds.size === 0 || runIds.has(item.runId)));
    const sources = forecast.sources.filter((source) => !source.runId || runIds.size === 0 || runIds.has(source.runId));
    return { runs, recommendations, sources };
  }, [forecast, forecastPeriod, selectedLocationIds]);

  const forecastProducts = useMemo(() => {
    const products = new Map<string, {
      id: string;
      name: string;
      baseline: number;
      recommended: number;
      confidence: "high" | "medium" | "low";
      locations: Map<string, number>;
      explanations: string[];
      adjustments: ForecastAdjustment[];
      runIds: Set<string>;
    }>();
    const confidenceRank = { high: 2, medium: 1, low: 0 };
    scopedForecast?.recommendations.forEach((item) => {
      const existing = products.get(item.productId) ?? {
        id: item.productId,
        name: item.productName,
        baseline: 0,
        recommended: 0,
        confidence: "high" as const,
        locations: new Map<string, number>(),
        explanations: [],
        adjustments: [],
        runIds: new Set<string>(),
      };
      existing.baseline += item.baselineQuantity;
      existing.recommended += item.recommendedQuantity;
      existing.locations.set(item.locationId, (existing.locations.get(item.locationId) ?? 0) + item.recommendedQuantity);
      if (confidenceRank[item.confidence] < confidenceRank[existing.confidence]) existing.confidence = item.confidence;
      if (item.explanation && !existing.explanations.includes(item.explanation)) existing.explanations.push(item.explanation);
      existing.adjustments.push(...item.adjustments);
      if (item.runId) existing.runIds.add(item.runId);
      products.set(item.productId, existing);
    });
    return [...products.values()].sort((left, right) => right.recommended - left.recommended);
  }, [scopedForecast]);

  const totalRecommended = forecastProducts.reduce((sum, product) => sum + product.recommended, 0);
  const totalBaseline = forecastProducts.reduce((sum, product) => sum + product.baseline, 0);
  const forecastBounds = dashboardPeriodBounds(forecastPeriod, forecastAnchor);
  const forecastRuns = scopedForecast?.runs ?? [];
  const generatedAt = forecastRuns.map((run) => run.generatedAt).filter(Boolean).sort().at(-1) ?? "";
  const forecastStart = forecastRuns.map((run) => run.periodStart).filter(Boolean).sort()[0] ?? "";
  const forecastEnd = forecastRuns.map((run) => run.periodEnd).filter(Boolean).sort().at(-1) ?? "";
  const runStatuses = [...new Set(forecastRuns.map((run) => run.status))];
  const researchCompleted = forecastRuns.length > 0 && forecastRuns.every((run) => run.researchCompleted);
  const forecastPolicyVersions = [...new Set(forecastRuns.map((run) => run.policyVersion).filter(Boolean))];
  const currentPolicyVersion = activePolicy?.policyVersion ?? "";
  const forecastUsesCurrentPolicy = forecastPolicyVersions.length === 0 || !currentPolicyVersion || (forecastPolicyVersions.length === 1 && forecastPolicyVersions[0] === currentPolicyVersion);
  const confidenceCounts = forecastProducts.reduce((counts, product) => {
    counts[product.confidence] += 1;
    return counts;
  }, { high: 0, medium: 0, low: 0 });
  const overallConfidence = confidenceCounts.low ? "Low" : confidenceCounts.medium ? "Medium" : forecastProducts.length ? "High" : "Unavailable";
  const deliverableForecastStatuses = new Set(["complete", "baseline_only", "needs_review"]);
  const exactForecastRuns = forecastRuns.filter((run) => run.id
    && selectedLocationIds.includes(run.locationId)
    && run.periodStart === forecastBounds.startDate
    && run.periodEnd === forecastBounds.endDate
    && deliverableForecastStatuses.has(run.status));
  const exactRunByLocation = new Map(exactForecastRuns.map((run) => [run.locationId, run]));
  const exactRunIds = [...new Set(exactForecastRuns.map((run) => run.id))];
  const manualForecastReady = selectedLocationIds.length > 0
    && selectedLocationIds.length <= 20
    && selectedLocationIds.every((id) => exactRunByLocation.has(id))
    && exactRunIds.length === selectedLocationIds.length
    && forecastUsesCurrentPolicy;
  const selectedLocationIdSet = new Set(selectedLocationIds);
  const matchingUserRecipients = appData.users.filter((user) => user.status === "active"
    && user.emailEnabled
    && user.locationIds.some((id) => selectedLocationIdSet.has(id)));
  const matchingAdditionalRecipients = appData.emailRecipients.filter((recipient) => recipient.enabled
    && recipient.locationIds.some((id) => selectedLocationIdSet.has(id)));
  const manualRecipientCount = matchingUserRecipients.length + matchingAdditionalRecipients.length;
  const canManuallySend = appData.currentUser.role === "super_admin" || appData.currentUser.role === "admin";
  const resendConnected = appData.providerConnections.some((connection) => connection.provider === "resend" && connection.status === "connected");
  const githubConnected = appData.providerConnections.some((connection) => connection.provider === "github" && connection.status === "connected");
  const manualSendDisabledReason = !appData.emailSchedule
    ? "Save an email schedule in Configuration first."
    : !resendConnected
      ? "Connect and test Resend in Configuration first."
      : !appData.emailDeliveryReady
        ? "Send a successful internal test email before using manual delivery."
        : !githubConnected || !activePolicy
          ? "Connect GitHub and activate the repository Analysis Skill first."
    : selectedLocationIds.length > 20
      ? "Choose 20 or fewer locations for one manual send."
      : !manualForecastReady
        ? "Run and review an exact saved forecast for every selected location first."
        : manualRecipientCount === 0
          ? "Enable at least one matching user or individual email recipient."
          : manualRecipientCount > 100
            ? "Choose a narrower location scope with no more than 100 matching recipients."
          : null;

  const sendManualEmail = async () => {
    if (manualSendDisabledReason || manualSending) return;
    setManualSending(true);
    setManualSendError(null);
    try {
      const response = await fetch("/api/email/send-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locationIds: selectedLocationIds,
          periodStart: forecastBounds.startDate,
          periodEnd: forecastBounds.endDate,
          expectedRunIds: exactRunIds,
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiError(payload, "The forecast email could not be sent."));
      const result = record(unwrapApiData(payload));
      const sent = number(result.sent);
      const skipped = number(result.skipped);
      const failed = number(result.failed);
      const failureCodes = Object.fromEntries(Object.entries(record(result.failureCodes)).map(([code, count]) => [code, number(count)]));
      const deliveryResult = { recipientsChecked: number(result.recipientsChecked), sent, skipped, failed, failureCodes };
      setManualSendResult(deliveryResult);
      if (sent === 0 && failed > 0) {
        const message = `No emails were sent. ${formatNumber(failed)} ${failed === 1 ? "delivery failed" : "deliveries failed"}. Review the details below.`;
        setManualSendError(message);
        notify(message);
        return;
      }
      if (failed > 0) {
        const message = `${formatNumber(sent)} sent, but ${formatNumber(failed)} ${failed === 1 ? "delivery failed" : "deliveries failed"}. Review the details below before retrying.`;
        setManualSendError(message);
        notify(message);
        return;
      }
      if (sent === 0 && skipped === 0) {
        const message = "No eligible recipients remained when delivery was rechecked. Refresh the dashboard and review the email list.";
        setManualSendError(message);
        notify(message);
        return;
      }
      setManualSendOpen(false);
      notify(sent > 0
        ? `${formatNumber(sent)} ${sent === 1 ? "email" : "emails"} sent${skipped ? ` · ${formatNumber(skipped)} safely skipped` : ""}${failed ? ` · ${formatNumber(failed)} failed` : ""}.`
        : `No duplicate email was sent. ${formatNumber(skipped)} ${skipped === 1 ? "delivery was" : "deliveries were"} safely skipped.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The forecast email could not be sent.";
      setManualSendError(message);
      notify(message);
    } finally {
      setManualSending(false);
    }
  };

  const exportHistory = () => {
    if (!displayedHistoryRows.length) return;
    const productToken = selectedHistoryProduct ? `-${filenameToken(selectedHistoryProduct.name)}` : "-all-products";
    downloadCsv(`inventory-history-${historyPeriod}-${historyAnchor}${productToken}.csv`, [
      ["period_start", "period_end", "brand", "location", "product", "units", "previous_units"],
      ...displayedHistoryRows.map((row) => {
        const location = locationById.get(row.locationId);
        const brand = location ? brandById.get(location.brandId) : undefined;
        return [row.currentStart, row.currentEnd, brand?.name ?? "", location?.name ?? "", row.productName, row.currentQuantity, row.previousQuantity];
      }),
    ]);
    notify(`Historical data downloaded for ${selectedHistoryProduct?.name ?? "all products"}.`);
  };

  const exportForecast = () => {
    if (!scopedForecast?.recommendations.length) return;
    downloadCsv(`inventory-forecast-${forecastPeriod}-${forecastAnchor}.csv`, [
      ["period_start", "period_end", "brand", "location", "product", "baseline_units", "recommended_units", "confidence", "explanation"],
      ...scopedForecast.recommendations.map((item) => {
        const location = locationById.get(item.locationId);
        const brand = location ? brandById.get(location.brandId) : undefined;
        return [forecastStart, forecastEnd, brand?.name ?? "", location?.name ?? "", item.productName, item.baselineQuantity, item.recommendedQuantity, item.confidence, item.explanation];
      }),
    ]);
    notify("Forecast plan downloaded for the selected locations.");
  };

  const displayName = appData.currentUser.displayName.trim().split(/\s+/)[0] || appData.currentUser.username || "there";

  return (
    <div className="page-stack dashboard-page">
      <header className="page-header dashboard-header">
        <div>
          <span className="eyebrow">{formatHeaderDate(appData.workspace.defaultTimeZone)}</span>
          <h1>Welcome, {displayName}</h1>
          <p>Review imported sales and completed forecasts for only the locations assigned to you.</p>
        </div>
        {canRunForecast ? (
          <button
            type="button"
            className="button button-primary"
            disabled={forecastRunning || selectedLocationIds.length === 0}
            onClick={() => void runForecast()}
          >
            <RefreshCw size={17} className={forecastRunning ? "is-spinning" : ""} aria-hidden="true" />
            {forecastRunning ? "Running forecast…" : "Run forecast"}
          </button>
        ) : null}
      </header>

      {assignedLocations.length === 0 ? (
        <StatePanel title="No locations are assigned to you" message="Ask a workspace administrator to assign at least one location before using the dashboard or receiving forecasts." />
      ) : null}

      <section className="content-section" aria-labelledby="historical-heading">
        <div className="section-heading-row">
          <div className="section-title-with-icon">
              <span className="section-icon"><TrendingUp size={20} aria-hidden="true" /></span>
              <div>
                <span className="eyebrow">Historical data</span>
              <h2 id="historical-heading">What we sold in the past</h2>
                <p>Imported product sales for {selectedBrandName} · {selectedLocationName}</p>
              </div>
            </div>
          <div className="section-controls dashboard-section-controls">
            <div className="period-control-group">
              <PeriodSelector value={historyPeriod} onChange={setHistoryPeriod} label="Historical data period" />
              <PeriodValueSelector period={historyPeriod} anchor={historyAnchor} onChange={setHistoryAnchor} label="Historical data" />
            </div>
            <label className="history-product-selector">
              <span>Product</span>
              <select value={effectiveHistoryProductId} onChange={(event) => onHistoryProductChange(event.target.value)} disabled={!historyProducts.length}>
                <option value="all">All products</option>
                {historyProducts.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </label>
            <button type="button" className="button button-secondary" disabled={!displayedHistoryRows.length} onClick={exportHistory}>
              <Download size={16} aria-hidden="true" /> Export
            </button>
          </div>
        </div>

        {historyLoading ? <StatePanel title="Loading historical sales…" message="Calculating this period from your imported records." /> : null}
        {!historyLoading && historyError ? <StatePanel title="Historical data is unavailable" message={historyError} tone="error" /> : null}
        {!historyLoading && !historyError && history ? (
          <>
            <div className="stat-grid four-stats">
              <article className="stat-card">
                <span>{selectedHistoryProduct ? `${selectedHistoryProduct.name} sold` : "Units sold"}</span>
                <p className="stat-card-description">Total imported units sold during the selected period.</p>
                <strong>{formatNumber(displayedHistoryCurrent)}</strong>
                <small className={displayedHistoryChange !== null && displayedHistoryChange < 0 ? "metric-negative" : "metric-positive"}>
                  {displayedHistoryChange === null ? "No prior-period comparison" : <>{displayedHistoryChange < 0 ? <ArrowDownRight size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{Math.abs(displayedHistoryChange).toFixed(1)}% vs. prior {historyPeriod}</>}
                </small>
              </article>
              <article className="stat-card">
                <span>Average per day</span>
                <p className="stat-card-description">Average units sold per calendar day in this period.</p>
                <strong>{formatNumber(displayedHistoryCurrent / daysInclusive(historyStart, historyEnd), 1)}</strong>
                <small>{formatRange(historyStart, historyEnd)}</small>
              </article>
              {showAggregateRankingCards ? (
                <>
                  <article className="stat-card">
                    <span>Best-selling product</span>
                    <p className="stat-card-description">The product with the most units sold.</p>
                    <strong className="stat-card-product">{bestProduct?.name ?? "No sales yet"}</strong>
                    <small>{bestProduct ? `${formatNumber(bestProduct.current)} units · ${displayedHistoryCurrent ? ((bestProduct.current / displayedHistoryCurrent) * 100).toFixed(1) : "0"}% of sales` : "No product totals in this period"}</small>
                  </article>
                  <article className="stat-card accent-stat">
                    <span>Strongest location</span>
                    <p className="stat-card-description">The location with the most units sold.</p>
                    <strong className="stat-card-product">{strongestLocation ? locationById.get(strongestLocation[0])?.name ?? "Assigned location" : "No sales yet"}</strong>
                    <small>{strongestLocation ? `${formatNumber(strongestLocation[1].current)} units in this period` : "No location totals in this period"}</small>
                  </article>
                </>
              ) : (
                <>
                  <article className="stat-card">
                    <span>Prior {historyPeriod}</span>
                    <p className="stat-card-description">Units sold in the preceding comparable period.</p>
                    <strong>{formatNumber(displayedHistoryPrevious)}</strong>
                    <small>Units in the preceding comparable period</small>
                  </article>
                  <article className="stat-card accent-stat">
                    <span>Period change</span>
                    <p className="stat-card-description">Percentage difference from the preceding period.</p>
                    <strong className={displayedHistoryChange !== null && displayedHistoryChange < 0 ? "metric-negative" : "metric-positive"}>
                      {displayedHistoryChange === null ? "No comparison" : `${displayedHistoryChange > 0 ? "+" : ""}${displayedHistoryChange.toFixed(1)}%`}
                    </strong>
                    <small>{displayedHistoryPrevious ? `${formatNumber(Math.abs(displayedHistoryCurrent - displayedHistoryPrevious))} units ${displayedHistoryCurrent >= displayedHistoryPrevious ? "higher" : "lower"}` : "No units in the prior period"}</small>
                  </article>
                </>
              )}
            </div>

            <div className="data-grid historical-grid">
              <article className="panel chart-panel">
                <div className="panel-heading">
                  <div>
                    <h3>{selectedHistoryProduct ? `${selectedHistoryProduct.name} sales over time` : "Sales by product over time"}</h3>
                    <p>{titleCase(historyPeriod)} view · imported units sold</p>
                  </div>
                  <span className="soft-badge">{formatRange(historyStart, historyEnd)}</span>
                </div>
                <HistoricalChart
                  series={historyChartSeries}
                  label={formatRange(historyStart, historyEnd)}
                  title={selectedHistoryProduct ? `${selectedHistoryProduct.name} units sold` : "Sales by product"}
                  description={selectedHistoryProduct
                    ? `A line chart of imported ${selectedHistoryProduct.name} sales for the selected authorized locations.`
                    : "Separate product lines compare imported sales for the selected authorized locations."}
                />
              </article>

              <article className="panel product-panel">
                <div className="panel-heading"><div><h3>{selectedHistoryProduct ? "Performance by location" : "Product performance"}</h3><p>Compared with the prior {historyPeriod}</p></div></div>
                {selectedHistoryProduct ? (
                  <div className="compact-table" role="table" aria-label={`${selectedHistoryProduct.name} performance by location`}>
                    <div className="compact-table-head" role="row"><span role="columnheader">Location</span><span role="columnheader">Units</span><span role="columnheader">Change</span></div>
                    {productLocationRows.map(({ location, totals }) => {
                      const change = totals.previous > 0 ? ((totals.current - totals.previous) / totals.previous) * 100 : null;
                      return (
                        <div className="compact-table-row" role="row" key={location.id}>
                          <span role="cell"><strong>{location.name}</strong><small>{brandById.get(location.brandId)?.name ?? "Assigned brand"}</small></span>
                          <span role="cell">{formatNumber(totals.current)}</span>
                          <span role="cell" className={change !== null && change < 0 ? "metric-negative" : "metric-positive"}>
                            {change === null ? "—" : <>{change < 0 ? <ArrowDownRight size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{Math.abs(change).toFixed(1)}%</>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : historyProducts.length ? (
                  <div className="compact-table" role="table" aria-label="Product performance">
                    <div className="compact-table-head" role="row"><span role="columnheader">Product</span><span role="columnheader">Units</span><span role="columnheader">Change</span></div>
                    {historyProducts.map((product) => {
                      const change = product.previous > 0 ? ((product.current - product.previous) / product.previous) * 100 : null;
                      return (
                        <div className="compact-table-row" role="row" key={product.id}>
                          <span role="cell"><strong>{product.name}</strong><small>{displayedHistoryCurrent ? ((product.current / displayedHistoryCurrent) * 100).toFixed(1) : "0"}% of total</small></span>
                          <span role="cell">{formatNumber(product.current)}</span>
                          <span role="cell" className={change !== null && change < 0 ? "metric-negative" : "metric-positive"}>
                            {change === null ? "—" : <>{change < 0 ? <ArrowDownRight size={14} aria-hidden="true" /> : <ArrowUpRight size={14} aria-hidden="true" />}{Math.abs(change).toFixed(1)}%</>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ) : <StatePanel title="No product sales" message="No imported quantities fall within this selection." />}
              </article>
            </div>
          </>
        ) : null}
      </section>

      <section className="content-section forecast-section" aria-labelledby="forecast-heading">
        <div className="section-heading-row">
          <div className="section-title-with-icon">
            <span className="section-icon forecast-icon"><Sparkles size={20} aria-hidden="true" /></span>
            <div>
              <span className="eyebrow">Multivariate forecasting</span>
              <h2 id="forecast-heading">Recommended production plan</h2>
              <p>{policyUnavailable ? "The Analysis Skill must be activated before forecasting." : "Plan production for the selected period using sales history and the active Analysis Skill."}</p>
            </div>
          </div>
          <div className="period-control-group forecast-period-controls">
            <PeriodSelector value={forecastPeriod} onChange={setForecastPeriod} label="Forecast period" />
            <PeriodValueSelector period={forecastPeriod} anchor={forecastAnchor} onChange={setForecastAnchor} label="Forecast" />
          </div>
        </div>

        <details className={`analysis-context-panel${policyUnavailable || !forecastUsesCurrentPolicy ? " is-stale" : ""}`} open={policyUnavailable || !forecastUsesCurrentPolicy || undefined}>
          <summary className="analysis-context-summary">
            <span><span className="eyebrow">Forecast inputs</span><strong>{policyUnavailable ? "Policy activation required" : activeVariables.length ? `${activeVariables.length} active ${activeVariables.length === 1 ? "factor" : "factors"} from the Analysis Skill` : "Based on sales history only"}</strong></span>
            <span className="analysis-context-action">{policyUnavailable || !forecastUsesCurrentPolicy ? "Action required" : "Factors used"}<ChevronDown size={16} aria-hidden="true" /></span>
          </summary>
          <div className="analysis-context-details">
            <p>{policyUnavailable ? "Ask an administrator to open Configuration → Analysis Skill and activate the policy." : activeVariables.length ? "Only these factors may be researched during a new forecast run." : "Add a precise factor in Configuration to enable external research."}</p>
            <div className="analysis-variable-chips" aria-label="Active forecast factors">
              {activeVariables.length ? activeVariables.map((variable) => <span key={variable.id}>{variable.name}</span>) : <span className="is-empty">No outside factors</span>}
            </div>
            {!forecastUsesCurrentPolicy ? <span className="status-badge status-warning">New run required for policy {currentPolicyVersion}</span> : null}
          </div>
        </details>

        {forecastLoading ? <StatePanel title="Loading the latest forecast…" message="Checking completed runs for your selected locations." /> : null}
        {!forecastLoading && forecastAvailability === "not-installed" ? <StatePanel title="Forecasting is not available yet" message="This deployment does not have the forecast routes installed. Finish the app setup before asking managers to use production recommendations." /> : null}
        {!forecastLoading && forecastError ? <StatePanel title={forecastAvailability === "setup-required" ? "Forecast setup is incomplete" : "Forecast is unavailable"} message={forecastError} tone={forecastAvailability === "ready" ? "error" : "neutral"} /> : null}
        {!forecastLoading && !forecastError && forecastAvailability === "ready" && forecastProducts.length === 0 ? <StatePanel title="No completed forecast for this selection" message={`No saved ${forecastPeriod} forecast matches ${formatRange(forecastBounds.startDate, forecastBounds.endDate)}. Run it after historical data, the Analysis Skill, and an AI provider are configured.`} /> : null}

        {!forecastLoading && !forecastError && forecastProducts.length > 0 ? (
          <>
            <div className="forecast-banner">
              <div className="forecast-total">
                <span className="forecast-date"><CalendarDays size={16} aria-hidden="true" /> {formatRange(forecastStart, forecastEnd)}</span>
                <span className="forecast-total-label">Recommended to make</span>
                <strong>{formatNumber(totalRecommended)}</strong>
                <span>units across the selected locations</span>
              </div>
              <div className="forecast-banner-stats">
                <div><small>History-only estimate</small><strong>{formatNumber(totalBaseline)} units</strong><span>Before outside factors</span></div>
                <div><small>Overall confidence</small><strong className="confidence-text">{overallConfidence}</strong><span>Review details by product</span></div>
              </div>
              <div className="forecast-freshness">
                <span className={`status-dot ${researchCompleted ? "status-dot-success" : ""}`} aria-hidden="true" />
                {researchCompleted ? "Research complete" : "Sales history only"} · Updated {formatDateTime(generatedAt)}{runStatuses.some((status) => status === "needs_review") ? " · Review needed" : ""}
              </div>
            </div>

            <article className="forecast-table-wrap panel">
              <div className="forecast-table-heading">
                <div><h3>Production plan by product</h3><p>Open a product to see the factors, location breakdown, and saved sources.</p></div>
                <button type="button" className="button button-secondary" onClick={exportForecast}><Download size={16} aria-hidden="true" /> Export plan</button>
              </div>
              <div className="live-forecast-table-scroll">
                <table className="live-forecast-table">
                  <caption className="sr-only">Recommended production plan for the selected assigned locations</caption>
                  <thead><tr><th>Product</th><th>Recommended</th><th>History-only</th><th>Change</th><th><span className="sr-only">Details</span></th></tr></thead>
                  <tbody>
                    {forecastProducts.map((product) => {
                      const expanded = expandedProduct === product.id;
                      const adjustment = product.baseline > 0 ? ((product.recommended - product.baseline) / product.baseline) * 100 : null;
                      const factorNames = [...new Set(product.adjustments.map((item) => item.variableName).filter(Boolean))];
                      const evidence = scopedForecast?.sources.filter((source) => (!source.runId || product.runIds.has(source.runId)) && (product.adjustments.some((item) => item.sourceIds.includes(source.id)) || product.adjustments.every((item) => item.sourceIds.length === 0))) ?? [];
                      return (
                        <Fragment key={product.id}>
                          <tr className="forecast-product-row">
                            <td className="forecast-product"><strong>{product.name}</strong><small>{titleCase(product.confidence)} confidence · {factorNames.length ? `${factorNames.length} ${factorNames.length === 1 ? "factor" : "factors"} applied` : researchCompleted ? "No outside adjustment" : "Sales history only"}</small></td>
                            <td className="forecast-quantity" data-label="Recommended"><strong>{formatNumber(product.recommended)}</strong><small>units</small></td>
                            <td data-label="History-only">{formatNumber(product.baseline)}</td>
                            <td data-label="Change" className={adjustment !== null && adjustment < 0 ? "metric-negative" : "metric-positive"}>{adjustment === null ? "—" : `${adjustment > 0 ? "+" : ""}${adjustment.toFixed(1)}%`}</td>
                            <td className="forecast-detail-cell"><button type="button" className="icon-button expand-button" aria-label={`${expanded ? "Hide" : "Show"} reasoning for ${product.name}`} aria-expanded={expanded} onClick={() => setExpandedProduct(expanded ? null : product.id)}><ChevronDown size={17} /></button></td>
                          </tr>
                          {expanded ? (
                            <tr className="live-forecast-details">
                              <td colSpan={5}>
                                <div className="forecast-reasoning">
                                  <section className="reason-summary"><span className="reason-icon"><Sparkles size={18} aria-hidden="true" /></span><div><h4>Why this amount</h4>{product.explanations.length ? product.explanations.map((explanation) => <p key={explanation}>{explanation}</p>) : <p>No explanation was stored for this recommendation.</p>}</div></section>
                                  <section className="forecast-detail-group"><h4>Factors considered</h4><div className="reason-tags">{factorNames.length ? factorNames.map((name) => <span key={name}>{name}</span>) : <span>Sales history only</span>}</div></section>
                                  {selectedLocations.length > 1 ? <section className="forecast-detail-group"><h4>Location breakdown</h4><div className="forecast-location-breakdown">{selectedLocations.map((location) => <span key={location.id}><strong>{formatNumber(product.locations.get(location.id) ?? 0)}</strong><small>{location.name}</small></span>)}</div></section> : null}
                                  <section className="evidence-note"><Info size={16} aria-hidden="true" /><div><h4>Sources checked</h4><span>{evidence.length ? `${evidence.length} saved ${evidence.length === 1 ? "source" : "sources"}` : researchCompleted ? "No linked source was returned for this item." : "Outside research was not used for this sales-history-only run."}</span>{evidence.map((source) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.runId}-${source.id}`}>{source.title}{source.publisher ? ` · ${source.publisher}` : ""} <ExternalLink size={12} aria-hidden="true" /></a>)}</div></section>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>

            {forecastRuns.flatMap((run) => run.warnings).length ? (
              <div className="forecast-warning-list" role="status"><strong>Forecast warnings</strong><ul>{[...new Set(forecastRuns.flatMap((run) => run.warnings))].map((warning) => <li key={warning}>{warning}</li>)}</ul></div>
            ) : null}
          </>
        ) : null}

        <p className="recommendation-note">Recommendations are planning guidance, not guarantees. Review the saved evidence and confidence before acting.</p>
      </section>

      {canManuallySend ? <section className="manual-email-panel" aria-labelledby="manual-email-heading">
        <span className="manual-email-icon"><Mail size={22} aria-hidden="true" /></span>
        <div className="manual-email-copy"><span className="eyebrow">Backup delivery</span><h2 id="manual-email-heading">Send the selected forecast now</h2><p>{manualSendDisabledReason || `This sends one combined email to ${manualRecipientCount} matching ${manualRecipientCount === 1 ? "recipient" : "recipients"}, limited to the ${selectedLocationIds.length} selected ${selectedLocationIds.length === 1 ? "location" : "locations"}.`}</p></div>
        <button type="button" className="button button-primary button-large" disabled={Boolean(manualSendDisabledReason) || manualSending} onClick={(event) => { manualDialogOpenerRef.current = event.currentTarget; setManualSendResult(null); setManualSendError(null); setManualSendOpen(true); }}><Send size={17} aria-hidden="true" /> Send Email</button>
      </section> : null}

      {manualSendOpen ? <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!manualSending) setManualSendOpen(false); }}>
        <section ref={(node) => { manualDialogRef.current = node; }} className="modal-card manual-email-modal" role="dialog" aria-modal="true" aria-labelledby="manual-send-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
          <div className="drawer-heading"><div><span className="eyebrow"><Send size={15} aria-hidden="true" /> Manual delivery</span><h2 id="manual-send-title">Send this forecast now?</h2></div><button type="button" className="icon-button" aria-label="Close manual email confirmation" data-dialog-initial disabled={manualSending} onClick={() => setManualSendOpen(false)}><X size={18} /></button></div>
          <p className="modal-intro">This is a real email send. Inventory Auditor will recheck each person&apos;s current location access and the saved forecast before delivery.</p>
          <dl className="manual-send-summary">
            <div><dt>Forecast period</dt><dd>{formatRange(forecastBounds.startDate, forecastBounds.endDate)}</dd></div>
            <div><dt>Locations</dt><dd>{selectedLocations.map((location) => location.name).join(", ")}</dd></div>
            <div><dt>Matching recipients</dt><dd>{manualRecipientCount} total · {matchingUserRecipients.length} app {matchingUserRecipients.length === 1 ? "user" : "users"} · {matchingAdditionalRecipients.length} individual {matchingAdditionalRecipients.length === 1 ? "email" : "emails"}</dd></div>
          </dl>
          <div className="secure-note"><Info size={18} aria-hidden="true" /><span><strong>Duplicate-send protection is on.</strong> Repeating the same manual send within five minutes is safely skipped.</span></div>
          {manualSendError ? <div className="manual-send-result is-error" role="alert"><strong>{manualSendError}</strong>{manualSendResult && Object.keys(manualSendResult.failureCodes).length ? <ul>{Object.entries(manualSendResult.failureCodes).map(([code, count]) => <li key={code}>{formatNumber(count)}× {manualFailureLabel(code)}</li>)}</ul> : <span>Open Configuration → Email Schedule or Keys to correct the requirement, then return and refresh the dashboard.</span>}</div> : null}
          {manualSendResult && !manualSendError ? <div className="manual-send-result" role="status"><strong>{formatNumber(manualSendResult.sent)} sent · {formatNumber(manualSendResult.skipped)} safely skipped</strong><span>{formatNumber(manualSendResult.recipientsChecked)} matching recipients were checked immediately before delivery.</span></div> : null}
          <div className="drawer-actions"><button type="button" className="button button-secondary" disabled={manualSending} onClick={() => setManualSendOpen(false)}>Cancel</button><button type="button" className="button button-primary" disabled={manualSending} onClick={() => void sendManualEmail()}><Send size={16} aria-hidden="true" /> {manualSending ? "Sending…" : `Send to ${manualRecipientCount}`}</button></div>
        </section>
      </div> : null}
    </div>
  );
}
