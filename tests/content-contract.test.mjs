import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("the UI contains the required product surfaces", () => {
  const config = read("app/components/ConfigurationScreen.tsx");
  const dashboard = read("app/components/DashboardScreen.tsx");
  const auth = read("app/components/AuthScreen.tsx");
  const page = read("app/page.tsx");

  assert.match(config, /useState<TabId>\("setup"\)/);
  for (const label of ["Start here", "Users", "Keys", "Historical Data", "Brands & Locations", "Analysis Skill", "Email Schedule"]) {
    assert.ok(config.includes(label), `missing configuration surface: ${label}`);
  }
  for (const period of ["day", "week", "month", "quarter", "year"]) {
    assert.ok(dashboard.includes(`"${period}"`), `missing dashboard period: ${period}`);
  }
  assert.match(dashboard, /Multivariate/i);
  assert.doesNotMatch(dashboard, /History combined with live weather, holidays, and nearby events/);
  assert.doesNotMatch(config, /\["Weather and precipitation", "Holidays"/);
  assert.doesNotMatch(page, /ANALYSIS_SKILL|readFile/);
  assert.match(auth, /first account becomes the super admin/i);
  assert.match(auth, /public registration closes/i);
});

test("email confirmation completes authorized first-owner setup", () => {
  const callback = read("app/auth/callback/route.ts");
  assert.match(callback, /exchangeCodeForSession/);
  assert.match(callback, /bootstrapWorkspace/);
  assert.match(callback, /ia_installation_state/);
  assert.match(callback, /owner_setup_incomplete/);
});

test("Analysis Skill viewing is read-only and activation is explicit", () => {
  const route = read("app/api/analysis-skill/route.ts");
  const getHandler = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PUT"));
  const putHandler = route.slice(route.indexOf("export async function PUT"));
  const configuration = read("app/components/ConfigurationScreen.tsx");
  const forecastRoute = read("app/api/forecasts/run/route.ts");
  assert.doesNotMatch(getHandler, /activateAnalysisPolicy/);
  assert.match(putHandler, /activateAnalysisPolicy/);
  assert.match(configuration, /Review and activate/);
  assert.match(configuration, /result\.isActive/);
  assert.doesNotMatch(forecastRoute, /policyActivationActorUserId/);
});

test("the setup-required UI shows only the services needed before sign-in", () => {
  const setup = read("app/components/SetupRequiredScreen.tsx");
  const serviceList = setup.slice(setup.indexOf("const services = ["), setup.indexOf("] as const;"));
  assert.equal((serviceList.match(/\bid: /g) ?? []).length, 2);
  assert.match(serviceList, /id: "supabase"/);
  assert.match(serviceList, /id: "railway"/);
  assert.doesNotMatch(serviceList, /id: "(?:resend|ai|github)"/);
  assert.match(setup, /Set up Supabase and Railway first/);
  assert.match(setup, /Resend, AI,[\s\S]*GitHub are added later inside the app/);
  assert.match(setup, /Another[\s\S]*organization does not add Free-project quota/);
  assert.doesNotMatch(setup, /use a separate eligible\s+Free organization/);
});

test("baseline browser security headers are configured", () => {
  const config = read("next.config.ts");
  for (const header of ["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) {
    assert.ok(config.includes(header), `missing security header: ${header}`);
  }
  assert.match(config, /poweredByHeader:\s*false/);
});

test("the downloadable workbook is present", () => {
  const path = "public/inventory-history-template.xlsx";
  assert.ok(existsSync(path));
  assert.ok(statSync(path).size > 5_000, "workbook should contain a real formatted Excel file");
});

test("the runtime analysis policy keeps its safety contract", () => {
  const policy = read("ANALYSIS_SKILL.md");
  for (const marker of [
    "Read this entire file",
    "live web research",
    "ACTIVE_VARIABLES_START",
    "ACTIVE_VARIABLES_END",
    '"variable_id"',
    "prompt injection",
    "baseline_only",
    '"assessments"',
    '"adjustment_percent"',
    '"sources"',
  ]) {
    assert.ok(policy.toLowerCase().includes(marker.toLowerCase()), `missing analysis policy marker: ${marker}`);
  }
});

test("the handoff environment file contains names, not credentials", () => {
  const env = read(".env.example");
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "OWNER_SETUP_SECRET",
    "RESEND_API_KEY",
    "AI_API_KEY",
    "GITHUB_FINE_GRAINED_TOKEN",
  ]) {
    assert.match(env, new RegExp(`^${name}=$`, "m"));
  }
  assert.doesNotMatch(env, /(?:sb_secret_|re_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{12,})/);
  assert.match(env, /^GITHUB_BRANCH=trunk$/m);
});

test("the repository front page is the single browser-only owner setup guide", () => {
  const guide = read("README.md");
  for (const instruction of [
    "This is the complete owner setup guide",
    "Use this template → Create a new repository",
    "Select **Private**",
    "Run these five files once, in this order",
    "+ New Environment → Empty Environment",
    "name it `staging`",
    "Generate safe values",
    "Connect Supabase sign-in",
    "Create the first owner",
    "Add a brand and historical data",
    "Add multivariate forecasting",
    "Add invitations and email",
    "Turn on automatic email",
    "If you get stuck",
  ]) {
    assert.ok(guide.includes(instruction), `missing handoff instruction: ${instruction}`);
  }
  assert.doesNotMatch(guide, /gh auth login|gh repo clone|git remote|git branch|pnpm dev|localhost:3000/);
  assert.doesNotMatch(guide, /docs\/GETTING_STARTED|MANUAL_ACCEPTANCE_TEST|technical setup reference/i);
  assert.equal((guide.match(/<details>/g) ?? []).length, 4, "optional features and the AI prompt should stay collapsed on the front page");
  assert.match(guide, /The basic app is ready when/);
  assert.match(guide, /If you enabled forecasting/);
  assert.match(guide, /If you enabled email/);
  assert.ok(guide.indexOf("Save schedule") < guide.indexOf("Send test to me"), "email schedule must be saved before its internal test");
  for (const name of [
    "APP_URL",
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SECRET_KEY",
    "APP_SECRET_ENCRYPTION_KEY",
    "CRON_SECRET",
    "OWNER_SETUP_SECRET",
  ]) {
    assert.ok(guide.includes(name), `missing Railway setup value: ${name}`);
  }

  const oldGuide = read("docs/GETTING_STARTED.md");
  assert.match(oldGuide, /guide is now in[\s\S]*repository front page/i);
  assert.ok(oldGuide.length < 700, "old guide should be only a short compatibility notice");
});

