import { createHash, timingSafeEqual } from "node:crypto";

export const DELIVERABLE_FORECAST_STATUSES = ["complete", "baseline_only", "needs_review"] as const;
export type DeliverableForecastStatus = (typeof DELIVERABLE_FORECAST_STATUSES)[number];

export type CombinedForecastEmailLocation = {
  locationId: string;
  runId: string;
  brandName: string;
  locationName: string;
  periodStart: string;
  periodEnd: string;
  status: DeliverableForecastStatus;
  generatedAt: string;
  products: Array<{
    name: string;
    recommendedQuantity: number;
    confidence: "high" | "medium" | "low";
    explanation: string;
  }>;
  sources: Array<{ title: string; url: string }>;
};

export type CombinedForecastEmail = {
  subject: string;
  html: string;
  text: string;
};

export type EmailDeliveryErrorCode =
  | "invalid_content"
  | "invalid_schedule"
  | "invalid_time_zone";

export class EmailDeliveryError extends Error {
  constructor(
    public readonly code: EmailDeliveryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EmailDeliveryError";
  }
}

function boundedText(value: unknown, maximum = 2_000): string {
  const normalized = String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!normalized) throw new EmailDeliveryError("invalid_content", "Required forecast email content is missing.");
  return normalized.slice(0, maximum);
}

export function escapeEmailHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function assertIsoDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid date.");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid date.");
  }
  return value;
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(new Date(`${assertIsoDate(value)}T00:00:00.000Z`));
}

function forecastStatusLabel(status: DeliverableForecastStatus): string {
  if (status === "baseline_only") return "Historical baseline only";
  if (status === "needs_review") return "Needs review";
  return "Complete forecast";
}

