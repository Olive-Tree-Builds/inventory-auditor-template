import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACTIVE_VARIABLES_END,
  ACTIVE_VARIABLES_START,
  addAnalysisVariable,
  parseAnalysisSkill,
  prepareAnalysisSkillActivation,
  removeAnalysisVariable,
} from "../app/lib/analysis-skill.mjs";

const rootPolicy = readFileSync("ANALYSIS_SKILL.md", "utf8");

test("the repository policy is the valid source of active variables", () => {
  const result = parseAnalysisSkill(rootPolicy);
  assert.deepEqual(result.errors, []);
  assert.equal(result.policyVersion, "3.0.0");
  assert.equal(result.activeVariableRevision, "3");
  assert.doesNotMatch(rootPolicy, /"baseline_quantity"/);
  assert.match(rootPolicy, /"product_id": "string"/);
  assert.match(rootPolicy, /Output schema version: `3\.0`/);
  assert.match(rootPolicy, /Rough estimate guidance/);
  assert.deepEqual(
    result.variables.map(({ id }) => id),
    ["weather", "holidays", "nearby-events", "school-schedules", "local-disruptions"],
  );
});

test("adding and removing a variable changes the parsed list without a fallback", () => {
  const added = addAnalysisVariable(rootPolicy, "University move-in");
  assert.equal(added.error, null);
  assert.ok(parseAnalysisSkill(added.markdown).variables.some(({ id }) => id === "university-move-in"));

  const removed = removeAnalysisVariable(added.markdown, "weather");
  assert.equal(removed.error, null);
  const ids = parseAnalysisSkill(removed.markdown).variables.map(({ id }) => id);
  assert.ok(!ids.includes("weather"));
  assert.ok(ids.includes("university-move-in"));
});

test("an empty active block is valid historical-baseline-only configuration", () => {
  const start = rootPolicy.indexOf(ACTIVE_VARIABLES_START) + ACTIVE_VARIABLES_START.length;
  const end = rootPolicy.indexOf(ACTIVE_VARIABLES_END);
  const empty = `${rootPolicy.slice(0, start)}\n${rootPolicy.slice(end)}`;
  const result = parseAnalysisSkill(empty);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.variables, []);
});

test("malformed markers, duplicate IDs, and incomplete rules block activation", () => {
  const missingMarker = rootPolicy.replace(ACTIVE_VARIABLES_END, "");
  assert.match(parseAnalysisSkill(missingMarker).errors.join(" "), /exactly one/i);

  const duplicateId = rootPolicy.replace("`holidays`", "`weather`");
  assert.match(parseAnalysisSkill(duplicateId).errors.join(" "), /duplicated/i);

  const incomplete = rootPolicy.replace(/  - Fallback: Use zero adjustment and lower confidence when applicability or historical effect is unclear\.\n/, "");
  assert.match(parseAnalysisSkill(incomplete).errors.join(" "), /Fallback/);

  const missingRoughGuidance = rootPolicy.replace(/  - Rough estimate guidance: When current weather[^\n]+\n/, "");
  assert.match(parseAnalysisSkill(missingRoughGuidance).errors.join(" "), /Rough estimate guidance/);
});

test("the parser handles CRLF and ignores Name fields outside the active block", () => {
  const withOutsideName = `- Name: \`Ignore me\`\n${rootPolicy}`.replace(/\n/g, "\r\n");
  const result = parseAnalysisSkill(withOutsideName);
  assert.deepEqual(result.errors, []);
  assert.ok(!result.variables.some(({ name }) => name === "Ignore me"));
});

test("activation advances auditable metadata after variable changes", () => {
  const added = addAnalysisVariable(rootPolicy, "University move-in");
  const prepared = prepareAnalysisSkillActivation(added.markdown, rootPolicy, "2026-07-17");
  assert.equal(prepared.error, null);
  const result = parseAnalysisSkill(prepared.markdown);
  assert.equal(result.policyVersion, "3.0.1");
  assert.equal(result.activeVariableRevision, "4");
  assert.match(prepared.markdown, /- Last updated: `2026-07-17`/);
});

test("the valid repository policy can be explicitly activated on an empty installation", () => {
  const prepared = prepareAnalysisSkillActivation(rootPolicy, "");
  assert.equal(prepared.error, null);
  assert.equal(prepared.markdown, rootPolicy);
});