test("the front page includes a complete guarded AI setup prompt for beginners", () => {
  const guide = read("README.md");

  for (const instruction of [
    "Choose how you want to set it up",
    "Set it up yourself",
    "Have an AI agent guide and operate the setup",
    "AI-guided setup",
    "What happens first",
    "Test the repository before creating provider accounts",
    "What Codex can reuse",
    "What you need to do during setup",
    "What happens after that",
    "Copy the complete AI setup prompt",
  ]) {
    assert.ok(guide.includes(instruction), `missing AI setup instruction: ${instruction}`);
  }

  assert.match(guide, /\[Setup\]\(#setup\)/);
  assert.match(guide, /\[AI-guided setup\]\(#ai-guided-setup\)/);

  const promptStart = guide.indexOf("```text\nYou are my Inventory Auditor setup operator");
  const promptEnd = guide.indexOf("\n```", promptStart + 7);
  assert.ok(promptStart >= 0 && promptEnd > promptStart, "AI setup prompt must be one copyable text block");
  const prompt = guide.slice(promptStart, promptEnd);

  for (const safeguard of [
    "Assume I know nothing",
    "SOURCE OF TRUTH",
    "HOW TO WORK WITH ME",
    "NON-NEGOTIABLE SAFETY RULES",
    "Do not create a paid plan",
    "inventory the authorized connectors",
    "temporary setup access",
    "Do not treat my ChatGPT or Codex subscription as OpenAI API access",
    "pnpm verify:handoff",
    "receiving my explicit approval",
    "Never ask me to send you a password",
    "Before any password, token, API key, generated security value",
    "Railway staging is the only authorized deployment",
    "Leave Railway's default production environment empty",
    "EMAIL_DELIVERY_ENABLED=false",
    "Do not send email to a real manager",
    "every location assigned to the signed-in owner",
    "Observe at least two checks and verify exactly one email",
    "Leave all three controls off unless I separately and explicitly approve",
    "11-phase checklist",
    "DEFINITION OF DONE",
  ]) {
    assert.ok(prompt.includes(safeguard), `missing AI setup safeguard: ${safeguard}`);
  }

  for (const service of ["GitHub", "Supabase", "Railway", "Resend", "ANALYSIS_SKILL.md", "Supabase Cron"]) {
    assert.ok(prompt.includes(service), `AI prompt omits required service: ${service}`);
  }

  for (let phase = 0; phase <= 10; phase += 1) {
    assert.ok(prompt.includes(`PHASE ${phase}`), `AI prompt omits phase ${phase}`);
  }

  assert.ok(prompt.indexOf("PHASE 0") < prompt.indexOf("PHASE 10"), "AI setup phases must remain ordered");
  assert.match(prompt, /one short question or give one short instruction at a time/i);
  assert.match(prompt, /where to click, what I should see, what I must enter, why it is needed/i);
  assert.doesNotMatch(prompt, /Map the other discovered label to a second completed test location/);
});

test("the account-free handoff command verifies code without claiming live providers", () => {
  const guide = read("README.md");
  const packageJson = JSON.parse(read("package.json"));

  assert.equal(
    packageJson.scripts["verify:handoff"],
    "node --test tests/*.test.mjs && eslint . --ignore-pattern .next && tsc --noEmit && next build",
  );
  assert.match(guide, /without creating Supabase, Railway, Resend, or AI-provider accounts/i);
  assert.match(guide, /account-free code readiness/i);
  assert.match(guide, /cannot prove[\s\S]*DNS[\s\S]*live database[\s\S]*AI model/i);
  assert.match(guide, /A ChatGPT or Codex subscription is not an AI API key/i);
  assert.match(guide, /do not become credentials for the deployed application/i);
});

test("the setup-required page creates Railway security values only in the browser", () => {
  const setup = read("app/components/SetupRequiredScreen.tsx");
  const styles = read("app/globals.css");

  assert.match(setup, /globalThis\.crypto\.getRandomValues/);
  assert.match(setup, /Nothing is uploaded or saved by the app/);
  assert.match(setup, /navigator\.clipboard\.writeText/);
  for (const name of ["APP_SECRET_ENCRYPTION_KEY", "CRON_SECRET", "OWNER_SETUP_SECRET"]) {
    assert.ok(setup.includes(name), `missing generated setup value: ${name}`);
  }
  assert.doesNotMatch(setup, /fetch\(/);
  assert.match(styles, /\.setup-secret-generator\s*\{/);
  assert.match(styles, /\.setup-secret-value\s*\{/);
});

test("the maintainer skill distinguishes agent and runtime instructions", () => {
  const skill = read("skills/inventory-auditor-maintainer/SKILL.md");
  assert.match(skill, /^---\nname: inventory-auditor-maintainer\n/m);
  assert.match(skill, /Distinguish the two instruction files/);
  assert.match(skill, /ACTIVE_VARIABLES_START/);
});
