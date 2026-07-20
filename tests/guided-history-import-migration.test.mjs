import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync(
  "supabase/migrations/20260717203635_guided_history_import.sql",
  "utf8",
);
const schemaContract = readFileSync("supabase/tests/schema_contract.sql", "utf8");

test("guided imports add brand-scoped location and product aliases with indexed foreign keys", () => {
  assert.match(migration, /create table public\.ia_location_import_aliases/);
  assert.match(migration, /create table public\.ia_product_import_aliases/);
  assert.equal(
    (migration.match(/primary key \(workspace_id, brand_id, source_name\)/g) ?? []).length,
    2,
  );
  assert.match(
    migration,
    /foreign key \(workspace_id, brand_id, location_id\)[\s\S]*references public\.ia_locations\(workspace_id, brand_id, id\)/,
  );
  assert.match(
    migration,
    /foreign key \(workspace_id, brand_id, product_id\)[\s\S]*references public\.ia_products\(workspace_id, brand_id, id\)/,
  );
  assert.match(migration, /ia_location_import_aliases_location_fk_idx/);
  assert.match(migration, /ia_product_import_aliases_product_fk_idx/);
  assert.match(
    migration,
    /drop constraint if exists ia_import_batches_workspace_id_source_sha256_key/,
  );
  assert.match(
    migration,
    /constraint ia_import_batches_workspace_brand_source_sha256_key[\s\S]*unique \(workspace_id, brand_id, source_sha256\)/,
  );
});