/** Build one recipient-specific message. Every caller must scope locations first. */
export function composeCombinedForecastEmail(input: {
  workspaceName: string;
  recipientName: string;
  locations: readonly CombinedForecastEmailLocation[];
  internalTest?: boolean;
}): CombinedForecastEmail {
  const workspaceName = boundedText(input.workspaceName, 120);
  const recipientName = boundedText(input.recipientName, 120);
  if (!input.locations.length || input.locations.length > 100) {
    throw new EmailDeliveryError("invalid_content", "The combined email must contain between 1 and 100 locations.");
  }

  const seenLocations = new Set<string>();
  const sections = input.locations.map((location) => {
    if (!location.locationId || !location.runId || seenLocations.has(location.locationId)) {
      throw new EmailDeliveryError("invalid_content", "The combined email contains a duplicate or invalid location.");
    }
    seenLocations.add(location.locationId);
    if (!DELIVERABLE_FORECAST_STATUSES.includes(location.status)) {
      throw new EmailDeliveryError("invalid_content", "The combined email contains an undeliverable forecast.");
    }
    if (!location.products.length || location.products.length > 200) {
      throw new EmailDeliveryError("invalid_content", "Each emailed location must contain 1 to 200 recommendations.");
    }

    const brandName = boundedText(location.brandName, 120);
    const locationName = boundedText(location.locationName, 160);
    const periodStart = assertIsoDate(location.periodStart);
    const periodEnd = assertIsoDate(location.periodEnd);
    if (periodStart > periodEnd) {
      throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid period.");
    }

    const productRows = location.products.map((product) => {
      const name = boundedText(product.name, 160);
      const explanation = boundedText(product.explanation, 2_000);
      if (!Number.isSafeInteger(product.recommendedQuantity) || product.recommendedQuantity < 0) {
        throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid recommendation quantity.");
      }
      if (!["high", "medium", "low"].includes(product.confidence)) {
        throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid confidence value.");
      }
      return { name, explanation, quantity: product.recommendedQuantity, confidence: product.confidence };
    });

    const sourceRows = Array.from(new Map(location.sources.map((source) => {
      const title = boundedText(source.title, 300);
      let url: URL;
      try {
        url = new URL(source.url);
      } catch {
        throw new EmailDeliveryError("invalid_content", "A forecast email contains an invalid evidence URL.");
      }
      if (url.protocol !== "https:" || url.username || url.password) {
        throw new EmailDeliveryError("invalid_content", "Forecast evidence links must use public HTTPS URLs.");
      }
      return [url.toString(), { title, url: url.toString() }] as const;
    })).values()).slice(0, 100);

    return {
      brandName,
      locationName,
      periodStart,
      periodEnd,
      status: location.status,
      products: productRows,
      sources: sourceRows,
    };
  });

  const subjectPrefix = input.internalTest ? "Internal test — " : "";
  const subject = `${subjectPrefix}Inventory Auditor production plan — ${workspaceName}`.slice(0, 200);
  const preamble = input.internalTest
    ? "This is an internal delivery test using only stored forecast recommendations."
    : "Here is your production plan based on the latest approved stored forecasts.";

  const htmlSections = sections.map((section) => {
    const period = section.periodStart === section.periodEnd
      ? displayDate(section.periodStart)
      : `${displayDate(section.periodStart)} – ${displayDate(section.periodEnd)}`;
    const rows = section.products.map((product) => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #e7e5df;vertical-align:top"><strong>${escapeEmailHtml(product.name)}</strong><br><span style="color:#68716b;font-size:12px">${escapeEmailHtml(product.confidence)} confidence</span></td>
        <td style="padding:10px;border-bottom:1px solid #e7e5df;text-align:right;vertical-align:top"><strong>${product.quantity.toLocaleString("en-US")}</strong></td>
        <td style="padding:10px;border-bottom:1px solid #e7e5df;vertical-align:top">${escapeEmailHtml(product.explanation)}</td>
      </tr>`).join("");
    const evidence = section.sources.length
      ? `<p style="margin:16px 0 6px;font-weight:700">Evidence</p><ul>${section.sources.map((source) => `<li><a href="${escapeEmailHtml(source.url)}">${escapeEmailHtml(source.title)}</a></li>`).join("")}</ul>`
      : "";
    return `
      <section style="margin:24px 0;padding:20px;border:1px solid #dcd9d1;border-radius:12px">
        <p style="margin:0;color:#28634f;font-size:12px;font-weight:700;text-transform:uppercase">${escapeEmailHtml(section.brandName)}</p>
        <h2 style="margin:6px 0 4px;font-size:20px">${escapeEmailHtml(section.locationName)}</h2>
        <p style="margin:0 0 14px;color:#68716b">${escapeEmailHtml(period)} · ${escapeEmailHtml(forecastStatusLabel(section.status))}</p>
        <table role="presentation" style="width:100%;border-collapse:collapse"><thead><tr><th style="padding:10px;text-align:left">Product</th><th style="padding:10px;text-align:right">Quantity</th><th style="padding:10px;text-align:left">Reason</th></tr></thead><tbody>${rows}</tbody></table>
        ${evidence}
      </section>`;
  }).join("");

  const html = `<!doctype html><html><body style="margin:0;background:#f6f5f1;color:#202723;font-family:Arial,sans-serif"><div style="max-width:760px;margin:0 auto;padding:28px"><div style="background:#fff;padding:28px;border-radius:14px"><p style="margin:0;color:#28634f;font-size:13px;font-weight:700;text-transform:uppercase">Inventory Auditor</p><h1 style="margin:8px 0 10px;font-size:26px">Production plan for ${escapeEmailHtml(recipientName)}</h1><p>${escapeEmailHtml(preamble)}</p>${htmlSections}<p style="margin-top:24px;color:#68716b;font-size:12px">Workspace: ${escapeEmailHtml(workspaceName)}. Contact your workspace administrator if an assignment or recommendation looks incorrect.</p></div></div></body></html>`;

  const textSections = sections.map((section) => {
    const period = section.periodStart === section.periodEnd
      ? displayDate(section.periodStart)
      : `${displayDate(section.periodStart)} – ${displayDate(section.periodEnd)}`;
    const products = section.products.map((product) => (
      `- ${product.name}: ${product.quantity.toLocaleString("en-US")} (${product.confidence} confidence)\n  ${product.explanation}`
    )).join("\n");
    const evidence = section.sources.length
      ? `\nEvidence:\n${section.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`
      : "";
    return `${section.brandName} — ${section.locationName}\n${period} · ${forecastStatusLabel(section.status)}\n${products}${evidence}`;
  }).join("\n\n");
  const text = `Inventory Auditor\n\nProduction plan for ${recipientName}\n${preamble}\n\n${textSections}\n\nWorkspace: ${workspaceName}. Contact your workspace administrator if an assignment or recommendation looks incorrect.`;

  return { subject, html, text };
}

function hashIdempotencyParts(parts: readonly string[]): string {
  if (parts.some((part) => !String(part ?? "").trim())) {
    throw new EmailDeliveryError("invalid_content", "Email idempotency data is incomplete.");
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function buildInternalTestIdempotencyKey(input: {
  workspaceId: string;
  actorUserId: string;
  recipientUserId: string;
  runIds: readonly string[];
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()) || !input.runIds.length) {
    throw new EmailDeliveryError("invalid_content", "Internal test idempotency data is incomplete.");
  }
  const fiveMinuteBucket = Math.floor(now.getTime() / 300_000).toString();
  const digest = hashIdempotencyParts([
    input.workspaceId,
    input.actorUserId,
    input.recipientUserId,
    ...[...input.runIds].sort(),
    fiveMinuteBucket,
  ]);
  return `inventory-auditor:test:${digest}`;
}

/** Stable recipient/run signature used by the database's rolling duplicate window. */
export function buildManualSendDedupeKey(input: {
  workspaceId: string;
  recipientKey: string;
  runIds: readonly string[];
}): string {
  if (!input.runIds.length) {
    throw new EmailDeliveryError("invalid_content", "Manual email deduplication data is incomplete.");
  }
  const digest = hashIdempotencyParts([
    input.workspaceId,
    input.recipientKey,
    ...[...input.runIds].sort(),
  ]);
  return `inventory-auditor:manual-dedupe:${digest}`;
}

/** Provider key for one allowed manual attempt; database deduplication is rolling. */
export function buildManualSendIdempotencyKey(input: {
  workspaceId: string;
  recipientKey: string;
  runIds: readonly string[];
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime()) || !input.runIds.length) {
    throw new EmailDeliveryError("invalid_content", "Manual email idempotency data is incomplete.");
  }
  const digest = hashIdempotencyParts([
    input.workspaceId,
    input.recipientKey,
    ...[...input.runIds].sort(),
    now.toISOString(),
  ]);
  return `inventory-auditor:manual:${digest}`;
}

export function isAuthorizedCronRequest(authorization: string | null, cronSecret: string): boolean {
  const expected = String(cronSecret ?? "").trim();
  const supplied = authorization?.match(/^Bearer ([^\s]+)$/)?.[1] ?? "";
  if (expected.length < 32 || !supplied) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export type EmailSchedule = {
  cadence: "daily" | "weekdays" | "weekly" | "custom";
  weekdayMask: number;
  localSendTime: string;
  timezoneRule: "earliest_assigned_location" | "workspace" | "user_selected";
  workspaceTimeZone: string | null;
  recipientTimeZone: string | null;
  locationTimeZones: readonly string[];
  forecastHorizon: "today" | "tomorrow" | "next_7_days";
};

export type DueEmailSchedule = {
  timeZone: string;
  localDate: string;
  scheduledFor: string;
  periodStart: string;
  periodEnd: string;
};

function formatLocalDate(now: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value;
    const year = part("year");
    const month = part("month");
    const day = part("day");
    if (!year || !month || !day) throw new Error("date parts unavailable");
    return `${year}-${month}-${day}`;
  } catch {
    throw new EmailDeliveryError("invalid_time_zone", "The email schedule contains an invalid timezone.");
  }
}

function localPartsAt(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"), month: value("month"), day: value("day"),
    hour: value("hour"), minute: value("minute"), second: value("second"),
  };
}

function zonedLocalTimeToUtc(localDate: string, localTime: string, timeZone: string): Date {
  assertIsoDate(localDate);
  const match = localTime.match(/^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/);
  if (!match) throw new EmailDeliveryError("invalid_schedule", "The email schedule contains an invalid send time.");
  const [year, month, day] = localDate.split("-").map(Number);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  try {
    for (let index = 0; index < 5; index += 1) {
      const parts = localPartsAt(new Date(guess), timeZone);
      const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      const adjustment = target - represented;
      guess += adjustment;
      if (adjustment === 0) break;
    }
    const result = new Date(guess);
    const parts = localPartsAt(result, timeZone);
    if (
      parts.year !== year || parts.month !== month || parts.day !== day ||
      parts.hour !== hour || parts.minute !== minute
    ) {
      throw new Error("nonexistent local time");
    }
    return result;
  } catch {
    throw new EmailDeliveryError("invalid_time_zone", "The scheduled local time could not be resolved in its timezone.");
  }
}

function dayAllowed(cadence: EmailSchedule["cadence"], weekdayMask: number, localDate: string): boolean {
  if (!Number.isInteger(weekdayMask) || weekdayMask < 0 || weekdayMask > 127) {
    throw new EmailDeliveryError("invalid_schedule", "The email schedule contains an invalid weekday selection.");
  }
  const day = new Date(`${localDate}T00:00:00.000Z`).getUTCDay();
  if (cadence === "daily") return true;
  if (cadence === "weekdays") return day >= 1 && day <= 5;
  if (cadence === "custom") return (weekdayMask & (1 << day)) !== 0;
  const selectedDay = Array.from({ length: 7 }, (_, index) => index)
    .find((index) => (weekdayMask & (1 << index)) !== 0);
  return selectedDay !== undefined && day === selectedDay;
}

function addDays(date: string, count: number): string {
  const value = new Date(`${assertIsoDate(date)}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + count);
  return value.toISOString().slice(0, 10);
}

function periodFor(localDate: string, horizon: EmailSchedule["forecastHorizon"]): { start: string; end: string } {
  if (horizon === "tomorrow") {
    const tomorrow = addDays(localDate, 1);
    return { start: tomorrow, end: tomorrow };
  }
  if (horizon === "next_7_days") return { start: localDate, end: addDays(localDate, 6) };
  return { start: localDate, end: localDate };
}

/**
 * Evaluate a schedule in its selected IANA timezone. A 60-minute window lets a
 * 15-minute cron tolerate short delays; database idempotency prevents repeats.
 */
export function evaluateDueEmailSchedule(
  schedule: EmailSchedule,
  now = new Date(),
  dueWindowMinutes = 60,
): DueEmailSchedule | null {
  if (Number.isNaN(now.getTime()) || !Number.isInteger(dueWindowMinutes) || dueWindowMinutes < 1 || dueWindowMinutes > 120) {
    throw new EmailDeliveryError("invalid_schedule", "The email scheduler received invalid timing data.");
  }
  let timeZones: string[];
  if (schedule.timezoneRule === "workspace") {
    timeZones = schedule.workspaceTimeZone ? [schedule.workspaceTimeZone] : [];
  } else if (schedule.timezoneRule === "user_selected") {
    timeZones = schedule.recipientTimeZone ? [schedule.recipientTimeZone] : [];
  } else {
    timeZones = [...new Set(schedule.locationTimeZones.filter(Boolean))];
  }
  if (!timeZones.length) return null;

  const candidates = timeZones.map((timeZone) => {
    const localDate = formatLocalDate(now, timeZone);
    if (!dayAllowed(schedule.cadence, schedule.weekdayMask, localDate)) return null;
    const scheduled = zonedLocalTimeToUtc(localDate, schedule.localSendTime, timeZone);
    return { timeZone, localDate, scheduled };
  }).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
  if (!candidates.length) return null;

  const selected = candidates.sort((left, right) => left.scheduled.getTime() - right.scheduled.getTime())[0];
  const elapsed = now.getTime() - selected.scheduled.getTime();
  if (elapsed < 0 || elapsed >= dueWindowMinutes * 60_000) return null;
  const period = periodFor(selected.localDate, schedule.forecastHorizon);
  return {
    timeZone: selected.timeZone,
    localDate: selected.localDate,
    scheduledFor: selected.scheduled.toISOString(),
    periodStart: period.start,
    periodEnd: period.end,
  };
}
