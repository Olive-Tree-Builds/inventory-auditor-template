-- Run after applying migrations to a disposable Supabase database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/schema_contract.sql

begin;

do $$
declare
  v_missing text;
begin
  select string_agg(expected.name, ', ' order by expected.name)
  into v_missing
  from (values
    ('ia_installation_state'), ('ia_migration_markers'), ('ia_workspaces'), ('ia_profiles'),
    ('ia_workspace_memberships'), ('ia_brands'), ('ia_locations'),
    ('ia_user_location_assignments'), ('ia_invitations'), ('ia_invitation_locations'),
    ('ia_products'), ('ia_location_import_aliases'), ('ia_product_import_aliases'),
    ('ia_import_batches'), ('ia_historical_sales'),
    ('ia_analysis_policy_revisions'), ('ia_workspace_analysis_state'),
    ('ia_forecast_runs'), ('ia_forecast_items'), ('ia_forecast_sources'),
    ('ia_forecast_item_sources'), ('ia_email_schedules'),
    ('ia_email_recipient_preferences'), ('ia_email_contacts'),
    ('ia_email_contact_locations'), ('ia_email_deliveries'),
    ('ia_email_delivery_locations'), ('ia_email_delivery_attempts'),
    ('ia_provider_connections'), ('ia_audit_events')
  ) as expected(name)
  where to_regclass('public.' || expected.name) is null;

  if v_missing is not null then
    raise exception 'missing public Inventory Auditor tables: %', v_missing;
  end if;
end;
$$;

do $$
begin
  if not has_table_privilege('authenticated', 'public.ia_location_import_aliases', 'SELECT')
     or not has_table_privilege('authenticated', 'public.ia_product_import_aliases', 'SELECT')
     or has_table_privilege('authenticated', 'public.ia_location_import_aliases', 'INSERT')
     or has_table_privilege('authenticated', 'public.ia_product_import_aliases', 'INSERT') then
    raise exception 'guided import aliases must be authenticated read-only tables';
  end if;
  if not has_table_privilege('service_role', 'public.ia_location_import_aliases', 'SELECT')
     or not has_table_privilege('service_role', 'public.ia_location_import_aliases', 'INSERT')
     or not has_table_privilege('service_role', 'public.ia_product_import_aliases', 'SELECT')
     or not has_table_privilege('service_role', 'public.ia_product_import_aliases', 'INSERT') then
    raise exception 'service_role needs explicit guided import alias privileges';
  end if;
  if not exists (
       select 1 from pg_policies as policy
       where policy.schemaname = 'public'
         and policy.tablename = 'ia_location_import_aliases'
         and policy.policyname = 'ia_location_import_aliases_select'
         and policy.cmd = 'SELECT'
         and 'authenticated'::name = any(policy.roles)
         and lower(policy.qual) like '%ia_current_workspace_role%'
         and lower(policy.qual) like '%super_admin%'
         and lower(policy.qual) like '%admin%'
     )
     or not exists (
       select 1 from pg_policies as policy
       where policy.schemaname = 'public'
         and policy.tablename = 'ia_product_import_aliases'
         and policy.policyname = 'ia_product_import_aliases_select'
         and policy.cmd = 'SELECT'
         and 'authenticated'::name = any(policy.roles)
         and lower(policy.qual) like '%ia_current_workspace_role%'
         and lower(policy.qual) like '%super_admin%'
         and lower(policy.qual) like '%admin%'
     ) then
    raise exception 'guided import alias admin read policies are missing';
  end if;
  if not exists (
       select 1 from pg_class as relation
       where relation.oid = 'public.ia_location_import_aliases'::regclass
         and relation.relrowsecurity and relation.relforcerowsecurity
     )
     or not exists (
       select 1 from pg_class as relation
       where relation.oid = 'public.ia_product_import_aliases'::regclass
         and relation.relrowsecurity and relation.relforcerowsecurity
     ) then
    raise exception 'guided import aliases require RLS and FORCE RLS';
  end if;
  if to_regclass('public.ia_location_import_aliases_location_fk_idx') is null
     or to_regclass('public.ia_product_import_aliases_product_fk_idx') is null
     or lower(pg_get_indexdef(
       'public.ia_location_import_aliases_location_fk_idx'::regclass
     )) not like '%(workspace_id, brand_id, location_id)%'
     or lower(pg_get_indexdef(
       'public.ia_product_import_aliases_product_fk_idx'::regclass
     )) not like '%(workspace_id, brand_id, product_id)%' then
    raise exception 'guided import alias foreign-key indexes are missing';
  end if;
  if not exists (
       select 1 from pg_constraint as con
       where con.conrelid = 'public.ia_location_import_aliases'::regclass
         and con.contype = 'f'
         and pg_get_constraintdef(con.oid)
           like 'FOREIGN KEY (workspace_id, brand_id, location_id)%'
     )
     or not exists (
       select 1 from pg_constraint as con
       where con.conrelid = 'public.ia_product_import_aliases'::regclass
         and con.contype = 'f'
         and pg_get_constraintdef(con.oid)
           like 'FOREIGN KEY (workspace_id, brand_id, product_id)%'
     ) then
    raise exception 'guided import alias target foreign keys are missing';
  end if;
  if not exists (
    select 1 from pg_constraint as con
    where con.conrelid = 'public.ia_import_batches'::regclass
      and con.conname = 'ia_import_batches_workspace_brand_source_sha256_key'
      and con.contype = 'u'
      and pg_get_constraintdef(con.oid)
        = 'UNIQUE (workspace_id, brand_id, source_sha256)'
  ) then
    raise exception 'import checksum uniqueness must be scoped to workspace and brand';
  end if;
