import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("brand and location timezone values use native dropdown pickers", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");

  assert.match(configuration, /<select name="defaultTimeZone" required/);
  assert.match(configuration, /<select name="timezone" required/);
  assert.match(configuration, /Intl[\s\S]*supportedValuesOf/);
  assert.match(configuration, /selectedLocationBrand\.defaultTimeZone/);
  assert.doesNotMatch(configuration, /<input name="timezone"/);
});

test("existing brands and locations expose real edit actions", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");

  assert.match(configuration, /Edit brand/);
  assert.match(configuration, /Save brand/);
  assert.match(configuration, /Save location/);
  assert.match(configuration, /`\/api\/brands\/\$\{encodeURIComponent\(editingBrand\.id\)\}`[\s\S]*method: "PATCH"/);
  assert.match(configuration, /`\/api\/locations\/\$\{encodeURIComponent\(editingLocation\.id\)\}`[\s\S]*method: "PATCH"/);
  assert.match(configuration, /addressLine1: fields\.get\("addressLine1"\)/);
  assert.match(configuration, /active: fields\.get\("active"\) === "on"/);
  assert.match(configuration, /expectedUpdatedAt: editingBrand\.updatedAt/);
  assert.match(configuration, /expectedUpdatedAt: editingLocation\.updatedAt/);
});

test("brand logos are validated in the browser and uploaded through the scoped API", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");

  assert.match(configuration, /new Set\(\["image\/png", "image\/jpeg", "image\/webp"\]\)/);
  assert.match(configuration, /MAX_BRAND_LOGO_BYTES = 2 \* 1024 \* 1024/);
  assert.match(configuration, /accept="image\/png,image\/jpeg,image\/webp"/);
  assert.match(configuration, /`\/api\/brands\/\$\{encodeURIComponent\(brandId\)\}\/logo`/);
  assert.match(configuration, /body: JSON\.stringify\(\{ dataUrl: logo\.dataUrl \}\)/);
  assert.match(configuration, /src=\{brand\.logoUrl\}/);
  assert.match(configuration, /<Image[\s\S]*unoptimized/);
  assert.doesNotMatch(configuration, /src="\/brand-logo\.png"/);
});

test("email schedule keeps individual recipients without a delivery-list ledger", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");

  assert.match(configuration, /Send test to me/);
  assert.match(configuration, /Individual email recipients/);
  assert.match(configuration, /Add email/);
  assert.doesNotMatch(configuration, /Delivery list|delivery list/);
});
