import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ExcelJS from "exceljs";
import { parseHistoryImport } from "../app/lib/server/history-import.ts";

const brandId = "brand-1";
const locations = [{
  id: "location-1",
  brandId,
  name: "Queen Street",
  importCode: "queen-street",
  timeZone: "America/Toronto",
}];
const products = [{
  id: "product-1",
  brandId,
  name: "Butter Croissant",
  importCode: "butter-croissant",
}];
const now = new Date("2026-07-16T12:00:00Z");

function parseCsv(lines, overrides = {}) {
  return parseHistoryImport({
    filename: "history.csv",
    bytes: Buffer.from(lines.join("\n")),
    brandId,
    allowedLocations: locations,
    allowedProducts: products,
    now,
    ...overrides,
  });
}

test("history import accepts the exact date-only contract and identifies existing and new products", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Butter Croissant,Queen Street,128",
    "2026-07-16,Blueberry Muffin,Queen Street,0",
  ]);

  assert.equal(result.errors.length, 0);
  assert.equal(result.unresolvedLocations.length, 0);
  assert.equal(result.rowCount, 2);
  assert.equal(result.dateFrom, "2026-07-15");
  assert.equal(result.dateTo, "2026-07-16");
  assert.equal(result.rows[0]?.productId, "product-1");
  assert.equal(result.rows[1]?.productId, null);
  assert.deepEqual(
    result.productDecisions.map(({ sourceProduct, productId, decision }) => ({ sourceProduct, productId, decision })),
    [
      { sourceProduct: "Blueberry Muffin", productId: null, decision: "new" },
      { sourceProduct: "Butter Croissant", productId: "product-1", decision: "existing" },
    ],
  );
});

test("history import makes unknown locations resolvable while rejecting every other invalid row", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15T08:00:00Z,Butter Croissant,Queen Street,128",
    "2026-07-15,Butter Croissant,Unknown Store,12",
    "2026-07-15,Butter Croissant,Queen Street,-1",
    "2026-07-15,Butter Croissant,Queen Street,1.5",
    "2026-07-15,=HYPERLINK(\"https://bad.example\"),Queen Street,4",
    "2026-07-16,Butter Croissant,Queen Street,3",
    "2026-07-16,Butter Croissant,Queen Street,4",
  ]);

  assert.equal(result.rowCount, 1);
  assert.deepEqual(result.unresolvedLocations, [{
    sourceLocation: "Unknown Store",
    rowNumbers: [3],
    rowCount: 1,
  }]);
  assert.ok(result.errors.some((error) => error.includes("no timestamp")));
  assert.ok(result.errors.some((error) => error.includes("whole number")));
  assert.ok(result.errors.filter((error) => error.includes("whole number")).length >= 2);
  assert.ok(result.errors.some((error) => error.includes("formula")));
  assert.ok(result.errors.some((error) => error.includes("duplicates another row")));
  assert.ok(!result.errors.some((error) => error.includes("Unknown Store")));
});

test("history import rejects future dates using each resolved location's local business date", async () => {
  const boundaryInstant = new Date("2026-07-17T02:00:00Z");
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-17,Butter Croissant,Queen Street,12",
    "2026-07-17,Butter Croissant,Tokyo Central,8",
  ], {
    allowedLocations: [
      ...locations,
      {
        id: "location-2",
        brandId,
        name: "Tokyo Central",
        timeZone: "Asia/Tokyo",
      },
    ],
    now: boundaryInstant,
  });

  assert.equal(result.rowCount, 1);
  assert.equal(result.rows[0]?.locationId, "location-2");
  assert.ok(result.errors.some((error) => error.includes("after 2026-07-16")));
});

