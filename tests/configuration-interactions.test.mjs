import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

const configuration = readFileSync("app/components/ConfigurationScreen.tsx", "utf8");
const dataImportGuide = readFileSync("docs/DATA_IMPORT.md", "utf8");
const setupGuide = readFileSync("docs/SETUP.md", "utf8");
const setupStatusRoute = readFileSync("app/api/setup/status/route.ts", "utf8");

test("historical import requires one brand and submits its identifier", () => {
  assert.match(configuration, /Create the brand first/);
  assert.match(configuration, /Which brand does this sales history belong to\?/);
  assert.match(configuration, /The spreadsheet does not need a brand column/);
  assert.match(configuration, /disabled=\{!selectedBrand\}/);
  assert.match(configuration, /if \(!selectedBrand\) return notify\("Create and select a brand before uploading historical data\."\)/);
  assert.match(configuration, /form\.set\("brandId", selectedBrand\.id\)/);
  assert.match(configuration, /form\.set\("file", file\)/);
  assert.match(configuration, /apiRequest<ImportPreview>\("\/api\/history\/import", \{ method: "POST", body: form \}\)/);
  assert.match(configuration, /const brandId = activeBrands\.some\(\(brand\) => brand\.id === requestedBrandId\)[\s\S]*?\? requestedBrandId[\s\S]*?: activeBrands\[0\]\?\.id \|\| ""/);
  assert.doesNotMatch(configuration, /useEffect\(\(\) => \{[\s\S]{0,240}setRequestedBrandId/);
});

test("a commit request reports success only when the server confirms it was committed", () => {
  const sendStart = configuration.indexOf('async function send(mode: "preview" | "commit"');
  const sendEnd = configuration.indexOf("\n  function updateLocationDraft", sendStart);
  assert.ok(sendStart >= 0 && sendEnd > sendStart, "HistoryTab send handler should remain inspectable");

  const send = configuration.slice(sendStart, sendEnd);
  const uncommittedStart = send.indexOf("if (!result.committed)");
  const committedStart = send.indexOf("} else {", uncommittedStart);
  const catchStart = send.indexOf("\n    } catch", committedStart);
  assert.ok(uncommittedStart >= 0 && committedStart > uncommittedStart && catchStart > committedStart);

  const uncommittedBranch = send.slice(uncommittedStart, committedStart);
  const committedBranch = send.slice(committedStart, catchStart);
  assert.match(send, /form\.set\("mode", mode\)/);
  assert.doesNotMatch(send, /if \(mode === "preview"\)/);
  assert.doesNotMatch(uncommittedBranch, /Import complete:|await onDataChanged\(\)/);
  assert.match(uncommittedBranch, /Preview ready\. Review the products and row changes before importing\./);
  assert.match(committedBranch, /Import complete:/);
  assert.match(committedBranch, /await onDataChanged\(\)/);
});

test("an already-imported response is final without claiming that anything changed", () => {
  const sendStart = configuration.indexOf('async function send(mode: "preview" | "commit"');
  const sendEnd = configuration.indexOf("\n  function updateLocationDraft", sendStart);
  const send = configuration.slice(sendStart, sendEnd);
  const alreadyImportedStart = send.indexOf("if (result.alreadyImported)");
  const uncommittedStart = send.indexOf("} else if (!result.committed)", alreadyImportedStart);
  assert.ok(alreadyImportedStart >= 0 && uncommittedStart > alreadyImportedStart);

  const alreadyImportedBranch = send.slice(alreadyImportedStart, uncommittedStart);
  assert.match(configuration, /alreadyImported\?: boolean/);
  assert.match(alreadyImportedBranch, /This exact file was already imported\. Nothing changed\./);
  assert.doesNotMatch(alreadyImportedBranch, /Import complete:|await onDataChanged\(\)/);
  assert.match(configuration, /disabled=\{!preview \|\| hasBlockingReview \|\| preview\.committed \|\| preview\.alreadyImported \|\| submitting\}/);
  assert.match(configuration, /<h3>\{preview\.alreadyImported \? "This exact file was already imported" : preview\.committed \? "Import complete"/);
  assert.match(configuration, /\{preview\.alreadyImported \? "Already imported" : preview\.committed \? "Saved" : "Not saved yet"\}/);
});

test("the downloadable history template remains the exact four-column contract", () => {
  assert.ok(statSync("public/inventory-history-template.xlsx").size > 5_000, "history template should remain a real workbook");
  assert.match(configuration, /Four simple columns/);
  for (const heading of ["date", "product", "location", "quantity"]) {
    assert.match(configuration, new RegExp(`<code>${heading}<\\/code>`));
  }
  assert.match(dataImportGuide, /Use these four headers exactly, in this order/);
  assert.match(dataImportGuide, /date,product,location,quantity/);
});

test("unresolved locations must be deliberately matched or completed as new locations", () => {
  for (const instruction of [
    "Finish the locations found in this file",
    "Add as a new location",
    "Match an existing location",
    "Save locations and re-check file",
  ]) {
    assert.ok(configuration.includes(instruction), `missing location-resolution instruction: ${instruction}`);
  }

  for (const field of [
    "Location name",
    "Unique import code",
    "Street address",
    "City",
    "State / province / region",
    "Postal code",
    "Country code",
    "Timezone",
  ]) {
    assert.ok(configuration.includes(field), `missing new-location field: ${field}`);
  }

  assert.match(configuration, /draft\.choice === "existing"/);
  assert.match(configuration, /nextMappings\[unresolved\.sourceLocation\] = draft\.existingLocationId/);
  assert.match(configuration, /body: JSON\.stringify\(\{[\s\S]*?brandId: selectedBrand\.id,[\s\S]*?timezone: draft\.timezone/);
  assert.match(configuration, /await send\("preview", nextMappings, productMappings\)/);
  assert.match(dataImportGuide, /map the label to an existing active location/);
  assert.match(dataImportGuide, /Nothing from the spreadsheet is saved while any location remains unresolved/);
});

test("product review makes existing-versus-new decisions explicit", () => {
  for (const copy of [
    "Products discovered for",
    "Matched to {decision.productName}",
    "Create new product",
    "Match {product.name}",
    "Re-check product choices",
  ]) {
    assert.ok(configuration.includes(copy), `missing product decision contract: ${copy}`);
  }

  assert.match(configuration, /form\.set\("productMappings", JSON\.stringify\(nextProductMappings\)\)/);
  assert.match(configuration, /if \(productId\) next\[sourceProduct\] = productId;[\s\S]*?else delete next\[sourceProduct\]/);
  assert.match(dataImportGuide, /An unseen product defaults to \*\*Create new product\*\*/);
  assert.match(dataImportGuide, /map its source label to an existing product/);
});

test("final review separates every import outcome and promises preservation", () => {
  const outcomes = [
    ["insertedCount", "New rows"],
    ["unchangedCount", "Unchanged rows"],
    ["correctedCount", "Corrections"],
    ["productsCreatedCount", "New products"],
  ];

  for (const [property, label] of outcomes) {
    assert.ok(configuration.includes(`outcomes.${property}.toLocaleString()`), `missing outcome count: ${property}`);
    assert.ok(configuration.includes(`>${label}<`), `missing outcome label: ${label}`);
  }

  assert.match(configuration, /No other history will be removed\./);
  assert.match(configuration, /Dates and products missing from this file stay exactly as they are\./);
  assert.match(dataImportGuide, /rows omitted from a later file remain untouched/);
  assert.match(dataImportGuide, /inserted\/unchanged\/corrected result/);
});

test("setup checks and documentation require the fifth guided-import migration", () => {
  const migrationId = "20260717203635_guided_history_import";

  assert.ok(setupStatusRoute.includes(`"${migrationId}"`));
  assert.ok(setupGuide.includes(`supabase/migrations/${migrationId}.sql`));
  assert.match(setupGuide, /The fifth adds brand-first guided history imports/);
  assert.match(setupGuide, /After applying all five files/);
  assert.match(dataImportGuide, /Select one brand first; every row in that file belongs to that brand/);
});
