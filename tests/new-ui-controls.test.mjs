import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("the neutral Inventory Auditor artwork is used by every app lockup", () => {
  const logo = read("public/brand-logo-icon.svg");
  const component = read("app/components/BrandLogo.tsx");
  assert.match(logo, /Inventory Auditor/);
  assert.match(logo, /#28634f/i);
  assert.doesNotMatch(logo, /brand-logo\.png|#c9152c/i);
  assert.equal(existsSync("public/brand-logo.png"), false);
  assert.match(component, /src="\/brand-logo-icon\.svg"/);
  assert.match(component, /alt=\{decorative \? "" : "Inventory Auditor"\}/);
  assert.match(read("app/layout.tsx"), /brand-logo-icon\.svg/);
  for (const path of [
    "app/components/AppShell.tsx",
    "app/components/AuthScreen.tsx",
    "app/components/ConfigurationScreen.tsx",
    "app/components/InventoryAuditorApp.tsx",
    "app/components/SetupRequiredScreen.tsx",
    "app/invite/page.tsx",
    "app/reset-password/page.tsx",
  ]) {
    assert.match(read(path), /BrandLogo/);
    assert.doesNotMatch(read(path), /className="brand-mark"/);
  }
});

test("profile, help, mobile sign-out, and failed sign-out controls are real", () => {
  const shell = read("app/components/AppShell.tsx");
  const app = read("app/components/InventoryAuditorApp.tsx");
  const route = read("app/api/auth/sign-out/route.ts");
  assert.match(shell, /Open help/);
  assert.match(shell, /Edit my profile/);
  assert.match(shell, /Save profile/);
  assert.match(shell, /Position or job title/);
  assert.match(shell, /profile-sign-out/);
  assert.match(shell, /document\.addEventListener\("keydown"/);
  assert.match(app, /You are still signed in/);
  assert.match(route, /const \{ error \} = await supabase\.auth\.signOut\(\)/);
  assert.match(route, /sign_out_failed/);
});

test("individual email recipients require an explicit named location scope", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");
  assert.match(configuration, /Individual email recipients/);
  assert.match(configuration, /Addresses below receive email only and cannot sign in/);
  assert.match(configuration, /Choose at least one location for this recipient/);
  assert.match(configuration, /locationIds: recipientLocations/);
  assert.match(configuration, /\/api\/email\/recipients/);
  assert.match(configuration, /method: "DELETE"/);
});

test("manual email requires reviewed exact runs and a confirmation", () => {
  const dashboard = read("app/components/DashboardScreen.tsx");
  assert.match(dashboard, /Send the selected forecast now/);
  assert.match(dashboard, /Send this forecast now\?/);
  assert.match(dashboard, /periodStart: forecastBounds\.startDate/);
  assert.match(dashboard, /periodEnd: forecastBounds\.endDate/);
  assert.match(dashboard, /expectedRunIds: exactRunIds/);
  assert.match(dashboard, /selectedLocationIds\.every\(\(id\) => exactRunByLocation\.has\(id\)\)/);
  assert.match(dashboard, /Duplicate-send protection is on/);
  assert.match(dashboard, /role === "super_admin" \|\| appData\.currentUser\.role === "admin"/);
});