end;
$$;

do $$
declare
  v_writable text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into v_writable
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where c.relkind = 'r' and n.nspname = 'public' and c.relname like 'ia_%'
    and (
      has_table_privilege('authenticated', c.oid, 'INSERT')
      or has_table_privilege('authenticated', c.oid, 'DELETE')
      or has_table_privilege('authenticated', c.oid, 'TRUNCATE')
      or (c.relname <> 'ia_profiles' and has_any_column_privilege('authenticated', c.oid, 'UPDATE'))
    );
  if v_writable is not null then
    raise exception 'authenticated has unsafe direct table mutations: %', v_writable;
  end if;
end;
$$;

do $$
declare
  v_bucket storage.buckets%rowtype;
begin
  if not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'ia_brands'
         and column_name = 'default_time_zone' and is_nullable = 'NO'
     )
     or not exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'ia_brands'
         and column_name = 'logo_object_path'
     ) then
    raise exception 'brand timezone or logo columns are missing';
  end if;

  select bucket.* into v_bucket from storage.buckets as bucket
  where bucket.id = 'brand-logos';
  if not found
     or not v_bucket.public
     or v_bucket.file_size_limit is distinct from 2097152
     or v_bucket.allowed_mime_types is null
     or not (
       v_bucket.allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp']::text[]
       and v_bucket.allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp']::text[]
     ) then
    raise exception 'brand logo bucket contract is not installed';
  end if;
  if exists (
    select 1 from pg_policies as policy
    where policy.schemaname = 'storage' and policy.tablename = 'objects'
      and policy.cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      and policy.roles && array['authenticated'::name, 'public'::name]
  ) then
    raise exception 'browser roles must not receive Storage object write policies';
  end if;
  if not exists (
    select 1 from pg_trigger as trigger
    where trigger.tgrelid = 'public.ia_locations'::regclass
      and trigger.tgname = 'ia_locations_guard_brand_state'
      and not trigger.tgisinternal
  ) then
    raise exception 'active location/brand trigger invariant is missing';
  end if;
end;
$$;

do $$
declare
  v_unprotected text;