test("alias tables use explicit admin RLS and least-privilege Data API grants", () => {
  for (const table of ["ia_location_import_aliases", "ia_product_import_aliases"]) {
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} enable row level security`),
    );
    assert.match(
      migration,
      new RegExp(`alter table public\\.${table} force row level security`),
    );
    assert.match(
      migration,
      new RegExp(`policy ${table}_select[\\s\\S]*for select to authenticated`),
    );
    assert.match(
      migration,
      new RegExp(`revoke all on table public\\.${table}[\\s\\S]*from public, anon, authenticated`),
    );
  }
  assert.match(
    migration,
    /grant select on public\.ia_location_import_aliases,[\s\S]*public\.ia_product_import_aliases to authenticated/,
  );
  assert.doesNotMatch(
    migration,
    /grant (?:insert|update|delete|all)[^;]*ia_(?:location|product)_import_aliases[^;]*to authenticated/i,
  );
});

test("preview is an admin-only definer boundary that validates brand, row types, aliases, and local dates", () => {
  assert.match(
    migration,
    /create function public\.ia_preview_historical_import_v2\([\s\S]*p_brand_id uuid,[\s\S]*p_rows jsonb/,
  );
  assert.match(
    migration,
    /returns table \([\s\S]*inserted_count integer,[\s\S]*corrected_count integer,[\s\S]*unchanged_count integer,[\s\S]*new_product_count integer/,
  );
  assert.match(
    migration,
    /ia_preview_historical_import_v2\([\s\S]*security definer[\s\S]*set search_path = ''/,
  );
  assert.match(migration, /membership\.role in \('super_admin', 'admin'\)/);
  assert.match(migration, /workspace\.status = 'active'/);
  assert.match(migration, /brand\.archived_at is null/);
  assert.match(migration, /rows must be a non-empty JSON array of at most 100000 items/);
  assert.match(migration, /item\.value - array\[[\s\S]*'product_id'[\s\S]*'quantity'/);
  assert.match(migration, /future local business date/);
  assert.match(
    migration,
    /ia_has_location_access\([\s\S]*v_workspace_id, row_data\.location_id[\s\S]*unassigned location/,
  );
  assert.match(migration, /source location conflicts with its saved alias/);
  assert.match(migration, /source product conflicts with its saved alias/);
  assert.match(migration, /inactive or outside the selected brand/);
  assert.match(migration, /duplicate resolved product\/location\/date rows are not allowed/);
  assert.ok(
    (migration.match(/regexp_replace\(btrim\(product\.name\), '\[\[:space:\]\]\+', ' ', 'g'\)/g) ?? [])
      .length >= 6,
    "stored product names must use the parser's internal-whitespace normalization everywhere",
  );
  assert.match(
    migration,
    /where row_data\.supplied_product_id is null\s+group by row_data\.row_number\s+having count\(\*\) > 1/,
  );
});

test("commit is locked, atomic, idempotent, correction-aware, and preserves unchanged facts", () => {
  assert.match(
    migration,
    /create function public\.ia_import_historical_sales_v2\([\s\S]*p_brand_id uuid,[\s\S]*p_filename text,[\s\S]*p_checksum text,[\s\S]*p_rows jsonb/,
  );
  assert.match(
    migration,
    /returns table \([\s\S]*import_batch_id uuid,[\s\S]*inserted_count integer,[\s\S]*corrected_count integer,[\s\S]*unchanged_count integer,[\s\S]*products_created integer,[\s\S]*already_imported boolean/,
  );
  const commitStart = migration.indexOf("create function public.ia_import_historical_sales_v2");
  const sharedWorkspaceLock = migration.indexOf("'ia_history:' || v_workspace_id::text", commitStart);
  const brandLock = migration.indexOf("ia_history_v2_workspace_brand:", sharedWorkspaceLock);
  const checksumLock = migration.indexOf("ia_history_v2_checksum:", brandLock);
  const previewCall = migration.indexOf("ia_preview_historical_import_v2(p_brand_id, p_rows)", checksumLock);
  assert.ok(
    commitStart > 0
      && sharedWorkspaceLock > commitStart
      && brandLock > sharedWorkspaceLock
      && checksumLock > brandLock
      && previewCall > checksumLock,
    "commit lock order must be shared workspace, brand, checksum, then authoritative preview",
  );
  assert.match(
    migration,
    /where batch\.workspace_id = v_workspace_id[\s\S]*batch\.brand_id = p_brand_id[\s\S]*batch\.source_sha256 = lower\(p_checksum\)/,
  );
  assert.match(migration, /insert into public\.ia_products/);
  assert.match(migration, /deterministic_import_code/);
  assert.match(migration, /insert into public\.ia_location_import_aliases/);
  assert.match(migration, /insert into public\.ia_product_import_aliases/);
  assert.match(migration, /on conflict \(workspace_id, brand_id, source_name\) do nothing/);
  assert.match(
    migration,
    /on conflict \(workspace_id, location_id, product_id, business_date\) do nothing/,
  );
  assert.match(migration, /history\.quantity is distinct from resolved\.quantity/);
  assert.doesNotMatch(
    migration,
    /on conflict \(workspace_id, location_id, product_id, business_date\) do update/,
  );
  assert.match(migration, /'historical_import_v2\.committed'/);
  assert.match(migration, /'products_created', v_products_created/);

  const commitBody = migration.slice(commitStart, migration.indexOf("-- Compatibility for callers", commitStart));
  assert.match(
    commitBody,
    /if found then[\s\S]*inserted_count := 0;[\s\S]*corrected_count := 0;[\s\S]*unchanged_count := v_existing_batch\.row_count;[\s\S]*products_created := 0;[\s\S]*already_imported := true;/,
  );
  assert.doesNotMatch(
    commitBody,
    /if found then[\s\S]{0,800}validation_summary ->> '(?:inserted|corrected|replaced)'/,
  );
  assert.match(
    commitBody,
    /products_created := v_products_created;\s+already_imported := false;\s+return next;/,
  );
});

test("functions are explicitly granted, the original RPC remains compatible, and the migration is marked", () => {
  assert.match(
    migration,
    /revoke all on function public\.ia_preview_historical_import_v2\(uuid, jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /revoke all on function public\.ia_import_historical_sales_v2\(uuid, text, text, jsonb\)[\s\S]*from public, anon, authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.ia_preview_historical_import_v2\(uuid, jsonb\)[\s\S]*to authenticated/,
  );
  assert.match(
    migration,
    /grant execute on function public\.ia_import_historical_sales_v2\(uuid, text, text, jsonb\)[\s\S]*to authenticated/,
  );
  assert.match(
    migration,
    /create or replace function public\.ia_import_historical_sales\([\s\S]*ia_import_historical_sales_v2/,
  );
  assert.match(migration, /replaced_count := v_result\.corrected_count \+ v_result\.unchanged_count/);
  assert.match(migration, /values \('20260717203635_guided_history_import'\)/);
});

test("disposable database checks cover guided import schema, privileges, guards, and lock order", () => {
  for (const marker of [
    "ia_location_import_aliases",
    "ia_product_import_aliases",
    "ia_location_import_aliases_location_fk_idx",
    "ia_product_import_aliases_product_fk_idx",
    "ia_preview_historical_import_v2(uuid,jsonb)",
    "ia_import_historical_sales_v2(uuid,text,text,jsonb)",
    "ia_has_location_access",
    "ia_history:",
    "ia_history_v2_workspace_brand:",
    "ia_history_v2_checksum:",
    "already_imported boolean",
    "20260717203635_guided_history_import",
  ]) {
    assert.ok(schemaContract.includes(marker), `schema contract should verify ${marker}`);
  }
  assert.match(schemaContract, /pg_policies/);
  assert.match(schemaContract, /relrowsecurity and relation\.relforcerowsecurity/);
  assert.match(schemaContract, /has_function_privilege\('authenticated',[\s\S]*ia_preview_historical_import_v2/);
  assert.match(schemaContract, /has_function_privilege\('anon',[\s\S]*ia_import_historical_sales_v2/);
  assert.match(schemaContract, /pg_get_functiondef/);
});
