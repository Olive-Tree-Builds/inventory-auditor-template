import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const workDirectory = join(process.cwd(), "work");
mkdirSync(workDirectory, { recursive: true });
const compiledDirectory = mkdtempSync(join(workDirectory, "api-boundary-tests-"));

for (const moduleName of ["http", "redirect"]) {
  const source = readFileSync(join("app/lib/api", `${moduleName}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: `${moduleName}.ts`,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  assert.deepEqual(errors, [], `${moduleName}.ts should transpile without diagnostics`);
  writeFileSync(
    join(compiledDirectory, `${moduleName}.js`),
    compiled.outputText.replace(
      'import { NextResponse } from "next/server";',
      'const NextResponse = { json: (value, init) => ({ value, init }) };',
    ),
  );
}

const http = await import(`${pathToFileURL(join(compiledDirectory, "http.js")).href}?run=${Date.now()}`);
const redirect = await import(`${pathToFileURL(join(compiledDirectory, "redirect.js")).href}?run=${Date.now()}`);

after(() => rmSync(compiledDirectory, { recursive: true, force: true }));

test("authentication redirects remain on the current origin", () => {
  assert.equal(redirect.safeSameOriginPath("/dashboard?tab=forecast#today"), "/dashboard?tab=forecast#today");
  for (const unsafe of [null, undefined, "", "https://evil.example", "//evil.example", "/\\evil.example"]) {
    assert.equal(redirect.safeSameOriginPath(unsafe), "/");
  }
});

test("JSON request bodies are bounded even without a trustworthy content length", async () => {
  const accepted = new Request("https://app.example/api", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  });
  assert.deepEqual(await http.readJson(accepted, 64), { ok: true });

  const declaredTooLarge = new Request("https://app.example/api", {
    method: "POST",
    headers: { "content-length": "65" },
    body: "{}",
  });
  await assert.rejects(http.readJson(declaredTooLarge, 64), {
    status: 413,
    code: "request_too_large",
  });

  const streamedTooLarge = new Request("https://app.example/api", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(128) }),
  });
  await assert.rejects(http.readJson(streamedTooLarge, 64), {
    status: 413,
    code: "request_too_large",
  });
});

test("malformed JSON and invalid UTF-8 are rejected without leaking parser details", async () => {
  const malformed = new Request("https://app.example/api", { method: "POST", body: "{" });
  await assert.rejects(http.readJson(malformed), { status: 400, code: "invalid_json" });

  const invalidUtf8 = new Request("https://app.example/api", {
    method: "POST",
    body: new Uint8Array([0xff]),
  });
  await assert.rejects(http.readJson(invalidUtf8), { status: 400, code: "invalid_json" });
});