begin
  select string_agg(n.nspname || '.' || c.relname, ', ' order by n.nspname, c.relname)
  into v_unprotected
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where c.relkind = 'r'
    and n.nspname in ('public', 'ia_private')
    and (c.relname like 'ia_%')
    and (not c.relrowsecurity or not c.relforcerowsecurity);

  if v_unprotected is not null then
    raise exception 'RLS/FORCE RLS missing on: %', v_unprotected;
  end if;
end;
$$;

do $$
declare
  v_anon_access text;
begin
  select string_agg(c.relname, ', ' order by c.relname)
  into v_anon_access
  from pg_class as c
  join pg_namespace as n on n.oid = c.relnamespace
  where c.relkind = 'r'
    and n.nspname = 'public'
    and c.relname like 'ia_%'
    and (
      has_table_privilege('anon', c.oid, 'SELECT')
      or has_table_privilege('anon', c.oid, 'INSERT')
      or has_table_privilege('anon', c.oid, 'UPDATE')
      or has_table_privilege('anon', c.oid, 'DELETE')
    );

  if v_anon_access is not null then
    raise exception 'anon unexpectedly has table access: %', v_anon_access;
  end if;
end;
$$;

do $$
begin
  if has_table_privilege('authenticated', 'ia_private.ia_provider_secrets', 'SELECT')
     or has_table_privilege('authenticated', 'ia_private.ia_provider_secrets', 'INSERT')
     or has_table_privilege('authenticated', 'ia_private.ia_provider_secrets', 'UPDATE') then
    raise exception 'authenticated must never access encrypted secret rows directly';
  end if;
  if to_regclass('ia_private.ia_owner_bootstrap_authorizations') is null
     or to_regclass('ia_private.ia_email_delivery_verifications') is null
     or to_regclass('ia_private.ia_scheduled_forecast_claims') is null then
    raise exception 'private bootstrap, email verification, or forecast claim ledger is missing';
  end if;
  if has_table_privilege('authenticated', 'ia_private.ia_owner_bootstrap_authorizations', 'SELECT')
     or has_table_privilege('authenticated', 'ia_private.ia_owner_bootstrap_authorizations', 'INSERT')
     or has_table_privilege('authenticated', 'ia_private.ia_email_delivery_verifications', 'SELECT')
     or has_table_privilege('authenticated', 'ia_private.ia_scheduled_forecast_claims', 'SELECT') then
    raise exception 'authenticated must never access private bootstrap, email verification, or forecast claim rows';
  end if;
  if not has_table_privilege('service_role', 'ia_private.ia_email_delivery_verifications', 'SELECT')
     or not has_table_privilege('service_role', 'ia_private.ia_email_delivery_verifications', 'INSERT')
     or not has_table_privilege('service_role', 'ia_private.ia_email_delivery_verifications', 'UPDATE')
     or not has_table_privilege('service_role', 'ia_private.ia_scheduled_forecast_claims', 'SELECT')
     or not has_table_privilege('service_role', 'ia_private.ia_scheduled_forecast_claims', 'INSERT')
     or not has_table_privilege('service_role', 'ia_private.ia_scheduled_forecast_claims', 'UPDATE') then
    raise exception 'service_role needs the private-table privileges required by invoker email and forecast RPCs';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_brands' and column_name = 'is_active'
      and is_generated = 'ALWAYS'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_locations' and column_name = 'is_active'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_user_location_assignments' and column_name = 'is_active'
  ) then
    raise exception 'brand, location, and assignment is_active contract is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_profiles' and column_name = 'email'
      and data_type = 'USER-DEFINED'
  ) then
    raise exception 'citext profile email contract is missing';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_profiles' and column_name = 'position_title'
  ) or not has_column_privilege('authenticated', 'public.ia_profiles', 'position_title', 'UPDATE')
     or has_column_privilege('authenticated', 'public.ia_profiles', 'email', 'UPDATE') then
    raise exception 'self-editable profile column privileges are incorrect';
  end if;
  if not has_table_privilege('service_role', 'public.ia_email_contacts', 'SELECT')
     or not has_table_privilege('service_role', 'public.ia_email_contacts', 'INSERT')
     or not has_table_privilege('service_role', 'public.ia_email_contacts', 'UPDATE')
     or not has_table_privilege('service_role', 'public.ia_email_contact_locations', 'SELECT') then
    raise exception 'service_role needs explicit email-contact privileges';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.ia_email_deliveries'::regclass
      and conname = 'ia_email_deliveries_one_recipient_check'
      and pg_get_constraintdef(oid) like '%num_nonnulls%'
  ) then
    raise exception 'email delivery must require exactly one recipient identity';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_email_deliveries'
      and column_name = 'current_attempt_id'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'ia_email_deliveries'
      and column_name = 'manual_dedupe_key'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'ia_private' and table_name = 'ia_scheduled_forecast_claims'
      and column_name = 'claim_token' and is_nullable = 'NO'
  ) then
    raise exception 'email and forecast attempt binding columns are missing';
  end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'ia_email_schedules'
      and indexname = 'ia_email_schedules_one_per_workspace_idx'
      and indexdef like 'CREATE UNIQUE INDEX%'
  ) then
    raise exception 'one email schedule per workspace must be database-enforced';
  end if;
