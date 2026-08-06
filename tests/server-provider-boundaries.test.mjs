import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const sourceDirectory = "app/lib/server";
const workDirectory = join(process.cwd(), "work");
mkdirSync(workDirectory, { recursive: true });
const compiledDirectory = mkdtempSync(join(workDirectory, "server-provider-tests-"));
const moduleNames = [
  "analysis-policy",
  "ai-provider-config",
  "ai-forecast-provider",
  "credential-resolver",
  "email-delivery",
  "env",
  "forecast-claims",
  "forecast-failure",
  "forecast-evidence",
  "forecast-output",
  "forecast-provider",
  "forecast-research",
  "github-analysis-skill",
  "integration-connections",
  "native-forecast-providers",
  "openai-responses-forecast",
  "owner-setup",
  "resend-email",
  "secret-crypto",
  "supabase-credential-store",
  "supabase-email-delivery",
  "time-zone",
  "index",
];

for (const moduleName of moduleNames) {
  const source = readFileSync(join(sourceDirectory, `${moduleName}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    fileName: `${moduleName}.ts`,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
    reportDiagnostics: true,
  });
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors, [], `${moduleName}.ts should transpile without diagnostics`);
  const nodeCompatibleOutput = compiled.outputText.replace(
    /((?:from|import)\s+["'])(\.[^"']+)(["'])/g,
    (_match, prefix, specifier, suffix) => (
      /\.(?:m?js|json)$/.test(specifier)
        ? `${prefix}${specifier}${suffix}`
        : `${prefix}${specifier}.js${suffix}`
    ),
  ).replace('"../analysis-skill.mjs"', '"./analysis-skill.mjs"');
  writeFileSync(join(compiledDirectory, `${moduleName}.js`), nodeCompatibleOutput);
}
writeFileSync(join(compiledDirectory, "analysis-skill.mjs"), readFileSync("app/lib/analysis-skill.mjs", "utf8"));

const server = await import(`${pathToFileURL(join(compiledDirectory, "index.js")).href}?run=${Date.now()}`);
const rootPolicy = readFileSync("ANALYSIS_SKILL.md", "utf8");
const exactForecastScope = {
  workspaceId: "workspace-1",
  brandId: "brand-1",
  brandName: "Test Brand",
  locationIds: ["location-1"],
  timeZone: "America/Toronto",
  locations: [{
    id: "location-1",
    name: "Queen Street",
    brandId: "brand-1",
    brandName: "Test Brand",
    timeZone: "America/Toronto",
    streetAddress: "100 Queen Street West",
    city: "Toronto",
    region: "Ontario",
    postalCode: "M5H 2N2",
    countryCode: "CA",
    researchArea: "100 Queen Street West, Toronto, Ontario, M5H 2N2, CA",
  }],
};

const forecastTestBaseline = {
  locationId: "location-1",
  productId: "product-1",
  product: "Croissant",
  quantity: 100,
  method: "same weekday",
  sampleSize: 8,
  confidence: "high",
};

function forecastTestEvidence() {
  return server.buildForecastEvidence({
    historicalRows: [{ date: "2026-07-10", locationId: "location-1", productId: "product-1", product: "Croissant", quantity: 100 }],
    baselines: [forecastTestBaseline],
    locations: ["location-1"],
    products: [{ id: "product-1", name: "Croissant" }],
    grouping: "day",
    forecastStartDate: "2026-07-17",
    forecastEndDate: "2026-07-17",
    historyStartDate: "2026-01-01",
    historyEndDate: "2026-07-16",
  });
}

after(() => rmSync(compiledDirectory, { recursive: true, force: true }));

test("AES-256-GCM secrets are context-bound and expose only a short mask", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  const context = "inventory-auditor:workspace-1:resend:apiKey";
  const encrypted = server.encryptSecret("re_test_1234567890", key, context);
  assert.equal(server.decryptSecret(encrypted, key, context), "re_test_1234567890");
  assert.equal(server.maskSecret("re_test_1234567890"), "•••• 7890");
  assert.equal(server.createWriteOnlySecretRecord("re_test_1234567890", key, context).encryptionVersion, 1);
  assert.throws(() => server.decryptSecret(encrypted, key, `${context}:wrong`), { code: "decrypt_failed" });

  const parts = encrypted.split(".");
  parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
  assert.throws(() => server.decryptSecret(parts.join("."), key, context), { code: "decrypt_failed" });
  assert.throws(() => server.encryptSecret("secret", "not-a-key", context), { code: "invalid_key" });
});

test("environment status never returns secret values and requires all live providers", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const environment = {
    APP_URL: "http://localhost:3000",
    APP_SECRET_ENCRYPTION_KEY: key,
    CRON_SECRET: "c".repeat(40),
    OWNER_SETUP_SECRET: "o".repeat(40),
    DEFAULT_TIME_ZONE: "America/Toronto",
    DEFAULT_EMAIL_HOUR: "5",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_example",
    SUPABASE_SECRET_KEY: "sb_secret_private_example",
    RESEND_API_KEY: "re_private_example",
    RESEND_FROM_EMAIL: "forecasts@example.com",
    AI_PROVIDER: "responses-compatible",
    AI_MODEL: "web-model",
    AI_BASE_URL: "https://api.example.com/v1",
    AI_API_KEY: "ai_private_example",
    AI_WEB_RESEARCH_REQUIRED: "true",
    GITHUB_OWNER: "Olive-Tree-Builds",
    GITHUB_REPOSITORY: "inventory-auditor",
    GITHUB_BRANCH: "trunk",
    GITHUB_FINE_GRAINED_TOKEN: "github_private_example",
  };
  const status = server.inspectEnvironment(environment);
  assert.equal(status.readyForLiveOperations, true);
  const serializedStatus = JSON.stringify(status);
  for (const secret of [key, environment.SUPABASE_SECRET_KEY, environment.RESEND_API_KEY, environment.AI_API_KEY, environment.GITHUB_FINE_GRAINED_TOKEN]) {
    assert.ok(!serializedStatus.includes(secret));
  }
  assert.equal(server.requireServerEnvironment(environment).github.branch, "trunk");
  assert.equal(server.inspectEnvironment({ ...environment, GITHUB_BRANCH: "main" }).github.status, "incomplete");
});

test("safe provider summaries include valid Railway environment fallbacks without secrets", () => {
  const environment = {
    RESEND_API_KEY: "resend-environment-secret",
    RESEND_FROM_EMAIL: "forecasts@example.com",
    AI_API_KEY: "ai-environment-secret",
    AI_PROVIDER: "responses-compatible",
    AI_MODEL: "web-model",
    AI_BASE_URL: "https://api.example.com/v1",
    GITHUB_FINE_GRAINED_TOKEN: "github-environment-secret",
    GITHUB_OWNER: "Olive-Tree-Builds",
    GITHUB_REPOSITORY: "inventory-auditor",
    GITHUB_BRANCH: "trunk",
  };
  const summaries = server.summarizeProviderConnections([], environment);
  assert.deepEqual(summaries.map((summary) => summary.provider), ["resend", "ai", "github"]);
  assert.ok(summaries.every((summary) => summary.configured));
  assert.ok(summaries.every((summary) => summary.credentialSource === "environment"));
  assert.ok(summaries.every((summary) => summary.status === "untested"));
  const serialized = JSON.stringify(summaries);
  for (const secret of [environment.RESEND_API_KEY, environment.AI_API_KEY, environment.GITHUB_FINE_GRAINED_TOKEN]) {
    assert.ok(!serialized.includes(secret));
  }
});

test("first-owner setup codes are long, timing-safe secrets and timezones are validated", () => {
  const configured = "owner-setup-".padEnd(48, "x");
  assert.equal(server.verifyOwnerSetupSecret(configured, configured), true);
  assert.equal(server.verifyOwnerSetupSecret(`${configured}wrong`, configured), false);
  assert.equal(server.verifyOwnerSetupSecret("short", configured), false);
  assert.equal(server.isValidIanaTimeZone("America/Toronto"), true);
  assert.equal(server.isValidIanaTimeZone("Toronto/Not-A-Timezone"), false);
});

test("stored provider credentials take precedence and corrupt records never silently fall back", async () => {
  const key = Buffer.alloc(32, 5).toString("base64");
  const context = server.credentialEncryptionContext("workspace-1", "ai", "apiKey");
  const encryptedValue = server.encryptSecret("stored-ai-secret", key, context);
  const stored = await server.resolveProviderCredential({
    workspaceId: "workspace-1",
    provider: "ai",
    name: "apiKey",
    encryptionKey: key,
    environment: { AI_API_KEY: "environment-ai-secret" },
    store: { readCredential: async () => ({ encryptedValue }) },
  });
  assert.deepEqual(stored, { value: "stored-ai-secret", source: "stored" });

  const fallback = await server.resolveProviderCredential({
    workspaceId: "workspace-1",
    provider: "resend",
    name: "apiKey",
    encryptionKey: key,
    environment: { RESEND_API_KEY: "environment-resend-secret" },
    store: { readCredential: async () => null },
  });
  assert.deepEqual(fallback, { value: "environment-resend-secret", source: "environment" });

  await assert.rejects(
    server.resolveProviderCredential({
      workspaceId: "workspace-1",
      provider: "ai",
      name: "apiKey",
      encryptionKey: key,
      environment: { AI_API_KEY: "must-not-fallback" },
      store: { readCredential: async () => ({ encryptedValue: "broken" }) },
    }),
    { code: "stored_credential_unreadable" },
  );
});

test("GitHub Analysis Skill updates use blob-SHA compare-and-swap and verify the saved file", async () => {
  const oldSha = "a".repeat(40);
  const newSha = "b".repeat(40);
  const commitSha = "c".repeat(40);
  const updatedPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `3.0.1`");
  const calls = [];
  let getCount = 0;
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if ((init?.method ?? "GET") === "GET") {
      getCount += 1;
      const content = getCount === 1 ? rootPolicy : updatedPolicy;
      const sha = getCount === 1 ? oldSha : newSha;
      return Response.json({ type: "file", encoding: "base64", content: Buffer.from(content).toString("base64"), sha, html_url: "https://github.example/file" });
    }
    return Response.json({ content: { sha: newSha }, commit: { sha: commitSha } });
  };
  const client = new server.GitHubAnalysisSkillClient({
    owner: "Olive-Tree-Builds",
    repository: "inventory-auditor",
    branch: "trunk",
    token: "github-secret-token",
    fetch: fetcher,
  });
  const result = await client.update({ expectedSha: oldSha, markdown: updatedPolicy, commitMessage: "Update forecast variables" });
  assert.equal(result.document.sha, newSha);
  assert.equal(result.commitSha, commitSha);
  assert.equal(calls.length, 3);
  const put = calls[1];
  const putBody = JSON.parse(put.init.body);
  assert.equal(putBody.sha, oldSha);
  assert.equal(putBody.branch, "trunk");
  assert.equal(Buffer.from(putBody.content, "base64").toString("utf8"), updatedPolicy);
  assert.match(String(put.init.headers.Authorization), /^Bearer /);
  assert.deepEqual(server.validateAnalysisSkillForGitHub(updatedPolicy), []);
});

test("GitHub Analysis Skill updates reject a stale base SHA before writing", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    return Response.json({
      type: "file",
      encoding: "base64",
      content: Buffer.from(rootPolicy).toString("base64"),
      sha: "b".repeat(40),
    });
  };
  const client = new server.GitHubAnalysisSkillClient({
    owner: "Olive-Tree-Builds",
    repository: "inventory-auditor",
    branch: "trunk",
    token: "github-secret-token",
    fetch: fetcher,
  });
  await assert.rejects(
    client.update({ expectedSha: "a".repeat(40), markdown: rootPolicy, commitMessage: "Stale update" }),
    { code: "conflict" },
  );
  assert.equal(calls.length, 1);
});

function analysisPolicyRecord(markdown, id, repositoryBlobSha) {
  const policy = server.verifyAnalysisPolicy(markdown);
  return {
    id,
    policy_id: policy.policyId,
    policy_version: policy.policyVersion,
    output_schema_version: policy.outputSchemaVersion,
    active_variable_revision: policy.activeVariableRevision,
    markdown_content: policy.markdown,
    active_variables: policy.activeVariables,
    sha256: policy.sha256,
    repository_blob_sha: repositoryBlobSha,
  };
}

function fakeAnalysisPolicyAdmin(initialRecord, { activateState = true } = {}) {
  let activeRevisionId = initialRecord?.id ?? null;
  const records = new Map(initialRecord ? [[initialRecord.id, initialRecord]] : []);
  const rpcCalls = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = new Map();
    }
    select() { return this; }
    eq(column, value) { this.filters.set(column, value); return this; }
    async maybeSingle() {
      if (this.table === "ia_workspace_analysis_state") {
        return { data: activeRevisionId ? { active_policy_revision_id: activeRevisionId } : null, error: null };
      }
      if (this.table === "ia_analysis_policy_revisions") {
        return { data: records.get(this.filters.get("id")) ?? null, error: null };
      }
      throw new Error(`unexpected table ${this.table}`);
    }
  }

  const admin = {
    from(table) { return new Query(table); },
    async rpc(name, params) {
      rpcCalls.push([name, params]);
      assert.equal(name, "ia_server_activate_analysis_policy");
      const id = "33333333-3333-4333-8333-333333333333";
      records.set(id, {
        id,
        policy_id: params.p_policy_id,
        policy_version: params.p_policy_version,
        output_schema_version: params.p_output_schema_version,
        active_variable_revision: params.p_active_variable_revision,
        markdown_content: params.p_markdown_content,
        active_variables: params.p_active_variables,
        sha256: params.p_sha256,
        repository_blob_sha: params.p_repository_blob_sha,
      });
      if (activateState) activeRevisionId = id;
      return { data: id, error: null };
    },
  };
  return { admin, rpcCalls };
}

test("forecast policy reconciliation reads GitHub on every run and reuses only an exact audited revision", async () => {
  const blobSha = "a".repeat(40);
  const existing = analysisPolicyRecord(rootPolicy, "11111111-1111-4111-8111-111111111111", blobSha);
  const { admin, rpcCalls } = fakeAnalysisPolicyAdmin(existing);
  let reads = 0;
  const result = await server.reconcileAnalysisPolicy({
    admin,
    workspaceId: "workspace-1",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    repositoryPolicyLoader: async () => {
      reads += 1;
      return { content: rootPolicy, sha: blobSha, htmlUrl: null };
    },
  });
  assert.equal(result.id, existing.id);
  assert.equal(reads, 1);
  assert.equal(rpcCalls.length, 0);
});

test("forecast policy reconciliation fails closed on a repository mismatch without an administrator actor", async () => {
  const oldPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `2.9.0`");
  const existing = analysisPolicyRecord(oldPolicy, "11111111-1111-4111-8111-111111111111", "b".repeat(40));
  const { admin, rpcCalls } = fakeAnalysisPolicyAdmin(existing);
  await assert.rejects(
    server.reconcileAnalysisPolicy({
      admin,
      workspaceId: "workspace-1",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      repositoryPolicyLoader: async () => ({ content: rootPolicy, sha: "a".repeat(40), htmlUrl: null }),
    }),
    { code: "policy_unavailable" },
  );
  assert.equal(rpcCalls.length, 0);
});

test("forecast policy reconciliation activates and read-verifies the repository revision with an explicit admin actor", async () => {
  const oldPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `2.9.0`");
  const existing = analysisPolicyRecord(oldPolicy, "11111111-1111-4111-8111-111111111111", "b".repeat(40));
  const { admin, rpcCalls } = fakeAnalysisPolicyAdmin(existing);
  let reads = 0;
  const result = await server.reconcileAnalysisPolicy({
    admin,
    workspaceId: "workspace-1",
    encryptionKey: Buffer.alloc(32, 1).toString("base64"),
    actorUserId: "22222222-2222-4222-8222-222222222222",
    repositoryPolicyLoader: async () => {
      reads += 1;
      return { content: rootPolicy, sha: "a".repeat(40), htmlUrl: null };
    },
  });
  assert.equal(result.sha256, server.verifyAnalysisPolicy(rootPolicy).sha256);
  assert.equal(reads, 2);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0][1].p_actor_user_id, "22222222-2222-4222-8222-222222222222");
  assert.equal(rpcCalls[0][1].p_repository_blob_sha, "a".repeat(40));
});

test("forecast policy reconciliation never uses a document that changes during activation", async () => {
  const oldPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `2.9.0`");
  const changedPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `3.0.1`");
  const existing = analysisPolicyRecord(oldPolicy, "11111111-1111-4111-8111-111111111111", "b".repeat(40));
  const { admin } = fakeAnalysisPolicyAdmin(existing);
  let reads = 0;
  await assert.rejects(
    server.reconcileAnalysisPolicy({
      admin,
      workspaceId: "workspace-1",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      actorUserId: "22222222-2222-4222-8222-222222222222",
      repositoryPolicyLoader: async () => {
        reads += 1;
        return reads === 1
          ? { content: rootPolicy, sha: "a".repeat(40), htmlUrl: null }
          : { content: changedPolicy, sha: "c".repeat(40), htmlUrl: null };
      },
    }),
    { code: "policy_unavailable" },
  );
  assert.equal(reads, 2);
});

test("forecast policy reconciliation rejects an activation that lost the database active-state race", async () => {
  const oldPolicy = rootPolicy.replace("- Policy version: `3.0.0`", "- Policy version: `2.9.0`");
  const existing = analysisPolicyRecord(oldPolicy, "11111111-1111-4111-8111-111111111111", "b".repeat(40));
  const { admin } = fakeAnalysisPolicyAdmin(existing, { activateState: false });
  await assert.rejects(
    server.reconcileAnalysisPolicy({
      admin,
      workspaceId: "workspace-1",
      encryptionKey: Buffer.alloc(32, 1).toString("base64"),
      actorUserId: "22222222-2222-4222-8222-222222222222",
      repositoryPolicyLoader: async () => ({ content: rootPolicy, sha: "a".repeat(40), htmlUrl: null }),
    }),
    { code: "policy_unavailable" },
  );
});

test("forecast claims bind policy, scope, source, and actor through service-only RPCs", async () => {
  const calls = [];
  const claimToken = "33333333-3333-4333-8333-333333333333";
  const admin = {
    async rpc(name, params) {
      calls.push([name, params]);
      return { data: name === "ia_server_claim_scheduled_forecast" ? claimToken : null, error: null };
    },
  };
  const scope = {
    admin,
    workspaceId: "workspace-1",
    locationId: "location-1",
    period: { startDate: "2026-07-17", endDate: "2026-07-17" },
    policyRevisionId: "11111111-1111-4111-8111-111111111111",
    runSource: "manual",
    actorUserId: "22222222-2222-4222-8222-222222222222",
  };
  assert.equal(await server.claimForecastGeneration(scope), claimToken);
  await server.failForecastGeneration({ ...scope, claimToken });
  assert.equal(calls[0][0], "ia_server_claim_scheduled_forecast");
  assert.equal(calls[0][1].p_policy_revision_id, scope.policyRevisionId);
  assert.equal(calls[0][1].p_run_source, "manual");
  assert.equal(calls[0][1].p_actor_user_id, scope.actorUserId);
  assert.equal(calls[1][0], "ia_server_finish_scheduled_forecast");
  assert.equal(calls[1][1].p_claim_token, claimToken);
  assert.equal(calls[1][1].p_outcome, "failed");
  assert.equal(calls[1][1].p_failure_code, "forecast_generation_failed");

  await assert.rejects(
    server.claimForecastGeneration({ ...scope, runSource: "scheduled" }),
    { code: "forecast_claim_failed" },
  );
  assert.equal(calls.length, 2);
});

test("forecast runner rechecks repository policy and skips an existing claim before AI work", () => {
  const runner = readFileSync("app/lib/server/forecast-runner.ts", "utf8");
  assert.ok((runner.match(/reconcileAnalysisPolicy\(/g) ?? []).length >= 2);
  assert.match(runner, /if \(!claimToken\) continue;/);
  assert.match(runner, /p_claim_token: input\.claimToken/);
  assert.match(runner, /currentPolicy\.id !== policy\.id/);
  assert.match(runner, /const currentPolicy[\s\S]*const receipt = await storeResult/);
  assert.match(runner, /actor_user_id: input\.runSource === "scheduled" \? null : input\.actorUserId/);
  assert.doesNotMatch(runner, /outcome: "complete"/);
});

test("Resend sends one recipient with a durable Idempotency-Key", async () => {
  let captured;
  const client = new server.ResendEmailClient({
    apiKey: "resend-secret",
    from: "Inventory Auditor <forecasts@example.com>",
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ id: "email-123" });
    },
  });
  const idempotencyKey = server.buildEmailIdempotencyKey({
    workspaceId: "workspace-1",
    recipientUserId: "user-1",
    scheduleId: "schedule-1",
    forecastStartDate: "2026-07-17",
    forecastEndDate: "2026-07-17",
  });
  const receipt = await client.send({
    recipient: "manager@example.com",
    subject: "Production plan",
    html: "<p>Plan</p>",
    idempotencyKey,
  });
  assert.deepEqual(receipt, { id: "email-123" });
  assert.ok(!idempotencyKey.includes("manager@example.com"));
  assert.equal(captured.init.headers["Idempotency-Key"], idempotencyKey);
  assert.deepEqual(JSON.parse(captured.init.body).to, ["manager@example.com"]);
});

test("manual email dedupe is admin-independent while provider attempts remain unique", () => {
  const base = {
    workspaceId: "workspace-1",
    recipientKey: "contact:contact-1",
    runIds: ["run-2", "run-1"],
  };
  const first = server.buildManualSendIdempotencyKey({ ...base, now: new Date("2026-07-16T10:01:00.000Z") });
  const sameAttempt = server.buildManualSendIdempotencyKey({
    ...base,
    runIds: ["run-1", "run-2"],
    now: new Date("2026-07-16T10:01:00.000Z"),
  });
  const later = server.buildManualSendIdempotencyKey({ ...base, now: new Date("2026-07-16T10:01:01.000Z") });
  const dedupe = server.buildManualSendDedupeKey(base);
  const reorderedDedupe = server.buildManualSendDedupeKey({ ...base, runIds: ["run-1", "run-2"] });
  assert.equal(first, sameAttempt);
  assert.notEqual(first, later);
  assert.equal(dedupe, reorderedDedupe);
  assert.match(first, /^inventory-auditor:manual:[0-9a-f]{64}$/);
  assert.match(dedupe, /^inventory-auditor:manual-dedupe:[0-9a-f]{64}$/);
  assert.ok(!first.includes("contact-1"));
  assert.ok(!dedupe.includes("contact-1"));
});

test("Responses-compatible forecasting adapter enables web search and strict structured output", async () => {
  let captured;
  const provider = new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://api.example.com/v1",
    providerName: "openai",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ output: [
        { type: "web_search_call", id: "search-1", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: '{"ok":true}' }] },
      ] });
    },
  });
  const output = await provider.generate({
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  });
  assert.deepEqual(output, { ok: true });
  assert.equal(String(captured.url), "https://api.example.com/v1/responses");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.tools, [{ type: "web_search" }]);
  assert.equal(body.tool_choice, "required");
  assert.equal(body.text.format.type, "json_schema");
  assert.equal(body.text.format.name, "inventory_auditor_research");
  assert.equal(body.text.format.strict, true);
  assert.doesNotMatch(JSON.stringify(body.text.format.schema), /uniqueItems|minItems|maxItems/);
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.text.verbosity, "low");
  assert.equal(body.max_output_tokens, 3_000);
  assert.match(body.input[1].content[0].text, /expected_assessment_count/);
  assert.match(body.input[0].content[0].text, /ANALYSIS_SKILL/);
  assert.deepEqual(body.input[1].content[0].text.includes("100 Queen Street West, Toronto, Ontario, M5H 2N2, CA"), true);
  assert.match(body.input[1].content[0].text, /historical_evidence/);
  assert.doesNotMatch(body.input[1].content[0].text, /historical_rows/);
});

test("forecast timeouts are distinct, actionable, and do not expose transport details", async () => {
  const provider = new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://api.example.com/v1",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => { throw new DOMException("private transport detail", "TimeoutError"); },
  });
  const request = {
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  };
  let timeoutError;
  try {
    await provider.generate(request);
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(timeoutError.code, "request_timeout");
  assert.equal(timeoutError.status, 408);
  assert.doesNotMatch(timeoutError.message, /private transport detail/);
  assert.deepEqual(server.safeForecastFailure(timeoutError), {
    code: "ai_request_timed_out",
    message: "Live research did not finish within five minutes. Choose one location and a lower-latency compatible model, then run the forecast again.",
  });
});

test("provider factory uses Anthropic Messages authentication, search, and host-validated JSON", async () => {
  let captured;
  const provider = server.createForecastProvider({
    providerFamily: "anthropic",
    apiKey: "anthropic-secret",
    model: "claude-web-model",
    baseUrl: "https://api.anthropic.com/v1",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ content: [
        { type: "server_tool_use", name: "web_search", id: "search-1", input: { query: "Toronto weather" } },
        { type: "web_search_tool_result", tool_use_id: "search-1", content: [] },
        { type: "text", text: '{"ok":true}' },
      ] });
    },
  });
  const output = await provider.generate({
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  });
  assert.deepEqual(output, { ok: true });
  assert.equal(String(captured.url), "https://api.anthropic.com/v1/messages");
  assert.equal(captured.init.headers["x-api-key"], "anthropic-secret");
  assert.equal(captured.init.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.tools[0].type, "web_search_20250305");
  assert.deepEqual(body.tools[0].allowed_callers, ["direct"]);
  assert.match(body.system, /host will reject any output/);
});

test("provider factory uses Gemini generateContent authentication, Google Search, and grounding evidence", async () => {
  let captured;
  const provider = server.createForecastProvider({
    providerFamily: "google",
    apiKey: "google-secret",
    model: "gemini-web-model",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ candidates: [{
        groundingMetadata: { webSearchQueries: ["Toronto weather"] },
        content: { parts: [{ text: '{"ok":true}' }] },
      }] });
    },
  });
  const output = await provider.generate({
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  });
  assert.deepEqual(output, { ok: true });
  assert.equal(String(captured.url), "https://generativelanguage.googleapis.com/v1beta/models/gemini-web-model:generateContent");
  assert.equal(captured.init.headers["x-goog-api-key"], "google-secret");
  const body = JSON.parse(captured.init.body);
  assert.deepEqual(body.tools, [{ googleSearch: {} }]);
  assert.match(body.systemInstruction.parts[0].text, /host will reject any output/);
});

test("forecast provider rechecks DNS immediately before paid requests", async () => {
  let calls = 0;
  const provider = new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://rebind.example/v1",
    resolveHost: async () => ["127.0.0.1"],
    fetch: async () => {
      calls += 1;
      return Response.json({ output_text: "{}" });
    },
  });
  await assert.rejects(provider.generate({
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  }), { code: "provider_failed" });
  assert.equal(calls, 0);
});

test("forecast provider rejects out-of-scope historical evidence before any external call", async () => {
  let calls = 0;
  const provider = new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://api.example.com/v1",
    fetch: async () => {
      calls += 1;
      return Response.json({ output_text: "{}" });
    },
  });
  await assert.rejects(
    provider.generate({
      requestId: "run-1",
      analysisPolicy: rootPolicy,
      policySha256: "d".repeat(64),
      scope: structuredClone(exactForecastScope),
      period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
      products: [{ id: "product-1", name: "Croissant" }],
      activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
      historicalEvidence: (() => {
        const evidence = forecastTestEvidence();
        evidence.products[0].locationId = "location-2";
        return evidence;
      })(),
      baselines: [forecastTestBaseline],
    }),
    { code: "invalid_request" },
  );
  assert.equal(calls, 0);
});

test("forecast provider rejects widened or mismatched location research scope before any external call", async () => {
  let calls = 0;
  const provider = new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://api.example.com/v1",
    fetch: async () => {
      calls += 1;
      return Response.json({ output_text: "{}" });
    },
  });
  const scope = structuredClone(exactForecastScope);
  scope.locations[0].researchArea = "All of Ontario";
  await assert.rejects(
    provider.generate({
      requestId: "run-1",
      analysisPolicy: rootPolicy,
      policySha256: "d".repeat(64),
      scope,
      period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
      products: [{ id: "product-1", name: "Croissant" }],
      activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
      historicalEvidence: forecastTestEvidence(),
      baselines: [forecastTestBaseline],
    }),
    { code: "invalid_request" },
  );
  assert.equal(calls, 0);
});

test("host evidence condenses a two-year history into deterministic checksummed metrics", () => {
  const input = {
    historicalRows: [
      { date: "2024-07-17", locationId: "location-1", productId: "product-1", product: "Croissant", quantity: 80 },
      { date: "2025-07-17", locationId: "location-1", productId: "product-1", product: "Croissant", quantity: 90 },
      { date: "2026-07-16", locationId: "location-1", productId: "product-1", product: "Croissant", quantity: 100 },
    ],
    baselines: [forecastTestBaseline],
    locations: ["location-1"],
    products: [{ id: "product-1", name: "Croissant" }],
    grouping: "day",
    forecastStartDate: "2026-07-17",
    forecastEndDate: "2026-07-17",
    historyStartDate: "2024-07-17",
    historyEndDate: "2026-07-16",
  };
  const first = server.buildForecastEvidence(input);
  const second = server.buildForecastEvidence(input);
  assert.equal(first.sha256, second.sha256);
  assert.equal(server.verifyForecastEvidenceChecksum(first), true);
  assert.equal(first.history.rowsUsed, 3);
  assert.ok(first.products[0].representativeDailySeries.length <= 90);
  assert.ok(first.products[0].weekdayProfile.length === 7);
  const tampered = structuredClone(first);
  tampered.products[0].baseline.quantity += 1;
  assert.equal(server.verifyForecastEvidenceChecksum(tampered), false);
});

const validationContext = {
  runId: "run-1",
  workspaceId: "workspace-1",
  brandId: "brand-1",
  locationIds: ["location-1"],
  timeZone: "America/Toronto",
  products: [{ id: "product-1", name: "Croissant" }],
  baselines: [{ locationId: "location-1", productId: "product-1", quantity: 100 }],
  activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
  period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
  history: { startDate: "2026-01-01", endDate: "2026-07-15", rowsUsed: 120 },
  serverTimestamp: "2026-07-16T20:02:00.000Z",
  policy: { id: "inventory-auditor-analysis", version: "1.1.0", sha256: "d".repeat(64), outputSchemaVersion: "1.1" },
  provider: { name: "openai-responses", model: "web-model" },
};

const validForecast = {
  status: "complete",
  scope: { workspace_id: "workspace-1", brand_id: "brand-1", location_ids: ["location-1"], timezone: "America/Toronto" },
  forecast_period: { grouping: "day", start_date: "2026-07-17", end_date: "2026-07-17" },
  policy: { id: "inventory-auditor-analysis", version: "1.1.0", sha256: "d".repeat(64), output_schema_version: "1.1" },
  method: { baseline_method: "same weekday", adjustment_method: "additive percentage adjustments", rounding_rule: "nearest whole unit", research_completed: true },
  recommendations: [{
    location_id: "location-1",
    product_id: "product-1",
    product: "Croissant",
    baseline_quantity: 100,
    adjustments: [{
      variable_id: "weather",
      variable: "Weather and material alerts",
      historical_basis: "supported",
      direction: "increase",
      adjustment_percent: 10,
      confidence: "high",
      relevance: "A forecast alert overlaps the requested period.",
      evidence: "The official forecast shows the relevant condition.",
      source_ids: ["source-1"],
      rough_direction: "neutral",
      rough_adjustment_percent: 0,
      rough_confidence: "low",
      rough_reasoning: "No rough estimate is used because the factor effect is historically supported.",
    }],
    recommended_quantity: 110,
    confidence: "high",
    explanation: "Baseline plus the supported adjustment.",
  }],
  sources: [{
    id: "source-1",
    title: "Official forecast",
    publisher: "Official Weather Agency",
    url: "https://weather.example.gov/forecast/location-1",
    published_or_updated_date: "2026-07-16",
    accessed_at: "2026-07-16T20:00:00.000Z",
    fact_used: "The relevant condition overlaps the requested location and date.",
  }],
  data_quality: { historical_start_date: "2026-01-01", historical_end_date: "2026-07-15", rows_used: 120, issues: [] },
  warnings: [],
  audit: { run_id: "run-1", generated_at: "2026-07-16T20:01:00.000Z", ai_provider: "openai-responses", ai_model: "web-model" },
};

const validResearch = {
  status: "complete",
  assessments: [{
    location_id: "location-1",
    product_id: "product-1",
    variable_id: "weather",
    historical_basis: "supported",
    direction: "increase",
    adjustment_percent: 10,
    confidence: "medium",
    relevance: "The forecast condition overlaps the exact location and date.",
    evidence: "A current official forecast supports a modest demand adjustment.",
    source_ids: ["source-1"],
    rough_direction: "neutral",
    rough_adjustment_percent: 0,
    rough_confidence: "low",
    rough_reasoning: "No rough estimate is used because the factor effect is historically supported.",
  }],
  sources: [{
    id: "source-1",
    title: "Official forecast",
    publisher: "Official Weather Agency",
    url: "https://weather.example.gov/forecast/location-1",
    published_or_updated_date: "2026-07-16",
    fact_used: "The relevant condition overlaps the requested location and date.",
  }],
  warnings: [],
};

test("the host validates AI research and owns final forecast arithmetic", () => {
  const result = server.assembleForecastOutputFromResearch({
    rawResearch: structuredClone(validResearch),
    context: validationContext,
    baselines: [forecastTestBaseline],
    activeVariables: validationContext.activeVariables,
    dataQualityIssues: ["Sparse dates were kept missing rather than converted to zero."],
  });
  assert.equal(result.recommendations[0].baseline_quantity, 100);
  assert.equal(result.recommendations[0].recommended_quantity, 110);
  assert.equal(result.recommendations[0].confidence, "medium");
  assert.match(result.recommendations[0].explanation, /applied \+10% in historically supported adjustments/i);
  assert.equal(result.sources[0].accessed_at, validationContext.serverTimestamp);
  assert.deepEqual(result.data_quality.issues, ["Sparse dates were kept missing rather than converted to zero."]);

  const overLimit = structuredClone(validResearch);
  overLimit.assessments[0].adjustment_percent = 26;
  assert.throws(
    () => server.assembleForecastOutputFromResearch({
      rawResearch: overLimit,
      context: validationContext,
      baselines: [forecastTestBaseline],
      activeVariables: validationContext.activeVariables,
      dataQualityIssues: [],
    }),
    (error) => error.issues.some((issue) => issue.includes("factor cap")),
  );
});

test("the host keeps no-history rough estimates separate, bounded, and review-only", () => {
  const roughResearch = structuredClone(validResearch);
  roughResearch.status = "needs_review";
  Object.assign(roughResearch.assessments[0], {
    historical_basis: "unavailable",
    direction: "neutral",
    adjustment_percent: 0,
    confidence: "low",
    rough_direction: "increase",
    rough_adjustment_percent: 8,
    rough_confidence: "low",
    rough_reasoning: "The verified condition may modestly raise demand, but no condition-matched sales history exists.",
  });
  const result = server.assembleForecastOutputFromResearch({
    rawResearch: roughResearch,
    context: validationContext,
    baselines: [forecastTestBaseline],
    activeVariables: validationContext.activeVariables,
    dataQualityIssues: [],
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.recommendations[0].baseline_quantity, 100);
  assert.equal(result.recommendations[0].recommended_quantity, 108);
  assert.equal(result.recommendations[0].adjustments[0].adjustment_percent, 0);
  assert.equal(result.recommendations[0].adjustments[0].rough_adjustment_percent, 8);
  assert.equal(result.recommendations[0].confidence, "low");
  assert.match(result.warnings.join(" "), /low-confidence rough estimates/i);

  const unsafe = structuredClone(roughResearch);
  unsafe.assessments[0].rough_adjustment_percent = 16;
  assert.throws(
    () => server.assembleForecastOutputFromResearch({
      rawResearch: unsafe,
      context: validationContext,
      baselines: [forecastTestBaseline],
      activeVariables: validationContext.activeVariables,
      dataQualityIssues: [],
    }),
    (error) => error.issues.some((issue) => issue.includes("rough factor cap")),
  );
});

test("forecast output validation accepts a reconciled, cited, exactly scoped result", () => {
  const result = server.validateForecastOutput(structuredClone(validForecast), validationContext);
  assert.equal(result.recommendations[0].recommended_quantity, 110);
  assert.equal(result.audit.generated_at, validationContext.serverTimestamp);
  assert.equal(result.sources[0].accessed_at, validationContext.serverTimestamp);
  assert.deepEqual(result.data_quality, validForecast.data_quality);
});

test("forecast output validation rejects invented history provenance and normalizes provider timestamps", () => {
  const inventedHistory = structuredClone(validForecast);
  inventedHistory.data_quality.rows_used = 999;
  assert.throws(
    () => server.validateForecastOutput(inventedHistory, validationContext),
    (error) => error.issues.some((issue) => issue.includes("host-owned historical input audit")),
  );

  const arbitraryTimes = structuredClone(validForecast);
  arbitraryTimes.audit.generated_at = "2099-12-31T23:59:59.000Z";
  arbitraryTimes.sources[0].accessed_at = "1999-01-01T00:00:00.000Z";
  const normalized = server.validateForecastOutput(arbitraryTimes, validationContext);
  assert.equal(normalized.audit.generated_at, validationContext.serverTimestamp);
  assert.equal(normalized.sources[0].accessed_at, validationContext.serverTimestamp);
});

test("forecast output validation denies cross-location, cross-product, inactive-variable, bad-source, and arithmetic output", () => {
  const cases = [
    ["outside the authorized location scope", (forecast) => { forecast.recommendations[0].location_id = "location-2"; }],
    ["outside the requested product scope", (forecast) => { forecast.recommendations[0].product_id = "product-2"; }],
    ["not active for this run", (forecast) => { forecast.recommendations[0].adjustments[0].variable_id = "invented-variable"; }],
    ["direct HTTPS source URL", (forecast) => { forecast.sources[0].url = "https://www.google.com/search?q=weather"; }],
    ["does not reconcile", (forecast) => { forecast.recommendations[0].recommended_quantity = 111; }],
  ];

  for (const [expectedIssue, mutate] of cases) {
    const candidate = structuredClone(validForecast);
    mutate(candidate);
    assert.throws(
      () => server.validateForecastOutput(candidate, validationContext),
      (error) => error.code === undefined && error.issues.some((issue) => issue.includes(expectedIssue)),
    );
  }
});

test("forecast failures become specific safe warnings without exposing provider content", () => {
  const webSearchFailure = server.safeForecastFailure(new server.ForecastProviderError(
    "web_search_unavailable",
    "upstream-private-detail",
  ));
  assert.equal(webSearchFailure.code, "ai_web_search_not_used");
  assert.match(webSearchFailure.message, /did not perform .*required web search/i);
  assert.doesNotMatch(webSearchFailure.message, /upstream-private-detail/);

  const quotaFailure = server.safeForecastFailure(new server.ForecastProviderError(
    "quota_unavailable",
    "upstream-private-billing-detail",
    429,
  ));
  assert.equal(quotaFailure.code, "ai_quota_unavailable");
  assert.match(quotaFailure.message, /API quota or billing allowance/i);
  assert.doesNotMatch(quotaFailure.message, /upstream-private-billing-detail/);

  const rateFailure = server.safeForecastFailure(new server.ForecastProviderError(
    "rate_limited",
    "upstream-private-rate-detail",
    429,
  ));
  assert.equal(rateFailure.code, "ai_rate_limited");
  assert.match(rateFailure.message, /Choose one location/i);
  assert.doesNotMatch(rateFailure.message, /upstream-private-rate-detail/);

  const invalidSource = structuredClone(validForecast);
  invalidSource.sources[0].url = "https://www.google.com/search?q=weather";
  let validationError;
  try {
    server.validateForecastOutput(invalidSource, validationContext);
  } catch (error) {
    validationError = error;
  }
  const sourceFailure = server.safeForecastFailure(validationError);
  assert.equal(sourceFailure.code, "ai_source_validation_failed");
  assert.match(sourceFailure.message, /evidence sources/i);

  const uncitedResearch = structuredClone(validResearch);
  uncitedResearch.assessments[0].source_ids = [];
  let researchError;
  try {
    server.validateForecastResearchOutput(uncitedResearch, {
      locationIds: validationContext.locationIds,
      products: validationContext.products,
      activeVariables: validationContext.activeVariables,
    });
  } catch (error) {
    researchError = error;
  }
  const researchFailure = server.safeForecastFailure(researchError);
  assert.equal(researchFailure.code, "ai_source_validation_failed");
});

test("forecast provider distinguishes depleted quota from request rate limits without exposing provider messages", async () => {
  const request = {
    requestId: "run-1",
    analysisPolicy: rootPolicy,
    policySha256: "d".repeat(64),
    scope: structuredClone(exactForecastScope),
    period: { grouping: "day", startDate: "2026-07-17", endDate: "2026-07-17" },
    products: [{ id: "product-1", name: "Croissant" }],
    activeVariables: [{ id: "weather", name: "Weather and material alerts" }],
    historicalEvidence: forecastTestEvidence(),
    baselines: [forecastTestBaseline],
  };
  const provider = (response) => new server.OpenAIResponsesForecastProvider({
    apiKey: "ai-secret",
    model: "web-model",
    baseUrl: "https://api.example.com/v1",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async () => response,
  });

  await assert.rejects(
    provider(Response.json({ error: { code: "insufficient_quota", message: "private billing detail" } }, { status: 429 })).generate(request),
    (error) => error.code === "quota_unavailable" && error.status === 429 && !error.message.includes("private billing detail"),
  );
  await assert.rejects(
    provider(Response.json({ error: { code: "rate_limit_exceeded", message: "private limit detail" } }, { status: 429 })).generate(request),
    (error) => error.code === "rate_limited" && error.status === 429 && !error.message.includes("private limit detail"),
  );
});

test("Supabase credential storage uses only the service RPCs and bytea envelopes", async () => {
  const key = Buffer.alloc(32, 4).toString("base64");
  const context = server.credentialEncryptionContext("workspace-1", "resend", "apiKey");
  const secret = "resend-private-credential";
  const writeOnly = server.createWriteOnlySecretRecord(secret, key, context);
  const calls = [];
  const client = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "ia_server_get_provider_secret") {
        return {
          data: [{
            encrypted_value: `\\x${Buffer.from(writeOnly.encryptedValue).toString("hex")}`,
            encryption_key_version: 1,
          }],
          error: null,
        };
      }
      return { data: "11111111-1111-4111-8111-111111111111", error: null };
    },
  };
  const store = new server.SupabaseCredentialStore(client);
  assert.deepEqual(await store.readCredential({
    workspaceId: "workspace-1",
    provider: "resend",
    name: "apiKey",
  }), { encryptedValue: writeOnly.encryptedValue });

  await store.saveProviderConnection({
    workspaceId: "workspace-1",
    provider: "resend",
    actorUserId: "22222222-2222-4222-8222-222222222222",
    status: "untested",
    metadata: {
      providerName: "resend",
      baseUrl: null,
      modelName: null,
      senderEmail: "forecast@example.com",
      repositoryOwner: null,
      repositoryName: null,
      repositoryBranch: null,
    },
    secret: {
      name: "apiKey",
      encryptedValue: writeOnly.encryptedValue,
      encryptionVersion: 1,
      maskedHint: writeOnly.maskedHint,
      fingerprint: server.fingerprintSecret(secret, key, context),
    },
  });

  assert.equal(calls[0].name, "ia_server_get_provider_secret");
  assert.equal(calls[0].args.p_secret_name, "api_key");
  assert.equal(calls[1].name, "ia_server_save_provider_connection");
  assert.deepEqual(Object.keys(calls[1].args).sort(), [
    "p_actor_user_id", "p_base_url", "p_encrypted_value", "p_encryption_key_version",
    "p_masked_hint", "p_model_name", "p_provider_kind", "p_provider_name",
    "p_repository_branch", "p_repository_name", "p_repository_owner", "p_secret_fingerprint",
    "p_secret_name", "p_sender_email", "p_status", "p_workspace_id",
  ]);
  assert.match(calls[1].args.p_encrypted_value, /^\\x[0-9a-f]+$/);
  assert.ok(!JSON.stringify(calls).includes(secret));
});

function aiConnection(overrides = {}) {
  return {
    id: "connection-ai",
    workspaceId: "workspace-1",
    provider: "ai",
    providerName: "responses-compatible",
    baseUrl: "https://api.provider.example/v1",
    modelName: "web-model",
    senderEmail: null,
    repositoryOwner: null,
    repositoryName: null,
    repositoryBranch: null,
    status: "untested",
    maskedHint: "•••• -key",
    secretVersion: 1,
    lastTestedAt: null,
    lastTestResult: null,
    lastErrorCode: null,
    updatedAt: "2026-07-16T19:00:00.000Z",
    ...overrides,
  };
}

test("hidden AI credentials cannot be rebound to a different origin", async () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const storedSecret = "stored-ai-private-key";
  const encryptedValue = server.encryptSecret(
    storedSecret,
    key,
    server.credentialEncryptionContext("workspace-1", "ai", "apiKey"),
  );
  let saves = 0;
  const storedService = new server.IntegrationConnectionService({
    repository: {
      list: async () => [aiConnection()],
      recordTest: async () => { throw new Error("not used"); },
    },
    credentialStore: {
      readCredential: async () => ({ encryptedValue }),
      saveProviderConnection: async () => { saves += 1; return "connection-ai"; },
    },
    encryptionKey: key,
    environment: {},
  });
  await assert.rejects(storedService.save({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "ai",
    body: {
      providerName: "responses-compatible",
      modelName: "web-model",
      baseUrl: "https://attacker.example/v1",
    },
  }), { code: "credential_rotation_required" });
  assert.equal(saves, 0);
  await assert.rejects(storedService.save({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "ai",
    body: {
      providerName: "responses-compatible",
      modelName: "another-web-model",
      baseUrl: "https://api.provider.example/v1",
    },
  }), { code: "credential_rotation_required" });
  assert.equal(saves, 0);

  const environmentService = new server.IntegrationConnectionService({
    repository: {
      list: async () => [aiConnection({ maskedHint: null, baseUrl: "https://attacker.example/v1" })],
      recordTest: async () => { throw new Error("not used"); },
    },
    credentialStore: {
      readCredential: async () => null,
      saveProviderConnection: async () => { saves += 1; return "connection-ai"; },
    },
    encryptionKey: key,
    environment: {
      AI_API_KEY: "environment-ai-private-key",
      AI_PROVIDER: "responses-compatible",
      AI_MODEL: "web-model",
      AI_BASE_URL: "https://api.provider.example/v1",
    },
  });
  await assert.rejects(environmentService.save({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "ai",
    body: {
      providerName: "responses-compatible",
      modelName: "web-model",
      baseUrl: "https://attacker.example/v1",
    },
  }), { code: "credential_rotation_required" });
  assert.equal(saves, 0);
});

test("an AI origin change is atomic when the administrator supplies a replacement key", async () => {
  const key = Buffer.alloc(32, 2).toString("base64");
  const replacement = "replacement-ai-private-key";
  let row = aiConnection();
  let saved;
  const repository = {
    list: async () => [structuredClone(row)],
    recordTest: async () => { throw new Error("not used"); },
  };
  const credentialStore = {
    readCredential: async () => null,
    saveProviderConnection: async (input) => {
      saved = input;
      row = aiConnection({
        baseUrl: input.metadata.baseUrl,
        providerName: input.metadata.providerName,
        modelName: input.metadata.modelName,
        maskedHint: input.secret.maskedHint,
      });
      return row.id;
    },
  };
  const service = new server.IntegrationConnectionService({
    repository,
    credentialStore,
    encryptionKey: key,
    environment: {},
  });
  const result = await service.save({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "ai",
    body: {
      apiKey: replacement,
      providerName: "responses-compatible",
      modelName: "new-web-model",
      baseUrl: "https://new-provider.example/v2",
    },
  });
  assert.equal(result.configuration.baseUrl, "https://new-provider.example/v2");
  assert.equal(saved.status, "untested");
  assert.equal(
    server.decryptSecret(
      saved.secret.encryptedValue,
      key,
      server.credentialEncryptionContext("workspace-1", "ai", "apiKey"),
    ),
    replacement,
  );
  assert.ok(!JSON.stringify(saved).includes(replacement));
});

test("provider probes verify real AI capabilities, reject redirects, and use injected network fakes", async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("api.github.com")) {
      return Response.json({
        type: "file",
        encoding: "base64",
        content: Buffer.from(rootPolicy).toString("base64"),
        sha: "a".repeat(40),
      });
    }
    if (String(url) === "https://api.resend.com/emails") {
      return Response.json({ name: "missing_required_field", message: "Required fields are missing." }, { status: 422 });
    }
    if (String(url).endsWith("/models")) {
      return Response.json({ data: [{ id: "web-model" }] });
    }
    if (String(url).endsWith("/responses")) {
      return Response.json({ output: [
        { type: "web_search_call", id: "search-1", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: '{"capability":"web_search_and_structured_output"}' }] },
      ] });
    }
    throw new Error(`unexpected provider probe ${String(url)}`);
  };
  await server.testProviderConnection({
    configuration: { provider: "resend", senderEmail: "forecast@example.com" },
    credential: "resend-private-key",
    fetch: fetcher,
  });
  await server.testProviderConnection({
    configuration: {
      provider: "ai",
      providerName: "responses-compatible",
      modelName: "web-model",
      baseUrl: "https://api.provider.example/v1",
    },
    credential: "ai-private-key",
    fetch: fetcher,
    resolveHost: async (hostname) => {
      assert.equal(hostname, "api.provider.example");
      return ["93.184.216.34"];
    },
  });
  await server.testProviderConnection({
    configuration: {
      provider: "github",
      repositoryOwner: "Olive-Tree-Builds",
      repositoryName: "inventory-auditor",
      repositoryBranch: "trunk",
    },
    credential: "github-private-token",
    fetch: fetcher,
  });

  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, "{}");
  assert.equal(calls[1].url, "https://api.provider.example/v1/models");
  assert.equal(calls[2].url, "https://api.provider.example/v1/responses");
  const aiProbe = JSON.parse(calls[2].init.body);
  assert.equal(aiProbe.model, "web-model");
  assert.equal(aiProbe.tool_choice, "required");
  assert.equal(aiProbe.text.format.type, "json_schema");
  assert.equal(aiProbe.text.format.strict, true);
  assert.ok(calls[3].url.includes("/contents/ANALYSIS_SKILL.md?ref=trunk"));
  assert.ok(calls.every((call) => call.init.redirect === "error"));
  assert.equal(calls[1].init.method ?? "GET", "GET");
  assert.equal(calls[2].init.method, "POST");
  assert.equal(calls[3].init.method ?? "GET", "GET");
});

test("AI capability probes accept aliases omitted from model lists and report real failures precisely", async () => {
  const configuration = {
    provider: "ai",
    providerName: "responses-compatible",
    modelName: "web-model",
    baseUrl: "https://api.provider.example/v1",
  };
  await server.testProviderConnection({
    configuration,
    credential: "ai-private-key",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "another-model" }] })
      : Response.json({ output: [
        { type: "web_search_call", id: "search-1", status: "completed" },
        { type: "message", content: [{ type: "output_text", text: '{"capability":"web_search_and_structured_output"}' }] },
      ] }),
  });

  await assert.rejects(server.testProviderConnection({
    configuration,
    credential: "ai-private-key",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "canonical-model" }] })
      : Response.json({ error: { code: "model_not_found" } }, { status: 404 }),
  }), { code: "model_unavailable" });

  await assert.rejects(server.testProviderConnection({
    configuration,
    credential: "ai-private-key",
    resolveHost: async () => ["93.184.216.34"],
    fetch: async (url) => String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "web-model" }] })
      : Response.json({ output: [
        { type: "message", content: [{ type: "output_text", text: '{"capability":"web_search_and_structured_output"}' }] },
      ] }),
  }), { code: "web_search_unavailable" });
});

test("Resend probe accepts a Sending-only validation response and rejects invalid credentials", async () => {
  await server.testProviderConnection({
    configuration: { provider: "resend", senderEmail: "forecast@example.com" },
    credential: "sending-only-key",
    fetch: async () => Response.json(
      { name: "missing_required_field", message: "Required fields are missing." },
      { status: 422 },
    ),
  });

  await assert.rejects(
    server.testProviderConnection({
      configuration: { provider: "resend", senderEmail: "forecast@example.com" },
      credential: "invalid-key",
      fetch: async () => Response.json(
        { name: "invalid_api_key", message: "Invalid key." },
        { status: 403 },
      ),
    }),
    { code: "forbidden" },
  );
});

test("provider test failures persist only a stable code and never expose upstream content", async () => {
  const key = Buffer.alloc(32, 1).toString("base64");
  const providerSecret = "environment-resend-private-key";
  const upstreamBody = "upstream-body-must-stay-private";
  let row = {
    id: "connection-resend",
    workspaceId: "workspace-1",
    provider: "resend",
    providerName: "resend",
    baseUrl: null,
    modelName: null,
    senderEmail: "forecast@example.com",
    repositoryOwner: null,
    repositoryName: null,
    repositoryBranch: null,
    status: "untested",
    maskedHint: null,
    secretVersion: 0,
    lastTestedAt: null,
    lastTestResult: null,
    lastErrorCode: null,
    updatedAt: "2026-07-16T19:00:00.000Z",
  };
  let recorded;
  const service = new server.IntegrationConnectionService({
    repository: {
      list: async () => [structuredClone(row)],
      recordTest: async (input) => {
        recorded = input;
        row = {
          ...row,
          status: input.passed ? "connected" : "failing",
          lastTestedAt: "2026-07-16T20:00:00.000Z",
          lastTestResult: input.passed ? "passed" : "failed",
          lastErrorCode: input.errorCode,
        };
        return structuredClone(row);
      },
    },
    credentialStore: {
      readCredential: async () => null,
      saveProviderConnection: async () => { throw new Error("not used"); },
    },
    encryptionKey: key,
    environment: { RESEND_API_KEY: providerSecret, RESEND_FROM_EMAIL: "forecast@example.com" },
    fetch: async () => new Response(upstreamBody, { status: 401 }),
  });
  const result = await service.test({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "resend",
  });
  assert.equal(result.passed, false);
  assert.equal(result.errorCode, "unauthorized");
  assert.equal(recorded.errorCode, "unauthorized");
  assert.deepEqual(recorded.expected, {
    id: "connection-resend",
    secretVersion: 0,
    updatedAt: "2026-07-16T19:00:00.000Z",
  });
  assert.ok(!JSON.stringify(result).includes(providerSecret));
  assert.ok(!JSON.stringify(result).includes(upstreamBody));
});

test("a provider test result is recorded only against the exact version that was probed", async () => {
  const operations = [];
  const returnedRow = {
    id: "connection-ai",
    workspace_id: "workspace-1",
    provider_kind: "ai",
    provider_name: "responses-compatible",
    base_url: "https://api.provider.example/v1",
    model_name: "web-model",
    sender_email: null,
    repository_owner: null,
    repository_name: null,
    repository_branch: null,
    status: "connected",
    masked_hint: "•••• -key",
    secret_version: 4,
    last_tested_at: "2026-07-16T20:00:00.000Z",
    last_test_result: "passed",
    last_error_code: null,
    updated_at: "2026-07-16T20:00:00.000Z",
  };
  const connectionBuilder = {
    update(values) { operations.push(["update", values]); return this; },
    eq(column, value) { operations.push(["eq", column, value]); return this; },
    select(columns) { operations.push(["select", columns]); return this; },
    async single() { return { data: returnedRow, error: null }; },
  };
  const client = {
    from(table) {
      if (table === "ia_provider_connections") return connectionBuilder;
      return {
        insert: async (values) => {
          operations.push(["audit", values]);
          return { error: null };
        },
      };
    },
  };
  const repository = new server.SupabaseIntegrationConnectionRepository(client);
  await repository.recordTest({
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    provider: "ai",
    configuration: {
      provider: "ai",
      providerName: "responses-compatible",
      modelName: "web-model",
      baseUrl: "https://api.provider.example/v1",
    },
    expected: {
      id: "connection-ai",
      secretVersion: 4,
      updatedAt: "2026-07-16T19:59:00.000Z",
    },
    passed: true,
    errorCode: null,
  });
  assert.ok(operations.some((operation) => (
    operation[0] === "eq" && operation[1] === "id" && operation[2] === "connection-ai"
  )));
  assert.ok(operations.some((operation) => (
    operation[0] === "eq" && operation[1] === "secret_version" && operation[2] === 4
  )));
  assert.ok(operations.some((operation) => (
    operation[0] === "eq" && operation[1] === "updated_at" && operation[2] === "2026-07-16T19:59:00.000Z"
  )));
});

test("provider input validation rejects private endpoints, non-trunk repositories, and extra authority fields", () => {
  assert.equal(server.integrationProviderSchema.safeParse("supabase").success, false);
  assert.throws(() => server.parseProviderSaveInput("ai", {
    apiKey: "private-ai-key",
    providerName: "responses-compatible",
    modelName: "web-model",
    baseUrl: "https://127.0.0.1/v1",
  }));
  assert.throws(() => server.parseProviderSaveInput("github", {
    token: "private-github-token",
    repositoryOwner: "Olive-Tree-Builds",
    repositoryName: "inventory-auditor",
    repositoryBranch: "main",
  }));
  assert.throws(() => server.parseProviderSaveInput("resend", {
    apiKey: "private-resend-key",
    senderEmail: "forecast@example.com",
    workspaceId: "attacker-selected-workspace",
  }));
});

test("service-role integration construction cannot run before admin authorization", async () => {
  assert.deepEqual(server.INTEGRATION_ADMIN_ROLES, ["super_admin", "admin"]);
  let serviceCreations = 0;
  await assert.rejects(server.authorizeBeforeServiceRole({
    authorize: async () => { throw new Error("not authorized"); },
    createService: () => {
      serviceCreations += 1;
      return {};
    },
  }), /not authorized/);
  assert.equal(serviceCreations, 0);

  const order = [];
  const authorized = await server.authorizeBeforeServiceRole({
    authorize: async () => {
      order.push("authorized");
      return { workspaceId: "workspace-from-membership" };
    },
    createService: (context) => {
      order.push(`service:${context.workspaceId}`);
      serviceCreations += 1;
      return { ready: true };
    },
  });
  assert.deepEqual(order, ["authorized", "service:workspace-from-membership"]);
  assert.deepEqual(authorized.service, { ready: true });
  assert.equal(serviceCreations, 1);
});

test("combined forecast email escapes database content and contains only stored recommendations", () => {
  const message = server.composeCombinedForecastEmail({
    workspaceName: "Test <Workspace>",
    recipientName: "Manager & Owner",
    internalTest: true,
    locations: [{
      locationId: "location-1",
      runId: "run-1",
      brandName: "Brand <One>",
      locationName: "Queen & <script>alert(1)</script>",
      periodStart: "2026-07-17",
      periodEnd: "2026-07-17",
      status: "needs_review",
      generatedAt: "2026-07-16T20:00:00.000Z",
      products: [{
        name: "Croissant <large>",
        recommendedQuantity: 42,
        confidence: "medium",
        explanation: "Use stored history; <img src=x onerror=alert(1)>",
      }],
      sources: [{ title: "Official & source", url: "https://example.com/events?a=1&b=2" }],
    }],
  });
  assert.match(message.subject, /^Internal test/);
  assert.match(message.html, /42/);
  assert.match(message.html, /Queen &amp; &lt;script&gt;/);
  assert.ok(!message.html.includes("<script>"));
  assert.ok(!message.html.includes("<img src=x"));
  assert.match(message.text, /Queen & <script>/);
  assert.throws(() => server.composeCombinedForecastEmail({
    workspaceName: "Workspace",
    recipientName: "Manager",
    locations: [],
  }), { code: "invalid_content" });
});

test("timezone-aware schedules select the earliest assigned location and exact horizon", () => {
  const due = server.evaluateDueEmailSchedule({
    cadence: "daily",
    weekdayMask: 127,
    localSendTime: "05:00",
    timezoneRule: "earliest_assigned_location",
    workspaceTimeZone: null,
    recipientTimeZone: null,
    locationTimeZones: ["America/Vancouver", "America/Toronto"],
    forecastHorizon: "tomorrow",
  }, new Date("2026-07-16T09:15:00.000Z"));
  assert.deepEqual(due, {
    timeZone: "America/Toronto",
    localDate: "2026-07-16",
    scheduledFor: "2026-07-16T09:00:00.000Z",
    periodStart: "2026-07-17",
    periodEnd: "2026-07-17",
  });
  assert.equal(server.evaluateDueEmailSchedule({
    cadence: "daily",
    weekdayMask: 127,
    localSendTime: "05:00",
    timezoneRule: "workspace",
    workspaceTimeZone: "America/Toronto",
    recipientTimeZone: null,
    locationTimeZones: [],
    forecastHorizon: "today",
  }, new Date("2026-07-16T08:59:00.000Z")), null);
});

test("cron authorization uses the configured bearer secret and rejects malformed headers", () => {
  const secret = "cron-secret-".padEnd(40, "x");
  assert.equal(server.isAuthorizedCronRequest(`Bearer ${secret}`, secret), true);
  assert.equal(server.isAuthorizedCronRequest(`Bearer wrong-${secret}`, secret), false);
  assert.equal(server.isAuthorizedCronRequest(`Basic ${secret}`, secret), false);
  assert.equal(server.isAuthorizedCronRequest(null, secret), false);
});

test("email delivery resolves the encrypted workspace Resend credential before environment fallback", async () => {
  const encryptionKey = Buffer.alloc(32, 4).toString("base64");
  const context = server.credentialEncryptionContext("workspace-1", "resend", "apiKey");
  const encrypted = server.encryptSecret("stored-resend-private", encryptionKey, context);
  const builder = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return {
        data: { sender_email: "stored-sender@example.com", status: "untested", masked_hint: "•••• vate" },
        error: null,
      };
    },
  };
  const admin = {
    from(table) {
      assert.equal(table, "ia_provider_connections");
      return builder;
    },
    async rpc(name) {
      assert.equal(name, "ia_server_get_provider_secret");
      return { data: [{ encrypted_value: encrypted, encryption_key_version: 1 }], error: null };
    },
  };
  const resolved = await server.resolveResendDelivery({
    admin,
    workspaceId: "workspace-1",
    environment: {
      APP_SECRET_ENCRYPTION_KEY: encryptionKey,
      RESEND_API_KEY: "environment-must-not-win",
      RESEND_FROM_EMAIL: "environment@example.com",
    },
  });
  assert.equal(resolved.source, "stored");
  assert.equal(resolved.apiKey, "stored-resend-private");
  assert.equal(resolved.sender, "stored-sender@example.com");
  assert.ok(!JSON.stringify({ ...resolved, apiKey: undefined }).includes("stored-resend-private"));

  const invitationRoute = readFileSync("app/api/users/invite/route.ts", "utf8");
  assert.match(invitationRoute, /resolveResendDelivery/);
  assert.doesNotMatch(invitationRoute, /process\.env\.RESEND_API_KEY/);
  assert.match(invitationRoute, /inviteUrl: emailSent \? null : inviteUrl/);
});

function fakeDeliveryClaimAdmin({ stranded = false, unboundAttempt = false } = {}) {
  const delivery = stranded ? {
    id: "delivery-1",
    workspace_id: "workspace-1",
    status: "sending",
    created_at: "2026-07-16T20:00:00.000Z",
    current_attempt_id: null,
    idempotency_key: "scheduled-key-1",
  } : null;
  const attempts = unboundAttempt ? [{
    id: "old-attempt-1",
    attempt_number: 1,
    attempted_at: "2026-07-16T20:01:00.000Z",
    status: "started",
  }] : [];
  const operations = [];

  class Query {
    constructor(table) {
      this.table = table;
      this.action = "select";
      this.payload = null;
      this.filters = [];
    }
    select() { return this; }
    insert(payload) { this.action = "insert"; this.payload = payload; return this; }
    update(payload) { this.action = "update"; this.payload = payload; return this; }
    delete() { this.action = "delete"; return this; }
    eq(column, value) { this.filters.push({ method: "eq", column, value }); return this; }
    is(column, value) { this.filters.push({ method: "is", column, value }); return this; }
    order() { return this; }
    limit() { return this; }
    matches(row) {
      return this.filters.every((filter) => (
        filter.method === "is"
          ? row[filter.column] === filter.value
          : row[filter.column] === filter.value
      ));
    }
    execute(single) {
      operations.push({
        table: this.table,
        action: this.action,
        payload: structuredClone(this.payload),
        filters: structuredClone(this.filters),
      });
      if (this.table === "ia_email_deliveries") {
        if (this.action === "insert") {
          if (delivery) return { data: null, error: { code: "23505" } };
          Object.assign(state, { delivery: { id: "delivery-1", created_at: "2026-07-17T00:00:00.000Z", ...this.payload } });
          return { data: { id: "delivery-1", status: "sending" }, error: null };
        }
        if (this.action === "select") {
          return { data: state.delivery ? structuredClone(state.delivery) : null, error: null };
        }
        if (this.action === "update") {
          if (!state.delivery || !this.matches(state.delivery)) return { data: null, error: null };
          Object.assign(state.delivery, this.payload);
          return { data: single ? { id: state.delivery.id } : [{ id: state.delivery.id }], error: null };
        }
      }
      if (this.table === "ia_email_delivery_attempts") {
        if (this.action === "select") {
          const row = attempts.at(-1) ?? null;
          return { data: row ? structuredClone(row) : null, error: null };
        }
        if (this.action === "update") {
          const row = attempts.find((attempt) => this.matches({
            ...attempt,
            workspace_id: "workspace-1",
            delivery_id: "delivery-1",
          }));
          if (!row) return { data: null, error: null };
          Object.assign(row, this.payload);
          return { data: single ? { id: row.id } : [{ id: row.id }], error: null };
        }
        if (this.action === "insert") {
          attempts.push(structuredClone(this.payload));
          return { data: { id: this.payload.id }, error: null };
        }
      }
      if (this.table === "ia_email_delivery_locations") {
        return { data: single ? null : [], error: null };
      }
      throw new Error(`unexpected delivery query: ${this.table} ${this.action}`);
    }
    maybeSingle() { return Promise.resolve(this.execute(true)); }
    then(resolve, reject) { return Promise.resolve(this.execute(false)).then(resolve, reject); }
  }

  const state = { delivery };
  return {
    admin: { from(table) { return new Query(table); } },
    attempts,
    operations,
    state,
  };
}

test("scheduled delivery reserves attempt pointers and reclaims a stale null pointer safely", async () => {
  const baseInput = {
    workspaceId: "workspace-1",
    scheduleId: "schedule-1",
    recipientUserId: "recipient-1",
    periodStart: "2026-07-17",
    periodEnd: "2026-07-17",
    dueAt: "2026-07-17T00:00:00.000Z",
    idempotencyKey: "scheduled-key-1",
    forecasts: [{ locationId: "location-1", runId: "run-1" }],
    now: new Date("2026-07-17T00:30:00.000Z"),
  };

  const fresh = fakeDeliveryClaimAdmin();
  const freshClaim = await server.claimScheduledDelivery({ ...baseInput, admin: fresh.admin });
  const freshDeliveryInsert = fresh.operations.find((operation) => (
    operation.table === "ia_email_deliveries" && operation.action === "insert"
  ));
  const freshAttemptInsert = fresh.operations.find((operation) => (
    operation.table === "ia_email_delivery_attempts" && operation.action === "insert"
  ));
  assert.equal(freshDeliveryInsert.payload.current_attempt_id, freshClaim.attemptId);
  assert.equal(freshAttemptInsert.payload.id, freshClaim.attemptId);

  const pointerless = fakeDeliveryClaimAdmin({ stranded: true });
  const pointerlessClaim = await server.claimScheduledDelivery({ ...baseInput, admin: pointerless.admin });
  assert.equal(pointerlessClaim.attemptNumber, 1);
  assert.equal(pointerless.state.delivery.current_attempt_id, pointerlessClaim.attemptId);

  const stranded = fakeDeliveryClaimAdmin({ stranded: true, unboundAttempt: true });
  const reclaimed = await server.claimScheduledDelivery({ ...baseInput, admin: stranded.admin });
  assert.equal(reclaimed.attemptNumber, 2);
  assert.equal(stranded.attempts[0].status, "failed");
  assert.equal(stranded.attempts[0].failure_code, "stale_attempt_reclaimed");
  assert.equal(stranded.state.delivery.current_attempt_id, reclaimed.attemptId);

  const staleDeliveryIndex = stranded.operations.findIndex((operation) => (
    operation.table === "ia_email_deliveries" &&
    operation.action === "update" &&
    operation.payload?.failure_code === "stale_attempt_reclaimed"
  ));
  const staleAttemptIndex = stranded.operations.findIndex((operation) => (
    operation.table === "ia_email_delivery_attempts" &&
    operation.action === "update" &&
    operation.payload?.failure_code === "stale_attempt_reclaimed"
  ));
  assert.ok(staleDeliveryIndex >= 0 && staleDeliveryIndex < staleAttemptIndex);
  assert.ok(stranded.operations[staleDeliveryIndex].filters.some((filter) => (
    filter.method === "is" && filter.column === "current_attempt_id" && filter.value === null
  )));
  assert.ok(!stranded.operations.some((operation) => operation.filters.some((filter) => (
    filter.method === "eq" && filter.column === "current_attempt_id" && filter.value === ""
  ))));
});

test("scheduled forecast email route is gated and delegates forecast and delivery claims to their owners", () => {
  const route = readFileSync("app/api/jobs/forecast/route.ts", "utf8");
  const runner = readFileSync("app/lib/server/forecast-runner.ts", "utf8");
  assert.match(route, /EMAIL_DELIVERY_ENABLED/);
  assert.match(route, /isAuthorizedCronRequest/);
  assert.match(route, /runWorkspaceForecasts/);
  assert.match(route, /supabase: admin/);
  assert.match(route, /runSource: "scheduled"/);
  assert.match(route, /periodOverride:/);
  assert.doesNotMatch(route, /claimScheduledForecastGeneration/);
  assert.match(runner, /claimForecastGeneration/);
  assert.match(runner, /failForecastGeneration/);
  assert.match(route, /claimScheduledDelivery/);
  assert.match(route, /scopeSignature\(currentScope\) !== scopeSignature\(scope\)/);

  const migration = readFileSync("supabase/migrations/20260716220000_email_delivery_verification.sql", "utf8");
  assert.match(migration, /ia_email_delivery_verifications/);
  assert.match(migration, /credential_fingerprint/);
  assert.match(migration, /ia_scheduled_forecast_claims/);
  assert.match(migration, /interval '15 minutes'/);
  assert.match(migration, /revoke all on function public\.ia_server_mark_email_verified/);
  assert.match(migration, /grant execute on function public\.ia_server_claim_scheduled_forecast[\s\S]*to service_role/);
});

test("internal test email route is administrator-only and never substitutes demo quantities", () => {
  const route = readFileSync("app/api/email/test/route.ts", "utf8");
  assert.match(route, /requireWorkspaceContext\(\["super_admin", "admin"\]\)/);
  assert.match(route, /sendInternalForecastTest/);
  assert.doesNotMatch(route, /demo|sample quantity|mock/i);
  const service = readFileSync("app/lib/server/supabase-email-delivery.ts", "utf8");
  assert.match(service, /loadActiveRecipientScope/);
  assert.match(service, /email_enabled/);
  assert.match(service, /loadDeliverableForecasts/);
  assert.match(service, /ia_server_mark_email_verified/);
  const migration = readFileSync("supabase/migrations/20260716210000_inventory_auditor.sql", "utf8");
  assert.match(migration, /v_workspace_id, p_user_id, 'super_admin', 'active', true, p_user_id/);
  assert.match(migration, /email_sending_enabled boolean not null default false/);
});

test("internal email test uses a mocked provider, one recipient, and exact active locations", async () => {
  const encryptionKey = Buffer.alloc(32, 6).toString("base64");
  const verifiedPolicy = server.verifyAnalysisPolicy(rootPolicy);
  const policyBlobSha = "a".repeat(40);
  const encrypted = server.encryptSecret(
    "stored-resend-key",
    encryptionKey,
    server.credentialEncryptionContext("workspace-1", "resend", "apiKey"),
  );
  const tableRows = {
    ia_workspaces: [{ name: "Test Workspace", status: "active" }],
    ia_provider_connections: [{ sender_email: "forecasts@example.com", status: "untested", masked_hint: "•••• -key" }],
    ia_workspace_memberships: [{ user_id: "recipient-1", status: "active", email_enabled: true }],
    ia_profiles: [{ email: "manager@example.com", display_name: "Manager One" }],
    ia_user_location_assignments: [{ location_id: "location-1" }],
    ia_workspace_analysis_state: [{ active_policy_revision_id: "policy-1" }],
    ia_analysis_policy_revisions: [{
      id: "policy-1",
      policy_id: verifiedPolicy.policyId,
      policy_version: verifiedPolicy.policyVersion,
      output_schema_version: verifiedPolicy.outputSchemaVersion,
      active_variable_revision: verifiedPolicy.activeVariableRevision,
      markdown_content: verifiedPolicy.markdown,
      active_variables: verifiedPolicy.activeVariables,
      sha256: verifiedPolicy.sha256,
      repository_blob_sha: policyBlobSha,
    }],
    ia_import_batches: [{ committed_at: "2026-07-01T00:00:00.000Z" }],
    ia_locations: [{
      id: "location-1",
      brand_id: "brand-1",
      name: "Queen Street",
      time_zone: "America/Toronto",
      street_address: "100 Queen Street West",
      city: "Toronto",
      region: "Ontario",
      postal_code: "M5H 2N2",
      country_code: "CA",
    }],
    ia_brands: [{ id: "brand-1", name: "Test Brand" }],
    ia_forecast_runs: [{ id: "run-1", location_id: "location-1", policy_revision_id: "policy-1", period_start: "2026-07-17", period_end: "2026-07-17", status: "baseline_only", generated_at: "2026-07-16T20:00:00.000Z", completed_at: "2026-07-16T20:00:00.000Z", created_at: "2026-07-16T20:00:00.000Z" }],
    ia_forecast_items: [{ forecast_run_id: "run-1", product_id: "product-1", recommended_quantity: 31, confidence: "medium", explanation: "Stored baseline recommendation." }],
    ia_forecast_sources: [],
    ia_products: [{ id: "product-1", name: "Croissant" }],
  };
  const rpcCalls = [];
  class Query {
    constructor(table) { this.table = table; }
    select() { return this; }
    eq() { return this; }
    gte() { return this; }
    in() { return this; }
    is() { return this; }
    order() { return this; }
    limit() { return this; }
    result(single = false) {
      const rows = structuredClone(tableRows[this.table] ?? []);
      return { data: single ? rows[0] ?? null : rows, error: null };
    }
    maybeSingle() { return Promise.resolve(this.result(true)); }
    then(resolve, reject) { return Promise.resolve(this.result(false)).then(resolve, reject); }
  }
  const admin = {
    from(table) { return new Query(table); },
    async rpc(name, params) {
      rpcCalls.push([name, params]);
      if (name === "ia_server_get_provider_secret") {
        return { data: [{ encrypted_value: encrypted, encryption_key_version: 1 }], error: null };
      }
      if (name === "ia_server_mark_email_verified") return { data: null, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const providerCalls = [];
  const result = await server.sendInternalForecastTest({
    admin,
    workspaceId: "workspace-1",
    actorUserId: "actor-1",
    recipientUserId: "recipient-1",
    environment: { APP_SECRET_ENCRYPTION_KEY: encryptionKey },
    repositoryPolicyLoader: async () => ({ content: rootPolicy, sha: policyBlobSha, htmlUrl: null }),
    now: new Date("2026-07-16T20:00:00.000Z"),
    fetch: async (url, init) => {
      providerCalls.push({ url: String(url), init });
      return Response.json({ id: "resend-message-1" });
    },
  });
  assert.deepEqual(result, { locationCount: 1 });
  assert.equal(providerCalls.length, 1);
  const outbound = JSON.parse(providerCalls[0].init.body);
  assert.deepEqual(outbound.to, ["manager@example.com"]);
  assert.match(outbound.html, /Queen Street/);
  assert.match(outbound.html, />31</);
  assert.ok(!outbound.html.includes("another@example.com"));
  const verification = rpcCalls.find(([name]) => name === "ia_server_mark_email_verified");
  assert.deepEqual(verification[1].p_location_ids, ["location-1"]);
  assert.equal(verification[1].p_provider_message_id, "resend-message-1");

  let assignmentReads = 0;
  class LosingAssignmentQuery extends Query {
    result(single = false) {
      if (this.table === "ia_user_location_assignments") {
        assignmentReads += 1;
        if (assignmentReads > 1) return { data: single ? null : [], error: null };
      }
      return super.result(single);
    }
  }
  const losingAdmin = {
    from(table) { return new LosingAssignmentQuery(table); },
    rpc: admin.rpc,
  };
  let unsafeProviderCalls = 0;
  await assert.rejects(server.sendInternalForecastTest({
    admin: losingAdmin,
    workspaceId: "workspace-1",
    actorUserId: "actor-1",
    recipientUserId: "recipient-1",
    environment: { APP_SECRET_ENCRYPTION_KEY: encryptionKey },
    repositoryPolicyLoader: async () => ({ content: rootPolicy, sha: policyBlobSha, htmlUrl: null }),
    now: new Date("2026-07-16T20:00:00.000Z"),
    fetch: async () => {
      unsafeProviderCalls += 1;
      return Response.json({ id: "must-not-send" });
    },
  }), { code: "recipient_has_no_locations" });
  assert.equal(unsafeProviderCalls, 0);
});
