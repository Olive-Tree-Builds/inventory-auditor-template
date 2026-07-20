import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const workDirectory = join(process.cwd(), "work");
mkdirSync(workDirectory, { recursive: true });
const compiledDirectory = mkdtempSync(join(workDirectory, "period-selection-tests-"));
const source = readFileSync("app/lib/period-selection.ts", "utf8");
const compiled = ts.transpileModule(source, {
  fileName: "period-selection.ts",
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
  reportDiagnostics: true,
});
const errors = (compiled.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(errors, [], "period-selection.ts should transpile without diagnostics");
writeFileSync(join(compiledDirectory, "period-selection.js"), compiled.outputText);

const periods = await import(`${pathToFileURL(join(compiledDirectory, "period-selection.js")).href}?run=${Date.now()}`);

after(() => rmSync(compiledDirectory, { recursive: true, force: true }));

test("calendar bounds are exact for every dashboard period", () => {
  assert.deepEqual(periods.dashboardPeriodBounds("day", "2026-07-16"), {
    startDate: "2026-07-16", endDate: "2026-07-16",
  });
  assert.deepEqual(periods.dashboardPeriodBounds("week", "2026-07-16"), {
    startDate: "2026-07-13", endDate: "2026-07-19",
  });
  assert.deepEqual(periods.dashboardPeriodBounds("month", "2024-02-20"), {
    startDate: "2024-02-01", endDate: "2024-02-29",
  });
  assert.deepEqual(periods.dashboardPeriodBounds("quarter", "2026-11-08"), {
    startDate: "2026-10-01", endDate: "2026-12-31",
  });
  assert.deepEqual(periods.dashboardPeriodBounds("year", "2026-07-16"), {
    startDate: "2026-01-01", endDate: "2026-12-31",
  });
});

test("native period input values round trip to a stable date-only anchor", () => {
  for (const [period, anchor] of [
    ["day", "2026-07-16"],
    ["week", "2026-01-01"],
    ["month", "2026-07-16"],
    ["quarter", "2026-07-16"],
    ["year", "2026-07-16"],
  ]) {
    const value = periods.dashboardPeriodInputValue(period, anchor);
    const roundTrip = periods.anchorFromDashboardPeriodInput(period, value);
    assert.deepEqual(
      periods.dashboardPeriodBounds(period, roundTrip),
      periods.dashboardPeriodBounds(period, anchor),
      `${period} should preserve its selected calendar period`,
    );
  }
});

test("timestamps, impossible dates, and invalid ISO weeks are rejected", () => {
  assert.throws(() => periods.parseDateOnly("2026-07-16T10:30:00Z"));
  assert.throws(() => periods.parseDateOnly("2026-02-30"));
  assert.throws(() => periods.anchorFromDashboardPeriodInput("week", "2021-W53"));
  assert.throws(() => periods.anchorFromDashboardPeriodInput("quarter", "2026-Q5"));
});

test("forecast routes derive exact bounds on the server and the dashboard uses source keys", () => {
  const latest = readFileSync("app/api/forecasts/latest/route.ts", "utf8");
  const run = readFileSync("app/api/forecasts/run/route.ts", "utf8");
  const history = readFileSync("app/api/history/dashboard/route.ts", "utf8");
  const dashboard = readFileSync("app/components/DashboardScreen.tsx", "utf8");

  assert.match(latest, /dashboardPeriodBounds\(period, anchor\)/);
  assert.doesNotMatch(latest, /forecastPeriod\(/);
  assert.match(run, /periodOverride = dashboardPeriodBounds\(input\.period, anchor\)/);
  assert.match(run, /periodOverride,/);
  assert.match(history, /selection: \{ period, anchor, \.\.\.bounds \}/);
  assert.match(dashboard, /first\(source, "key", "sourceKey", "source_key"/);
});

test("the shell exposes persistent scope while the dashboard keeps exact period and product views", () => {
  const shell = readFileSync("app/components/AppShell.tsx", "utf8");
  const app = readFileSync("app/components/InventoryAuditorApp.tsx", "utf8");
  const dashboard = readFileSync("app/components/DashboardScreen.tsx", "utf8");

  assert.match(shell, /id="desktop-brand-scope"/);
  assert.match(shell, /id="desktop-location-scope"/);
  assert.match(shell, /id="mobile-brand-scope"/);
  assert.match(shell, /id="mobile-location-scope"/);
  assert.doesNotMatch(dashboard, /dashboard-scope-card/);
  assert.match(app, /setDashboardLocationId\("all"\); setDashboardHistoryProductId\("all"\)/);
  assert.match(dashboard, /PeriodValueSelector period=\{historyPeriod\}/);
  assert.match(dashboard, /PeriodValueSelector period=\{forecastPeriod\}/);
  assert.match(dashboard, /What we sold in the past/);
  assert.match(dashboard, /Performance by location/);
  assert.match(dashboard, /selectedHistoryProduct \? \(/);
});