test("location and product names, codes, aliases, and explicit choices are case and whitespace insensitive", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,BUTTER   ITEM,downtown   store,11",
    "2026-07-14,legacy   cake,UNLISTED   STORE,9",
    "2026-07-13,New Item,QUEEN-STREET,5",
  ], {
    allowedLocations: [
      ...locations,
      {
        id: "location-2",
        brandId,
        name: "North York",
        importCode: "north-york",
        timeZone: "America/Toronto",
      },
    ],
    allowedProducts: [
      ...products,
      { id: "product-2", brandId, name: "Original Cake", importCode: "original-cake" },
    ],
    locationAliases: [{ locationId: "location-1", sourceLabel: "Downtown Store" }],
    productAliases: [{ productId: "product-1", sourceLabel: "Butter Item" }],
    locationMappings: { " unlisted store ": "location-2" },
    productMappings: { " LEGACY CAKE ": "product-2" },
  });

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.unresolvedLocations, []);
  assert.equal(result.rows[0]?.sourceLocation, "downtown   store");
  assert.equal(result.rows[0]?.sourceProduct, "BUTTER   ITEM");
  assert.equal(result.rows[0]?.locationId, "location-1");
  assert.equal(result.rows[0]?.productId, "product-1");
  assert.equal(result.rows[1]?.locationId, "location-2");
  assert.equal(result.rows[1]?.productId, "product-2");
  assert.equal(result.rows[2]?.locationId, "location-1", "the location import code is a valid lookup label");
  assert.equal(result.rows[2]?.productId, null);
  assert.equal(result.productDecisions.find((item) => item.sourceProduct === "legacy   cake")?.decision, "mapped");
});

test("explicit choices cannot cross the selected brand", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Shared Item,Shared Store,12",
  ], {
    allowedLocations: [
      ...locations,
      { id: "location-other", brandId: "brand-other", name: "Other Store", timeZone: "America/Toronto" },
    ],
    allowedProducts: [
      ...products,
      { id: "product-other", brandId: "brand-other", name: "Other Item" },
    ],
    locationAliases: [
      { locationId: "location-1", sourceLabel: "Shared Store" },
      { locationId: "location-other", sourceLabel: "Shared Store" },
    ],
    productAliases: [
      { productId: "product-1", sourceLabel: "Shared Item" },
      { productId: "product-other", sourceLabel: "Shared Item" },
    ],
    locationMappings: { "Shared Store": "location-other" },
    productMappings: { "Shared Item": "product-other" },
  });

  assert.ok(result.errors.some((error) => error.includes("location choice") && error.includes("this import")));
  assert.ok(result.errors.some((error) => error.includes("product choice") && error.includes("this import")));
  assert.equal(result.rowCount, 1, "invalid explicit choices are ignored without granting cross-brand access");
  assert.equal(result.rows[0]?.locationId, "location-1");
  assert.equal(result.rows[0]?.productId, "product-1");
});

test("ambiguous location and product aliases are rejected until an explicit valid choice resolves them", async () => {
  const sameBrandLocations = [
    ...locations,
    { id: "location-2", brandId, name: "North York", timeZone: "America/Toronto" },
  ];
  const sameBrandProducts = [
    ...products,
    { id: "product-2", brandId, name: "Original Cake" },
  ];
  const aliases = {
    locationAliases: [
      { locationId: "location-1", sourceLabel: "Shared Store" },
      { locationId: "location-2", sourceLabel: "Shared Store" },
    ],
    productAliases: [
      { productId: "product-1", sourceLabel: "Shared Item" },
      { productId: "product-2", sourceLabel: "Shared Item" },
    ],
  };
  const unresolved = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Shared Item,Shared Store,12",
  ], {
    allowedLocations: sameBrandLocations,
    allowedProducts: sameBrandProducts,
    ...aliases,
  });
  assert.equal(unresolved.rowCount, 0);
  assert.ok(unresolved.errors.some((error) => error.includes("product") && error.includes("ambiguous")));

  const unresolvedLocation = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Butter Croissant,Shared Store,12",
  ], {
    allowedLocations: sameBrandLocations,
    allowedProducts: sameBrandProducts,
    ...aliases,
  });
  assert.equal(unresolvedLocation.rowCount, 0);
  assert.ok(unresolvedLocation.errors.some((error) => error.includes("location") && error.includes("ambiguous")));

  const resolved = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Shared Item,Shared Store,12",
  ], {
    allowedLocations: sameBrandLocations,
    allowedProducts: sameBrandProducts,
    ...aliases,
    locationMappings: { " shared store ": "location-2" },
    productMappings: { "SHARED ITEM": "product-2" },
  });
  assert.deepEqual(resolved.errors, []);
  assert.equal(resolved.rows[0]?.locationId, "location-2");
  assert.equal(resolved.rows[0]?.productId, "product-2");
});