end;
$$;

do $$
declare
  v_bad_definer text;
  v_preview_import_definition text;
  v_commit_import_definition text;
begin
  select string_agg(n.nspname || '.' || p.proname, ', ' order by n.nspname, p.proname)
  into v_bad_definer
  from pg_proc as p
  join pg_namespace as n on n.oid = p.pronamespace
  where n.nspname in ('public', 'ia_private')
    and p.proname like 'ia_%'
    and p.prosecdef
    and not (coalesce(array_to_string(p.proconfig, ','), '') like '%search_path%');

  if v_bad_definer is not null then
    raise exception 'SECURITY DEFINER function lacks fixed search_path: %', v_bad_definer;
  end if;

  if to_regprocedure('public.ia_preview_historical_import_v2(uuid,jsonb)') is null
     or to_regprocedure('public.ia_import_historical_sales_v2(uuid,text,text,jsonb)') is null then
    raise exception 'guided historical import v2 RPCs are missing';
  end if;
  v_preview_import_definition := lower(pg_get_functiondef(
    to_regprocedure('public.ia_preview_historical_import_v2(uuid,jsonb)')
  ));
  v_commit_import_definition := lower(pg_get_functiondef(
    to_regprocedure('public.ia_import_historical_sales_v2(uuid,text,text,jsonb)')
  ));
  if lower(pg_get_function_result(
       to_regprocedure('public.ia_import_historical_sales_v2(uuid,text,text,jsonb)')
     )) not like '%already_imported boolean%' then
    raise exception 'guided import commit must report checksum replays explicitly';
  end if;

  if exists (
       select 1
       from pg_proc as legacy
       join pg_namespace as legacy_namespace on legacy_namespace.oid = legacy.pronamespace
       where legacy_namespace.nspname = 'public'
         and legacy.proname = 'ia_bootstrap_workspace'
     )
     or has_function_privilege('anon', 'public.ia_accept_invitation(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_authorize_owner_bootstrap(uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_authorize_owner_bootstrap(uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_bootstrap_workspace(uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_bootstrap_workspace(uuid)', 'EXECUTE') then
    raise exception 'first-owner/invitation RPC execute grants are too broad';
  end if;

  if (select p.prosecdef from pg_proc p where p.oid = 'public.ia_historical_dashboard(text,date,uuid[])'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_forecast_input(uuid,date,date)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_get_provider_secret(uuid,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_activate_analysis_policy(uuid,uuid,text,text,text,integer,text,jsonb,text,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_mark_email_verified(uuid,uuid,uuid,text,text,text,uuid[])'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_email_verification_matches(uuid,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_claim_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_finish_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid,uuid,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_claim_manual_email_delivery(uuid,uuid,uuid,uuid,uuid,date,date,timestamp with time zone,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_finish_email_delivery(uuid,uuid,uuid,text,text,text)'::regprocedure)
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_set_brand_logo(uuid,uuid,uuid,text)'::regprocedure) then
    raise exception 'application data RPCs must remain SECURITY INVOKER';
  end if;

  if (select p.prosecdef from pg_proc p where p.oid = 'public.ia_create_brand(text,text,text)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_create_location(uuid,text,text,text,text,text,text,text,text)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_update_brand(uuid,text,text,text,boolean,timestamp with time zone)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_update_location(uuid,text,text,text,text,text,text,text,text,boolean,timestamp with time zone)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_authorize_owner_bootstrap(uuid,text,text,text,text,text)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_server_bootstrap_workspace(uuid)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_import_historical_sales(text,text,jsonb)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_preview_historical_import_v2(uuid,jsonb)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_import_historical_sales_v2(uuid,text,text,jsonb)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_save_email_schedule(uuid,text,boolean,text,smallint,time without time zone,text,text,text)'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_update_member(uuid,text,text,boolean,uuid[])'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_save_email_contact(uuid,uuid,text,text,boolean,uuid[])'::regprocedure) is distinct from true
     or (select p.prosecdef from pg_proc p where p.oid = 'public.ia_archive_email_contact(uuid)'::regprocedure) is distinct from true then
    raise exception 'authorized write RPCs must be SECURITY DEFINER after direct table mutations are revoked';
  end if;

  if not has_function_privilege('authenticated', 'public.ia_create_brand(text,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_create_location(uuid,text,text,text,text,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_update_brand(uuid,text,text,text,boolean,timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_update_location(uuid,text,text,text,text,text,text,text,text,boolean,timestamp with time zone)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_import_historical_sales(text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_preview_historical_import_v2(uuid,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_import_historical_sales_v2(uuid,text,text,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_save_email_schedule(uuid,text,boolean,text,smallint,time without time zone,text,text,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_update_member(uuid,text,text,boolean,uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_save_email_contact(uuid,uuid,text,text,boolean,uuid[])', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.ia_archive_email_contact(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_create_brand(text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_create_location(uuid,text,text,text,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_update_brand(uuid,text,text,text,boolean,timestamp with time zone)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_update_location(uuid,text,text,text,text,text,text,text,text,boolean,timestamp with time zone)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_preview_historical_import_v2(uuid,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_import_historical_sales_v2(uuid,text,text,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_save_email_contact(uuid,uuid,text,text,boolean,uuid[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_archive_email_contact(uuid)', 'EXECUTE') then
    raise exception 'authorized write RPC execute grants are incorrect';
  end if;

  if has_function_privilege('authenticated', 'public.ia_server_get_provider_secret(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_activate_analysis_policy(uuid,uuid,text,text,text,integer,text,jsonb,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_mark_email_verified(uuid,uuid,uuid,text,text,text,uuid[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_email_verification_matches(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_claim_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_finish_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_claim_manual_email_delivery(uuid,uuid,uuid,uuid,uuid,date,date,timestamp with time zone,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_finish_email_delivery(uuid,uuid,uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_server_set_brand_logo(uuid,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_get_provider_secret(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_activate_analysis_policy(uuid,uuid,text,text,text,integer,text,jsonb,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_mark_email_verified(uuid,uuid,uuid,text,text,text,uuid[])', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_email_verification_matches(uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_claim_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_finish_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid,uuid,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_claim_manual_email_delivery(uuid,uuid,uuid,uuid,uuid,date,date,timestamp with time zone,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_finish_email_delivery(uuid,uuid,uuid,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_server_set_brand_logo(uuid,uuid,uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'server-only RPCs must be service-role only';
  end if;

  if not has_function_privilege('service_role', 'public.ia_server_activate_analysis_policy(uuid,uuid,text,text,text,integer,text,jsonb,text,text,text)', 'EXECUTE') then
    raise exception 'service_role must be able to activate analysis policy revisions';
  end if;
  if not has_function_privilege('service_role', 'public.ia_preview_historical_import_v2(uuid,jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_import_historical_sales_v2(uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role must be able to run guided historical import RPCs';
  end if;
  if not has_function_privilege('service_role', 'public.ia_server_authorize_owner_bootstrap(uuid,text,text,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_bootstrap_workspace(uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_mark_email_verified(uuid,uuid,uuid,text,text,text,uuid[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_email_verification_matches(uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_claim_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_finish_scheduled_forecast(uuid,uuid,date,date,uuid,text,uuid,uuid,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_claim_manual_email_delivery(uuid,uuid,uuid,uuid,uuid,date,date,timestamp with time zone,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_finish_email_delivery(uuid,uuid,uuid,text,text,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_server_set_brand_logo(uuid,uuid,uuid,text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)', 'EXECUTE') then
    raise exception 'service_role must be able to run verified, idempotent scheduled email workflows';
  end if;

  if lower(pg_get_functiondef('public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)'::regprocedure)) not like '%last_tested_at = null%'
     or lower(pg_get_functiondef('public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)'::regprocedure)) not like '%last_test_result = null%'
     or lower(pg_get_functiondef('public.ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)'::regprocedure)) not like '%last_error_code = null%' then
    raise exception 'provider configuration saves must invalidate stale connection-test metadata';
  end if;
  if v_preview_import_definition not like '%transaction_timestamp() at time zone location.time_zone%'
     or v_preview_import_definition not like '%ia_has_location_access%'
     or v_commit_import_definition not like '%ia_preview_historical_import_v2%'
     or lower(pg_get_functiondef('public.ia_import_historical_sales(text,text,jsonb)'::regprocedure))
       not like '%ia_import_historical_sales_v2%' then
    raise exception 'historical imports must preserve local-date, assignment, preview, and compatibility guards';
  end if;
  if strpos(v_commit_import_definition, 'ia_history:') = 0
     or strpos(v_commit_import_definition, 'ia_history_v2_workspace_brand:')
       <= strpos(v_commit_import_definition, 'ia_history:')
     or strpos(v_commit_import_definition, 'ia_history_v2_checksum:')
       <= strpos(v_commit_import_definition, 'ia_history_v2_workspace_brand:')
     or v_commit_import_definition not like '%already_imported := true%'
     or v_commit_import_definition not like '%already_imported := false%' then
    raise exception 'guided import commit must lock workspace/brand/checksum in order and report replay state';
  end if;
  if lower(pg_get_functiondef('public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)'::regprocedure)) not like '%claim_token%'
     or lower(pg_get_functiondef('public.ia_store_forecast_result(uuid,jsonb,jsonb,jsonb)'::regprocedure)) not like '%ia_store_forecast_result_unchecked%'
     or lower(pg_get_functiondef('ia_private.ia_store_forecast_result_unchecked(jsonb,jsonb,jsonb)'::regprocedure)) not like '%history_watermark%'
     or lower(pg_get_functiondef('ia_private.ia_store_forecast_result_unchecked(jsonb,jsonb,jsonb)'::regprocedure)) not like '%forecast_run_id = v_run_id%' then
    raise exception 'forecast storage must atomically validate and complete its policy/history-bound claim';
  end if;
end;
$$;

do $$
begin
  if (select count(*) from public.ia_installation_state where singleton) <> 1 then
    raise exception 'installation singleton must contain exactly one row';
  end if;
  if (select count(*) from public.ia_migration_markers
      where migration_id in (
        '20260716210000_inventory_auditor',
        '20260716220000_email_delivery_verification',
        '20260716230000_email_contacts_and_profiles',
        '20260717010000_brand_location_management',
        '20260717203635_guided_history_import'
      )) <> 5 then
    raise exception 'all Inventory Auditor migration completion markers are required';
  end if;
end;
$$;

rollback;
