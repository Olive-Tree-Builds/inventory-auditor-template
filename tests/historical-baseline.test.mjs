import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const workDirectory = join(process.cwd(), "work");
mkdirSync(workDirectory, { recursive: true });
const compiledDirectory = mkdtempSync(join(workDirectory, "baseline-tests-"));
const source = readFileSync("app/lib/server/historical-baseline.ts", "utf8")
  .replace('import type { HistoricalBaseline, HistoricalForecastRow } from "./forecast-provider.js";\n\n', "");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
writeFileSync(join(compiledDirectory, "historical-baseline.js"), compiled.outputText);
const baseline = await import(`${pathToFileURL(join(compiledDirectory, "historical-baseline.js")).href}?run=${Date.now()}`);
after(() => rmSync(compiledDirectory, { recursive: true, force: true }));

test("historical baseline uses comparable weekdays and covers every location/product pair", () => {
  const historicalRows = [
    ["2026-07-10", 90],
    ["2026-07-03", 100],
    ["2026-06-26", 110],
  ].map(([date, quantity]) => ({
    date,
    quantity,
    locationId: "location-1",
    productId: "product-1",
    product: "Croissant",
  }));
  const result = baseline.calculateHistoricalBaselines({
    historicalRows,
    locations: ["location-1"],
    products: [{ id: "product-1", name: "Croissant" }],
    startDate: "2026-07-17",
    endDate: "2026-07-17",
  });
  assert.equal(result.length, 1);
  assert.equal(result[0].quantity, 100);
  assert.equal(result[0].sampleSize, 3);
  assert.equal(result[0].confidence, "medium");
});

test("historical baseline rejects future and out-of-scope history", () => {
  assert.throws(() => baseline.calculateHistoricalBaselines({
    historicalRows: [{ date: "2026-07-17", quantity: 1, locationId: "other", productId: "product-1", product: "Croissant" }],
    locations: ["location-1"],
    products: [{ id: "product-1", name: "Croissant" }],
    startDate: "2026-07-17",
    endDate: "2026-07-17",
  }));
});
