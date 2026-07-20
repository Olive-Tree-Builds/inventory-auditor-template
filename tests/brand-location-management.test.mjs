import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const workDirectory = join(process.cwd(), "work");
mkdirSync(workDirectory, { recursive: true });
const compiledDirectory = mkdtempSync(join(workDirectory, "brand-logo-tests-"));
const logoSource = readFileSync("app/lib/server/brand-logo.ts", "utf8");
const compiled = ts.transpileModule(logoSource, {
  fileName: "brand-logo.ts",
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: true,
  },
  reportDiagnostics: true,
});
assert.deepEqual(
  (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error),
  [],
  "brand-logo.ts should transpile without diagnostics",
);
writeFileSync(join(compiledDirectory, "brand-logo.js"), compiled.outputText);
const logo = await import(`${pathToFileURL(join(compiledDirectory, "brand-logo.js")).href}?run=${Date.now()}`);

after(() => rmSync(compiledDirectory, { recursive: true, force: true }));

function dataUrl(contentType, bytes) {
  return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
}

test("logo parser accepts bounded PNG, JPEG, and WebP signatures", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  assert.equal(logo.parseBrandLogoDataUrl(`data:image/png;base64,${png}`).extension, "png");

  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ]);
  assert.equal(logo.parseBrandLogoDataUrl(dataUrl("image/jpeg", jpeg)).extension, "jpg");

  const webp = Buffer.alloc(30);
  webp.write("RIFF", 0, "ascii");
  webp.writeUInt32LE(22, 4);
  webp.write("WEBPVP8X", 8, "ascii");
  webp.writeUInt32LE(10, 16);
  assert.equal(logo.parseBrandLogoDataUrl(dataUrl("image/webp", webp)).extension, "webp");
});

test("logo parser rejects SVG, declared MIME mismatches, malformed base64, and oversized payloads", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.throws(() => logo.parseBrandLogoDataUrl(dataUrl("image/png", svg)), {
    code: "invalid_brand_logo",
    status: 400,
  });

  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010000000000000000000000000049454e4400000000", "hex");
  assert.throws(() => logo.parseBrandLogoDataUrl(dataUrl("image/jpeg", png)), {
    code: "invalid_brand_logo",
  });
  assert.throws(() => logo.parseBrandLogoDataUrl("data:image/png;base64,!!!!"), {
    code: "invalid_brand_logo",
  });

  const oversized = Buffer.alloc(logo.BRAND_LOGO_MAX_BYTES + 1);
  assert.throws(() => logo.parseBrandLogoDataUrl(dataUrl("image/png", oversized)), {
    code: "brand_logo_too_large",
    status: 413,
  });
});

