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

test("forecasting uses a compact disclosure, a decision table, and readable mobile cards", () => {
  assert.match(dashboard, /<details className=\{`analysis-context-panel/);
  assert.match(dashboard, /Forecast inputs/);
  assert.match(dashboard, /<th>Product<\/th><th>Historical baseline<\/th><th>AI-advised<\/th><th>Difference<\/th><th>Brief reason<\/th>/);
  assert.match(dashboard, /<td colSpan=\{6\}>/);
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
  assert.match(dashboard, /Historical baseline by location/);
  assert.match(dashboard, /Live researched factors by location/);
  assert.match(dashboard, /Rough prediction based on no previous data for these factors/);
  assert.match(dashboard, /AI-advised production quantities/);
  assert.match(dashboard, /What was found:/);
  assert.match(dashboard, /Possible effect:/);
  assert.match(dashboard, /No researched factors were applied/);
  assert.match(dashboard, /Saved research—no additional AI call/);
  assert.match(styles, /\.forecast-baseline-value\s*\{/);
  assert.match(styles, /\.forecast-factor-explanation summary\s*\{/);
});
