import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");

test("sign-in does not present an unwired remember-me control", () => {
  const auth = read("app/components/AuthScreen.tsx");
  assert.doesNotMatch(auth, /Remember me/);
  assert.match(auth, /Use Sign out when you finish on a shared device/);
});

test("invitation and password-reset actions recover after request failures", () => {
  const invitation = read("app/invite/page.tsx");
  const reset = read("app/reset-password/page.tsx");
  assert.match(invitation, /The invitation could not be checked\. Confirm your connection/);
  assert.match(invitation, /finally \{\s*setSubmitting\(false\);/);
  assert.match(reset, /try \{[\s\S]*updateUser\(\{ password \}\)[\s\S]*catch \{[\s\S]*finally \{\s*setSubmitting\(false\);/);
});

test("configuration controls expose only actions the server can accept", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");
  assert.match(configuration, /location\.active && location\.brandActive/);
  assert.match(configuration, /const canManage = \(person: AppUser\).*currentUser\.role === "super_admin"/);
  assert.match(configuration, /canManage\(person\) \? <button/);
  assert.doesNotMatch(configuration, /> Test connections</);
  assert.match(configuration, /> Open connection tests</);
  assert.match(configuration, /onDragOver=/);
  assert.match(configuration, /onDrop=/);
  assert.match(configuration, /selectFile\(event\.dataTransfer\.files\?\.\[0\]/);
  assert.match(configuration, /brand\.active \? <button[^\n]*Add location/);
});

test("Analysis Skill reload preserves a dirty local draft", () => {
  const configuration = read("app/components/ConfigurationScreen.tsx");
  assert.match(configuration, /const draftRef = useRef\(analysisSkillDraft\)/);
  assert.match(configuration, /const activeRef = useRef\(activeAnalysisSkill\)/);
  assert.match(configuration, /const hasDirtyDraft = draftRef\.current !== activeRef\.current/);
  assert.match(configuration, /if \(!hasDirtyDraft\) onAnalysisSkillDraftChange\(result\.markdown\)/);
});
