import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configuration = readFileSync("app/components/ConfigurationScreen.tsx", "utf8");
const setupStart = configuration.indexOf("function SetupTab");
const setupEnd = configuration.indexOf("function UsersTab");

assert.notEqual(setupStart, -1, "SetupTab should exist");
assert.notEqual(setupEnd, -1, "UsersTab should follow SetupTab");

const setup = configuration.slice(setupStart, setupEnd);

test("Start Here speaks plainly and explains the beginner journey", () => {
  assert.match(setup, /Beginner setup guide/);
  assert.match(setup, /You do not need to understand AI or write code/);
  assert.match(setup, /If you can sign in and see this page, Supabase and Railway are already working/);
  assert.match(setup, /<ol className="setup-welcome-flow"[^>]*>/);

  for (const phrase of [
    "Use organization-owned accounts",
    "Complete one card at a time",
    "Run a safe test",
  ]) {
    assert.ok(setup.includes(phrase), `missing beginner journey guidance: ${phrase}`);
  }

  assert.doesNotMatch(setup, /Start from zero/);
  assert.doesNotMatch(setup, /Responses-compatible model/i);
});

test("Start Here directs the reader to the next unfinished basic step and repository front page", () => {
  assert.match(setup, /const nextRequiredStep = requiredSteps\.find\(\(step\) => !step\.ready\)/);
  assert.match(setup, /const nextStep = nextRequiredStep \?\? orderedSteps\.find/);
  assert.match(setup, /href=\{`#setup-\$\{nextStep\.id\}`\}/);
  assert.match(setup, /nextRequiredStep \? `Start with step \$\{Number\(nextStep\.number\)\}` : "Review optional connections"/);

  assert.match(setup, /githubConnection[\s\S]*configuration\.repositoryOwner/);
  assert.match(setup, /configuration\.repositoryName/);
  assert.match(setup, /github\.com\/\$\{encodeURIComponent\(repositoryOwner\)\}\/\$\{encodeURIComponent\(repositoryName\)\}#setup/);
  assert.match(setup, /className="setup-full-guide-link"[\s\S]*target="_blank" rel="noreferrer"/);
  assert.match(setup, /Open Setup on the repository front page/);
  assert.match(setup, /Open your private GitHub repository[\s\S]*complete <strong>Setup<\/strong> guide is on its front page/);
  assert.doesNotMatch(setup, /docs\/GETTING_STARTED|MANUAL_ACCEPTANCE_TEST/);
});

test("each setup card gives actions, required values, and a clear success check", () => {
  assert.equal((setup.match(/\bdoneWhen:/g) ?? []).length, 6, "every setup step needs a completion check");
  assert.equal((setup.match(/\bpurpose:/g) ?? []).length, 6, "every setup step needs a plain-language purpose");
  assert.equal((setup.match(/\bvalues:/g) ?? []).length, 6, "every setup step needs a list of required values");

  assert.match(setup, /<ol className="setup-step-list"[^>]*>/);
  assert.match(setup, /<li className="setup-step-list-item"[^>]*>/);
  assert.match(setup, /Step \{Number\(step\.number\)\} of \{steps\.length\}/);
  assert.match(setup, /<h3>\{step\.title\}<\/h3>/);
  assert.match(setup, />Do this<\/h4>/);
  assert.match(setup, />Have this ready<\/strong>/);
  assert.match(setup, /You(?:&apos;|’)re done when/);
  assert.match(setup, /\{step\.doneWhen\}/);
  assert.match(setup, /step\.note/);
  assert.match(setup, /step\.openTab[\s\S]*onOpenTab\(step\.openTab/);
});

test("setup status and progress are truthful and accessible", () => {
  assert.match(setup, /const requiredStepIds = new Set\(\["supabase", "railway", "finish"\]\)/);
  assert.match(setup, /ready: appData\.brands\.some\(\(brand\) => brand\.locations\.length > 0\) && Boolean\(appData\.latestImport\)/);
  assert.match(setup, /const readyCount = requiredSteps\.filter/);
  assert.match(setup, /function stepStatus/);

  for (const label of ["Already working", "Connected", "Not finished", "Basic setup ready", "Optional — not connected"]) {
    assert.ok(setup.includes(`"${label}"`), `missing setup status: ${label}`);
  }

  assert.match(setup, /aria-label=\{`\$\{step\.name\}: \$\{stepStatus\(step\)\}`\}/);
  assert.match(setup, /role="progressbar"/);
  assert.match(setup, /aria-valuemin=\{0\}/);
  assert.match(setup, /aria-valuemax=\{requiredSteps\.length\}/);
  assert.match(setup, /aria-valuenow=\{readyCount\}/);
  assert.match(setup, /basic setup sections complete/);
});

test("preflight, cost, AI, testing, and help guidance keep a novice safe", () => {
  assert.match(setup, /Before you begin/);
  assert.match(setup, /Have these six things ready/);
  assert.match(setup, /organization(?:&apos;|’)s password manager/i);
  assert.match(setup, /Stop before any charge/);
  assert.match(setup, /above \$0, stop and get approval/);

  assert.match(setup, /GitHub is the private file cabinet[\s\S]*It is not the AI service/);
  assert.match(setup, /AI service follows the Analysis Skill/);
  assert.match(setup, /Do not choose a service or model by guessing/);
  assert.match(setup, /A normal AI website login is not enough/);
  assert.match(setup, /Secret API key — a password-like value/);
  assert.match(setup, /invented sales data/i);
  assert.match(setup, /internal test email/i);

  assert.match(setup, /If you get stuck/);
  assert.match(setup, /Contact the person or team that shared this repository/);
  assert.match(setup, /step number, screen name/i);
  assert.match(setup, /what you expected/i);
  assert.match(setup, /what happened/i);
  assert.match(setup, /Never send passwords, API keys, tokens, customer data/i);
});