test("duplicates are detected after different source labels resolve to the same location and product", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Butter Croissant,Queen Street,12",
    "2026-07-15,Legacy Butter,Downtown Store,13",
  ], {
    locationAliases: [{ locationId: "location-1", sourceLabel: "Downtown Store" }],
    productAliases: [{ productId: "product-1", sourceLabel: "Legacy Butter" }],
  });

  assert.equal(result.rowCount, 1);
  assert.ok(result.errors.some((error) => error.includes("after applying your choices")));
});

test("date cells containing a time component are rejected rather than silently truncated", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sales Data");
  worksheet.addRow(["date", "product", "location", "quantity"]);
  worksheet.addRow([new Date("2026-07-15T13:30:00Z"), "Butter Croissant", "Queen Street", 2]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await parseHistoryImport({
    filename: "history.xlsx",
    bytes,
    brandId,
    allowedLocations: locations,
    allowedProducts: products,
    now,
  });

  assert.equal(result.rowCount, 0);
  assert.ok(result.errors.some((error) => error.includes("timestamp")));
});

test("data rows reject every non-empty or formula cell after the four required columns", async () => {
  const result = await parseCsv([
    "date,product,location,quantity",
    "2026-07-15,Butter Croissant,Queen Street,2,unexpected",
    "2026-07-14,Butter Croissant,Queen Street,3,=HYPERLINK(\"https://bad.example\")",
  ]);

  assert.equal(result.rowCount, 0);
  assert.ok(result.errors.some((error) => error.includes("outside the four required columns")));
  assert.ok(result.errors.some((error) => error.includes("formula")));
});

test("hidden spreadsheet columns are rejected under the exact four-column contract", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sales Data");
  worksheet.addRow(["date", "product", "location", "quantity"]);
  worksheet.addRow([new Date("2026-07-15T00:00:00Z"), "Butter Croissant", "Queen Street", 2]);
  worksheet.getColumn(2).hidden = true;
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  await assert.rejects(
    parseHistoryImport({
      filename: "history.xlsx",
      bytes,
      brandId,
      allowedLocations: locations,
      allowedProducts: products,
      now,
    }),
    /Hidden columns are not allowed/,
  );
});

