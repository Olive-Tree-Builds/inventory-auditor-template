import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dashboard = readFileSync("app/components/DashboardScreen.tsx", "utf8");
const styles = readFileSync("app/globals.css", "utf8");

test("ranking cards appear only for all visible locations and all products", () => {
  assert.match(dashboard, /const showAggregateRankingCards = locationId === "all" && !selectedHistoryProduct;/);
  assert.match(dashboard, /\{showAggregateRankingCards \? \(/);
  assert.match(dashboard, /Best-selling product/);
  assert.match(dashboard, /Strongest location/);
});

test("historical chart keeps a separate, labeled series for every displayed product", () => {
  assert.match(dashboard, /function groupHistorySeriesByProduct\(rows: HistoryRow\[\]\): HistoryChartSeries\[\]/);
  assert.match(dashboard, /products\.get\(row\.productId\)/);
  assert.match(dashboard, /groupHistorySeriesByProduct\(displayedHistoryRows\)/);
  assert.match(dashboard, /series=\{historyChartSeries\}/);
  assert.match(dashboard, /className="chart-legend" aria-label="Product lines"/);
  assert.match(dashboard, /aria-label="Historical sales chart values"/);
  assert.match(dashboard, /Sales by product over time/);
  assert.doesNotMatch(dashboard, /aggregateHistorySeries/);
});

test("historical metric cards explain every displayed measure", () => {
  for (const explanation of [
    "Total imported units sold during the selected period.",
    "Average units sold per calendar day in this period.",
    "The product with the most units sold.",
    "The location with the most units sold.",
    "Units sold in the preceding comparable period.",
    "Percentage difference from the preceding period.",
  ]) {
    assert.match(dashboard, new RegExp(explanation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(styles, /\.stat-card-description\s*\{/);
});

test("forecasting uses a compact disclosure, a stable five-column table, and readable mobile cards", () => {
  assert.match(dashboard, /<details className=\{`analysis-context-panel/);
  assert.match(dashboard, /Forecast inputs/);
  assert.match(dashboard, /<th>Product<\/th><th>Recommended<\/th><th>History-only<\/th><th>Change<\/th>/);
  assert.match(dashboard, /<td colSpan=\{5\}>/);
  assert.match(dashboard, /Why this amount/);
  assert.match(dashboard, /Factors considered/);
  assert.match(dashboard, /Location breakdown/);
  assert.match(dashboard, /Sources checked/);
  assert.doesNotMatch(dashboard, /selectedLocations\.map\(\(location\) => <th/);
  assert.doesNotMatch(styles, /\.forecast-reasoning\s*\{[^}]*min-width:\s*690px/s);
  assert.match(styles, /\.forecast-product-row\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
});

test("saved forecasts include a location-and-period decision breakdown for every active factor", () => {
  assert.match(dashboard, /const forecastDecisionBreakdowns = useMemo/);
  assert.match(dashboard, /new Map\(activeVariables\.map\(\(variable\) => \[variable\.id, variable\.name\]\)\)/);
  assert.match(dashboard, /locationName: locationById\.get\(run\.locationId\)\?\.name/);
  assert.match(dashboard, /AI decision breakdown/);
  assert.match(dashboard, /Why these numbers\?/);
  assert.match(dashboard, /History-only estimate/);
  assert.match(dashboard, /Factor change/);
  assert.match(dashboard, /All factors reviewed/);
  assert.match(dashboard, /What the AI found:/);
  assert.match(dashboard, /Why it matters:/);
  assert.match(dashboard, /Product-by-product conclusion/);
  assert.match(dashboard, /Uses the saved forecast—no additional AI call/);
  assert.match(styles, /\.forecast-decision-math\s*\{/);
  assert.match(styles, /\.forecast-factor-explanation summary\s*\{/);
});