test("brand and location routes are admin RPC boundaries with IANA timezone inputs", () => {
  const createBrand = readFileSync("app/api/brands/route.ts", "utf8");
  const updateBrand = readFileSync("app/api/brands/[brandId]/route.ts", "utf8");
  const updateLocation = readFileSync("app/api/locations/[locationId]/route.ts", "utf8");
  const logoRoute = readFileSync("app/api/brands/[brandId]/logo/route.ts", "utf8");

  for (const route of [createBrand, updateBrand, updateLocation, logoRoute]) {
    assert.match(route, /requireWorkspaceContext\(\["super_admin", "admin"\]\)/);
  }
  assert.match(createBrand, /defaultTimeZone/);
  assert.match(createBrand, /isValidIanaTimeZone/);
  assert.match(createBrand, /ia_create_brand/);
  assert.match(updateBrand, /ia_update_brand/);
  assert.match(updateBrand, /p_default_time_zone/);
  assert.match(updateBrand, /expectedUpdatedAt: z\.iso\.datetime\(\{ offset: true \}\)/);
  assert.match(updateBrand, /p_expected_updated_at: input\.expectedUpdatedAt/);
  assert.match(updateBrand, /error\.code === "IA409"[\s\S]*new HttpError\(409,[\s\S]*"brand_stale"/);
  assert.match(updateLocation, /ia_update_location/);
  assert.match(updateLocation, /isValidIanaTimeZone/);
  assert.match(updateLocation, /expectedUpdatedAt: z\.iso\.datetime\(\{ offset: true \}\)/);
  assert.match(updateLocation, /p_expected_updated_at: input\.expectedUpdatedAt/);
  assert.match(updateLocation, /error\.code === "IA409"[\s\S]*new HttpError\(409,[\s\S]*"location_stale"/);

  assert.ok(
    logoRoute.indexOf("await requireWorkspaceContext") < logoRoute.indexOf("createSupabaseAdminClient()"),
    "logo route must authenticate and authorize before creating a service client",
  );
  assert.match(logoRoute, /parseBrandLogoDataUrl/);
  assert.match(logoRoute, /upsert: false/);
  assert.match(logoRoute, /ia_server_set_brand_logo/);
  assert.ok((logoRoute.match(/\.remove\(/g) ?? []).length >= 2, "failed and replaced objects need cleanup paths");
});

test("migration makes logo reads public while keeping writes server-only and scoped", () => {
  const migration = readFileSync("supabase/migrations/20260717010000_brand_location_management.sql", "utf8");
  assert.match(migration, /add column default_time_zone text/);
  assert.match(migration, /add column logo_object_path text/);
  assert.match(migration, /'brand-logos',[\s\S]*?true,[\s\S]*?2097152/);
  assert.match(migration, /array\['image\/png', 'image\/jpeg', 'image\/webp'\]/);
  assert.doesNotMatch(migration, /create policy[\s\S]{0,1000}storage\.objects/i);
  assert.match(migration, /create function public\.ia_update_brand/);
  assert.match(migration, /create function public\.ia_update_location/);
  assert.match(migration, /p_expected_updated_at timestamptz/g);
  assert.match(migration, /v_brand\.updated_at is distinct from p_expected_updated_at[\s\S]*errcode = 'IA409'/);
  assert.match(migration, /v_location\.updated_at is distinct from p_expected_updated_at[\s\S]*errcode = 'IA409'/);
  assert.match(migration, /'updated_at', v_brand\.updated_at/);
  assert.match(migration, /'updated_at', v_location\.updated_at/);
  assert.match(migration, /create trigger ia_locations_guard_brand_state/);
  assert.match(migration, /create function public\.ia_server_set_brand_logo/);
  assert.match(migration, /p_new_object_path !~/);
  assert.match(migration, /grant execute on function public\.ia_server_set_brand_logo\(uuid, uuid, uuid, text\) to service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.ia_server_set_brand_logo[^;]+to authenticated/);
  assert.match(migration, /values \('20260717010000_brand_location_management'\)/);
});

test("bootstrap data exposes only the public logo URL and editable display fields", () => {
  const appData = readFileSync("app/lib/app-data.ts", "utf8");
  const appRoute = readFileSync("app/api/app/route.ts", "utf8");
  assert.match(appData, /defaultTimeZone: string/);
  assert.match(appData, /logoUrl: string \| null/);
  assert.match(appData, /addressLine1: string/);
  assert.equal((appData.match(/updatedAt: string/g) ?? []).length, 2);
  assert.match(appRoute, /default_time_zone, logo_object_path, is_active, updated_at/);
  assert.match(appRoute, /time_zone, is_active, updated_at/);
  assert.equal((appRoute.match(/updatedAt: String\([^)]+\.updated_at\)/g) ?? []).length, 2);
  assert.match(appRoute, /getPublicUrl/);
  assert.doesNotMatch(appData, /logoObjectPath|logo_object_path/);
});

test("brand and location updates rely on the existing automatic revision trigger", () => {
  const foundation = readFileSync("supabase/migrations/20260716210000_inventory_auditor.sql", "utf8");
  const management = readFileSync("supabase/migrations/20260717010000_brand_location_management.sql", "utf8");

  assert.match(foundation, /create function ia_private\.ia_set_updated_at\(\)[\s\S]*new\.updated_at := now\(\)/);
  assert.match(foundation, /create trigger ia_brands_updated_at before update on public\.ia_brands[\s\S]*ia_private\.ia_set_updated_at\(\)/);
  assert.match(foundation, /create trigger ia_locations_updated_at before update on public\.ia_locations[\s\S]*ia_private\.ia_set_updated_at\(\)/);
  assert.match(management, /update public\.ia_brands[\s\S]*returning \* into v_brand/);
  assert.match(management, /update public\.ia_locations[\s\S]*returning \* into v_location/);
});