test("the guided import route enforces brand scope, aliases, mappings, and the v2 preview-before-commit boundary", () => {
  const route = readFileSync("app/api/history/import/route.ts", "utf8");
  assert.match(route, /const \{ supabase, membership, user \} = await requireWorkspaceContext/);
  assert.match(route, /const brandId = z\.uuid\(\)\.parse\(form\.get\("brandId"\)\)/);
  assert.match(route, /form\.get\("locationMappings"\)/);
  assert.match(route, /form\.get\("productMappings"\)/);
  assert.match(route, /ia_location_import_aliases/);
  assert.match(route, /ia_product_import_aliases/);
  assert.match(route, /\.from\("ia_user_location_assignments"\)/);
  assert.match(
    route,
    /\.from\("ia_user_location_assignments"\)[\s\S]*?\.eq\("workspace_id", membership\.workspace_id\)[\s\S]*?\.eq\("user_id", user\.id\)[\s\S]*?\.eq\("is_active", true\)/,
  );
  assert.match(route, /\.in\("id", assignedLocationIds\)/);
  assert.match(route, /\.in\("location_id", assignedLocationIds\)/);
  assert.ok((route.match(/assignedLocationIdSet\.has/g) ?? []).length >= 2, "locations and aliases need a local assignment intersection");
  assert.ok(
    route.indexOf('.from("ia_user_location_assignments")') < route.indexOf('.from("ia_locations")'),
    "the user's active assignments must be loaded before importable locations",
  );
  assert.match(route, /ia_preview_historical_import_v2/);
  assert.match(route, /ia_import_historical_sales_v2/);
  assert.match(route, /file\.size > 5 \* 1024 \* 1024/);
  assert.match(route, /maxRows: 20_000/);
  assert.ok(
    route.indexOf("ia_preview_historical_import_v2") < route.indexOf("ia_import_historical_sales_v2"),
    "commit must follow the authoritative preview call",
  );
  for (const field of [
    "location_id",
    "product_id",
    "product_name",
    "source_location",
    "source_product",
    "business_date",
    "quantity",
  ]) {
    assert.match(route, new RegExp(`${field}:`));
  }
  assert.doesNotMatch(route, /ia_import_historical_sales"/);
});

test("the import route bounds multipart parsing and reports exact-file replays without false corrections", () => {
  const route = readFileSync("app/api/history/import/route.ts", "utf8");
  const postStart = route.indexOf("export async function POST");
  const lengthCheck = route.indexOf("validateDeclaredContentLength(request);", postStart);
  const formDataRead = route.indexOf("request.formData()", postStart);
  assert.ok(postStart >= 0 && lengthCheck > postStart && lengthCheck < formDataRead, "declared size must be checked before multipart parsing");
  assert.match(route, /MAX_MULTIPART_BYTES = 8 \* 1024 \* 1024/);
  assert.match(route, /headers\.get\("content-length"\)/);
  assert.match(route, /invalid_content_length/);
  assert.match(route, /import_request_too_large/);

  const parsedFile = route.indexOf("preview = await parseHistoryImport", postStart);
  const checksumPreflight = route.indexOf('.from("ia_import_batches")', parsedFile);
  const outcomeRpc = route.indexOf('rpc("ia_preview_historical_import_v2"', parsedFile);
  assert.ok(parsedFile >= 0 && checksumPreflight > parsedFile && checksumPreflight < outcomeRpc, "exact committed files must short-circuit before outcome preview");
  assert.match(
    route,
    /\.from\("ia_import_batches"\)[\s\S]*?\.eq\("workspace_id", membership\.workspace_id\)[\s\S]*?\.eq\("brand_id", brandId\)[\s\S]*?\.eq\("source_sha256", preview\.checksum\)[\s\S]*?\.eq\("status", "committed"\)/,
  );
  assert.match(route, /unchangedCount: count\(existingBatch\.row_count\)/);
  assert.match(
    route,
    /if \(existingBatch\) \{[\s\S]*?insertedCount: 0,[\s\S]*?correctedCount: 0,[\s\S]*?unchangedCount: count\(existingBatch\.row_count\),[\s\S]*?productsCreatedCount: 0/,
  );
  assert.match(route, /committed: false,[\s\S]*?alreadyImported: true/);
  assert.match(route, /typeof value\.already_imported !== "boolean"/);
  assert.match(route, /alreadyImported: value\.already_imported/);
  assert.match(route, /committed: !result\.alreadyImported/);
  assert.doesNotMatch(route, /error\.code === "23505"/);
});

test("the database import repeats the location-timezone future-date guard", () => {
  const migration = readFileSync("supabase/migrations/20260716210000_inventory_auditor.sql", "utf8");
  assert.match(migration, /transaction_timestamp\(\) at time zone location\.time_zone/);
  assert.match(migration, /historical sales cannot include a future local business date/);
});
