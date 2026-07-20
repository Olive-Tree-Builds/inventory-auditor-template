export const dashboardPeriodOptions = ["day", "week", "month", "quarter", "year"] as const;

export type DashboardPeriod = (typeof dashboardPeriodOptions)[number];

export type PeriodBounds = {
  startDate: string;
  endDate: string;
};

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDays(value: string, amount: number): string {
  return isoDate(new Date(utcDate(value).getTime() + amount * DAY_MS));
}

export function parseDateOnly(value: unknown): string {
  if (typeof value !== "string") throw new Error("Date must use YYYY-MM-DD.");
  const match = DATE_ONLY.exec(value);
  if (!match) throw new Error("Date must use YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 9999) throw new Error("Date year is outside the supported range.");
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) throw new Error("Date is not a real calendar day.");
  return value;
}

export function parseDashboardPeriod(value: unknown): DashboardPeriod {
  if (typeof value !== "string" || !dashboardPeriodOptions.includes(value.toLocaleLowerCase() as DashboardPeriod)) {
    throw new Error("Period must be day, week, month, quarter, or year.");
  }
  return value.toLocaleLowerCase() as DashboardPeriod;
}

export function dashboardPeriodBounds(periodInput: DashboardPeriod | string, anchorInput: string): PeriodBounds {
  const period = parseDashboardPeriod(periodInput);
  const anchor = parseDateOnly(anchorInput);
  const date = utcDate(anchor);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();

  if (period === "day") return { startDate: anchor, endDate: anchor };
  if (period === "week") {
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    const startDate = addDays(anchor, -mondayOffset);
    return { startDate, endDate: addDays(startDate, 6) };
  }
  if (period === "month") {
    return {
      startDate: isoDate(new Date(Date.UTC(year, month, 1))),
      endDate: isoDate(new Date(Date.UTC(year, month + 1, 0))),
    };
  }
  if (period === "quarter") {
    const quarterMonth = Math.floor(month / 3) * 3;
    return {
      startDate: isoDate(new Date(Date.UTC(year, quarterMonth, 1))),
      endDate: isoDate(new Date(Date.UTC(year, quarterMonth + 3, 0))),
    };
  }
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

function isoWeekValue(anchor: string): string {
  const date = utcDate(parseDateOnly(anchor));
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const weekYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 3 - ((firstThursday.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}

export function dashboardPeriodInputValue(periodInput: DashboardPeriod | string, anchorInput: string): string {
  const period = parseDashboardPeriod(periodInput);
  const anchor = parseDateOnly(anchorInput);
  if (period === "day") return anchor;
  if (period === "week") return isoWeekValue(anchor);
  if (period === "month") return anchor.slice(0, 7);
  const year = anchor.slice(0, 4);
  if (period === "quarter") {
    const quarter = Math.floor((Number(anchor.slice(5, 7)) - 1) / 3) + 1;
    return `${year}-Q${quarter}`;
  }
  return year;
}

export function anchorFromDashboardPeriodInput(periodInput: DashboardPeriod | string, value: string): string {
  const period = parseDashboardPeriod(periodInput);
  if (period === "day") return parseDateOnly(value);
  if (period === "week") {
    const match = /^(\d{4})-W(\d{2})$/.exec(value);
    if (!match) throw new Error("Week must use YYYY-Www.");
    const year = Number(match[1]);
    const week = Number(match[2]);
    if (year < 1900 || year > 9999 || week < 1 || week > 53) throw new Error("Week is outside the supported range.");
    const januaryFourth = new Date(Date.UTC(year, 0, 4));
    const mondayOffset = (januaryFourth.getUTCDay() + 6) % 7;
    const weekOneMonday = new Date(januaryFourth.getTime() - mondayOffset * DAY_MS);
    const anchor = isoDate(new Date(weekOneMonday.getTime() + (week - 1) * 7 * DAY_MS));
    if (isoWeekValue(anchor) !== value) throw new Error("Week is not valid for that year.");
    return anchor;
  }
  if (period === "month") {
    if (!/^\d{4}-\d{2}$/.test(value)) throw new Error("Month must use YYYY-MM.");
    return parseDateOnly(`${value}-01`);
  }
  if (period === "quarter") {
    const match = /^(\d{4})-Q([1-4])$/.exec(value);
    if (!match) throw new Error("Quarter must use YYYY-Q1 through YYYY-Q4.");
    const month = (Number(match[2]) - 1) * 3 + 1;
    return parseDateOnly(`${match[1]}-${String(month).padStart(2, "0")}-01`);
  }
  if (!/^\d{4}$/.test(value)) throw new Error("Year must use YYYY.");
  return parseDateOnly(`${value}-01-01`);
}
