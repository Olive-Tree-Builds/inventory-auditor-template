-- Inventory Auditor: tenant-safe Supabase foundation.
-- One deployment owns one workspace. The workspace_id remains on every business
-- record so that authorization is explicit and a future migration is possible.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;

create schema if not exists ia_private;
revoke all on schema ia_private from public, anon, authenticated;

create type public.ia_membership_role as enum ('super_admin', 'admin', 'manager', 'viewer');
create type public.ia_membership_status as enum ('active', 'suspended');
create type public.ia_forecast_period as enum ('day', 'week', 'month', 'quarter', 'year');
create type public.ia_forecast_status as enum (
  'queued', 'running', 'complete', 'baseline_only', 'needs_review', 'policy_unavailable', 'failed'
);
create type public.ia_confidence as enum ('high', 'medium', 'low');
create type public.ia_delivery_status as enum ('queued', 'sending', 'sent', 'failed', 'skipped', 'cancelled');

create table public.ia_workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 120),
  slug extensions.citext not null unique check (slug::text ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  default_time_zone text not null check (length(btrim(default_time_zone)) between 1 and 100),
  status text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  email_sending_enabled boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (id, status)
);

create table public.ia_installation_state (
  singleton boolean primary key default true check (singleton),
  workspace_id uuid unique references public.ia_workspaces(id) on delete restrict,
  bootstrapped_by uuid references auth.users(id) on delete set null,
  bootstrapped_at timestamptz,
  created_at timestamptz not null default now(),
  check ((workspace_id is null) = (bootstrapped_at is null))
);

insert into public.ia_installation_state (singleton) values (true);

-- Setup health checks use these end-of-migration markers instead of assuming
-- that one early table proves an entire migration completed successfully.
create table public.ia_migration_markers (
  migration_id text primary key check (migration_id ~ '^[0-9]{14}_[a-z0-9_]+$'),
  applied_at timestamptz not null default now()
);

-- A verified OWNER_SETUP_SECRET is converted by the server into this short-lived
-- one-user authorization. Browser-controlled Auth metadata is never trusted for
-- first-owner creation.
create table ia_private.ia_owner_bootstrap_authorizations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_name text not null check (length(btrim(workspace_name)) between 2 and 120),
  workspace_slug text not null check (workspace_slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  default_time_zone text not null check (length(btrim(default_time_zone)) between 3 and 100),
  username text not null check (username ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  display_name text not null check (length(btrim(display_name)) between 2 and 100),
  authorized_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > authorized_at and expires_at <= authorized_at + interval '24 hours')
);

create table public.ia_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email extensions.citext not null unique,
  username extensions.citext not null unique check (username::text ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.ia_workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.ia_membership_role not null,
  status public.ia_membership_status not null default 'active',
  email_enabled boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  suspended_at timestamptz,
  unique (workspace_id, user_id),
  unique (workspace_id, id),
  check ((status = 'suspended') = (suspended_at is not null))
);

create table public.ia_brands (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  code extensions.citext not null check (code::text ~ '^[a-z0-9][a-z0-9_-]{1,39}$'),
  accent_color text check (accent_color is null or accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  archived_at timestamptz,
  is_active boolean generated always as (archived_at is null) stored,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, code),
  unique (workspace_id, name)
);

create table public.ia_locations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  import_code extensions.citext not null check (import_code::text ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  street_address text,
  city text not null check (length(btrim(city)) between 1 and 120),
  region text,
  country_code text not null check (country_code ~ '^[A-Z]{2}$'),
  postal_code text,
  time_zone text not null check (length(btrim(time_zone)) between 1 and 100),
  latitude numeric(9,6) check (latitude between -90 and 90),
  longitude numeric(9,6) check (longitude between -180 and 180),
  is_active boolean not null default true,
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, brand_id, id),
  unique (workspace_id, import_code),
  unique (workspace_id, brand_id, name),
  foreign key (workspace_id, brand_id)
    references public.ia_brands(workspace_id, id) on delete cascade,
  check (is_active = (archived_at is null))
);

create table public.ia_user_location_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  user_id uuid not null,
  location_id uuid not null,
  is_active boolean not null default true,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  unique (workspace_id, user_id, location_id),
  unique (workspace_id, id),
  foreign key (workspace_id, user_id)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete cascade,
  foreign key (workspace_id, location_id)
    references public.ia_locations(workspace_id, id) on delete cascade,
  check (is_active = (revoked_at is null))
);

create table public.ia_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  email extensions.citext not null,
  username extensions.citext not null check (username::text ~ '^[a-z0-9][a-z0-9._-]{2,39}$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  role public.ia_membership_role not null check (role <> 'super_admin'),
  email_enabled boolean not null default true,
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  expires_at timestamptz not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  revoked_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  unique (workspace_id, id),
  check (expires_at > created_at),
  check (not (accepted_at is not null and revoked_at is not null))
);

create unique index ia_invitations_one_open_email_idx
  on public.ia_invitations (workspace_id, email)
  where accepted_at is null and revoked_at is null;
create unique index ia_invitations_one_open_username_idx
  on public.ia_invitations (workspace_id, username)
  where accepted_at is null and revoked_at is null;

create table public.ia_invitation_locations (
  workspace_id uuid not null,
  invitation_id uuid not null,
  location_id uuid not null,
  primary key (workspace_id, invitation_id, location_id),
  foreign key (workspace_id, invitation_id)
    references public.ia_invitations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, location_id)
    references public.ia_locations(workspace_id, id) on delete cascade
);

create table public.ia_products (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  import_code extensions.citext not null check (import_code::text ~ '^[a-z0-9][a-z0-9_-]{1,79}$'),
  archived_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, brand_id, id),
  unique (workspace_id, brand_id, import_code),
  unique (workspace_id, brand_id, name),
  foreign key (workspace_id, brand_id)
    references public.ia_brands(workspace_id, id) on delete cascade
);

create table public.ia_import_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  source_filename text not null check (length(btrim(source_filename)) between 1 and 255),
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('uploaded', 'validated', 'committed', 'rejected')),
  duplicate_action text check (duplicate_action is null or duplicate_action in ('cancel', 'replace')),
  row_count integer not null default 0 check (row_count >= 0),
  valid_row_count integer not null default 0 check (valid_row_count >= 0 and valid_row_count <= row_count),
  error_count integer not null default 0 check (error_count >= 0),
  date_start date,
  date_end date,
  validation_summary jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_summary) = 'object'),
  uploaded_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  validated_at timestamptz,
  committed_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, brand_id, id),
  unique (workspace_id, source_sha256),
  foreign key (workspace_id, brand_id)
    references public.ia_brands(workspace_id, id) on delete restrict,
  check (date_start is null or date_end is null or date_start <= date_end)
);

create table public.ia_historical_sales (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  location_id uuid not null,
  product_id uuid not null,
  business_date date not null,
  quantity integer not null check (quantity >= 0),
  source_import_batch_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, location_id, product_id, business_date),
  foreign key (workspace_id, brand_id, location_id)
    references public.ia_locations(workspace_id, brand_id, id) on delete restrict,
  foreign key (workspace_id, brand_id, product_id)
    references public.ia_products(workspace_id, brand_id, id) on delete restrict,
  foreign key (workspace_id, brand_id, source_import_batch_id)
    references public.ia_import_batches(workspace_id, brand_id, id) on delete restrict
);

create table ia_private.ia_historical_sales_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  historical_sale_id uuid not null,
  action text not null check (action in ('update', 'delete')),
  prior_quantity integer not null check (prior_quantity >= 0),
  prior_import_batch_id uuid not null,
  replacement_quantity integer check (replacement_quantity is null or replacement_quantity >= 0),
  replacement_import_batch_id uuid,
  changed_by uuid,
  changed_at timestamptz not null default now()
);

create table public.ia_analysis_policy_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  policy_id text not null check (length(btrim(policy_id)) between 1 and 100),
  policy_version text not null check (policy_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  output_schema_version text not null check (length(btrim(output_schema_version)) between 1 and 30),
  active_variable_revision integer not null check (active_variable_revision >= 0),
  markdown_content text not null check (length(markdown_content) > 0),
  active_variables jsonb not null default '[]'::jsonb check (jsonb_typeof(active_variables) = 'array'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  repository_commit_sha text check (repository_commit_sha is null or repository_commit_sha ~ '^[0-9a-f]{40}$'),
  repository_blob_sha text check (repository_blob_sha is null or repository_blob_sha ~ '^[0-9a-f]{40}$'),
  prior_revision_id uuid,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, sha256),
  unique (workspace_id, policy_id, policy_version),
  foreign key (workspace_id, prior_revision_id)
    references public.ia_analysis_policy_revisions(workspace_id, id) on delete restrict
);

create table public.ia_workspace_analysis_state (
  workspace_id uuid primary key references public.ia_workspaces(id) on delete cascade,
  active_policy_revision_id uuid not null,
  updated_by uuid not null references auth.users(id) on delete restrict,
  updated_at timestamptz not null default now(),
  foreign key (workspace_id, active_policy_revision_id)
    references public.ia_analysis_policy_revisions(workspace_id, id) on delete restrict
);

create table public.ia_forecast_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  location_id uuid not null,
  policy_revision_id uuid not null,
  period_grouping public.ia_forecast_period not null,
  period_start date not null,
  period_end date not null,
  location_time_zone text not null,
  status public.ia_forecast_status not null default 'queued',
  run_source text not null default 'manual' check (run_source in ('manual', 'scheduled', 'email_test')),
  research_completed boolean not null default false,
  policy_id text not null,
  policy_version text not null,
  output_schema_version text not null,
  policy_sha256 text not null check (policy_sha256 ~ '^[0-9a-f]{64}$'),
  ai_provider text,
  ai_model text,
  provider_request_id text,
  baseline_method text,
  adjustment_method text,
  rounding_rule text,
  historical_start_date date,
  historical_end_date date,
  rows_used integer check (rows_used is null or rows_used >= 0),
  data_quality_issues jsonb not null default '[]'::jsonb check (jsonb_typeof(data_quality_issues) = 'array'),
  warnings jsonb not null default '[]'::jsonb check (jsonb_typeof(warnings) = 'array'),
  error_code text,
  error_summary text,
  initiated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  generated_at timestamptz,
  completed_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, brand_id, location_id, id),
  unique (workspace_id, location_id, id),
  foreign key (workspace_id, brand_id, location_id)
    references public.ia_locations(workspace_id, brand_id, id) on delete restrict,
  foreign key (workspace_id, policy_revision_id)
    references public.ia_analysis_policy_revisions(workspace_id, id) on delete restrict,
  check (period_start <= period_end),
  check (historical_start_date is null or historical_end_date is null or historical_start_date <= historical_end_date),
  check (not research_completed or status in ('complete', 'needs_review'))
);

create table public.ia_forecast_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  brand_id uuid not null,
  location_id uuid not null,
  forecast_run_id uuid not null,
  product_id uuid not null,
  baseline_quantity numeric(14,4) not null check (baseline_quantity >= 0),
  adjustments jsonb not null default '[]'::jsonb check (jsonb_typeof(adjustments) = 'array'),
  recommended_quantity integer not null check (recommended_quantity >= 0),
  confidence public.ia_confidence not null,
  explanation text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, forecast_run_id, id),
  unique (workspace_id, forecast_run_id, product_id),
  foreign key (workspace_id, brand_id, location_id, forecast_run_id)
    references public.ia_forecast_runs(workspace_id, brand_id, location_id, id) on delete cascade,
  foreign key (workspace_id, brand_id, product_id)
    references public.ia_products(workspace_id, brand_id, id) on delete restrict
);

create table public.ia_forecast_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  location_id uuid not null,
  forecast_run_id uuid not null,
  source_key text not null check (length(btrim(source_key)) between 1 and 80),
  title text not null,
  publisher text not null,
  url text not null check (url ~ '^https://'),
  published_or_updated_date date,
  accessed_at timestamptz not null,
  fact_used text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, forecast_run_id, id),
  unique (workspace_id, forecast_run_id, source_key),
  foreign key (workspace_id, location_id, forecast_run_id)
    references public.ia_forecast_runs(workspace_id, location_id, id) on delete cascade
);

create table public.ia_forecast_item_sources (
  workspace_id uuid not null,
  forecast_run_id uuid not null,
  forecast_item_id uuid not null,
  forecast_source_id uuid not null,
  primary key (workspace_id, forecast_run_id, forecast_item_id, forecast_source_id),
  foreign key (workspace_id, forecast_run_id, forecast_item_id)
    references public.ia_forecast_items(workspace_id, forecast_run_id, id) on delete cascade,
  foreign key (workspace_id, forecast_run_id, forecast_source_id)
    references public.ia_forecast_sources(workspace_id, forecast_run_id, id) on delete cascade
);

-- Private ledger used by service-only claim RPCs. The result write locks this
-- row and completes it atomically so stale policy/history can never leave a
-- deliverable forecast behind.
create table ia_private.ia_scheduled_forecast_claims (
  workspace_id uuid not null,
  location_id uuid not null,
  period_start date not null,
  period_end date not null,
  policy_revision_id uuid not null,
  history_watermark timestamptz,
  run_source text not null check (run_source in ('manual', 'scheduled', 'email_test')),
  actor_user_id uuid,
  forecast_run_id uuid,
  status text not null check (status in ('running', 'complete', 'failed')),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  failure_code text,
  primary key (workspace_id, location_id, period_start, period_end),
  foreign key (workspace_id, location_id)
    references public.ia_locations(workspace_id, id) on delete cascade,
  foreign key (workspace_id, policy_revision_id)
    references public.ia_analysis_policy_revisions(workspace_id, id) on delete restrict,
  foreign key (workspace_id, actor_user_id)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete cascade,
  foreign key (workspace_id, location_id, forecast_run_id)
    references public.ia_forecast_runs(workspace_id, location_id, id) on delete cascade,
  check (period_start <= period_end),
  check ((run_source = 'scheduled') = (actor_user_id is null)),
  check ((status = 'running') = (finished_at is null)),
  check ((status = 'complete') = (forecast_run_id is not null)),
  check ((status = 'failed') = (failure_code is not null))
);

create table public.ia_email_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  name text not null default 'Default forecast schedule',
  enabled boolean not null default false,
  cadence text not null default 'daily' check (cadence in ('daily', 'weekdays', 'weekly', 'custom')),
  weekday_mask smallint not null default 127 check (weekday_mask between 0 and 127),
  local_send_time time not null default time '05:00',
  timezone_rule text not null default 'earliest_assigned_location'
    check (timezone_rule in ('earliest_assigned_location', 'workspace', 'user_selected')),
  workspace_time_zone text,
  forecast_horizon text not null default 'today' check (forecast_horizon in ('today', 'tomorrow', 'next_7_days')),
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, name),
  check (timezone_rule <> 'workspace' or workspace_time_zone is not null)
);

create table public.ia_email_recipient_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  schedule_id uuid not null,
  user_id uuid not null,
  enabled boolean not null default true,
  time_zone_override text,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (workspace_id, schedule_id, user_id),
  foreign key (workspace_id, schedule_id)
    references public.ia_email_schedules(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete cascade
);

create table public.ia_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  schedule_id uuid not null,
  recipient_user_id uuid not null,
  forecast_period_start date not null,
  forecast_period_end date not null,
  due_at timestamptz not null,
  status public.ia_delivery_status not null default 'queued',
  idempotency_key text not null,
  provider_message_id text,
  failure_code text,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, idempotency_key),
  foreign key (workspace_id, schedule_id)
    references public.ia_email_schedules(workspace_id, id) on delete restrict,
  foreign key (workspace_id, recipient_user_id)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete restrict,
  check (forecast_period_start <= forecast_period_end),
  check ((status = 'sent') = (sent_at is not null))
);

create table public.ia_email_delivery_locations (
  workspace_id uuid not null,
  delivery_id uuid not null,
  location_id uuid not null,
  forecast_run_id uuid not null,
  primary key (workspace_id, delivery_id, location_id),
  foreign key (workspace_id, delivery_id)
    references public.ia_email_deliveries(workspace_id, id) on delete cascade,
  foreign key (workspace_id, location_id, forecast_run_id)
    references public.ia_forecast_runs(workspace_id, location_id, id) on delete restrict
);

create table public.ia_email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  delivery_id uuid not null,
  attempt_number smallint not null check (attempt_number > 0),
  status text not null check (status in ('started', 'sent', 'failed')),
  provider_message_id text,
  failure_code text,
  attempted_at timestamptz not null default now(),
  unique (workspace_id, delivery_id, attempt_number),
  foreign key (workspace_id, delivery_id)
    references public.ia_email_deliveries(workspace_id, id) on delete cascade
);

create table public.ia_provider_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  provider_kind text not null check (provider_kind in ('resend', 'ai', 'github')),
  provider_name text,
  base_url text,
  model_name text,
  sender_email text,
  repository_owner text,
  repository_name text,
  repository_branch text,
  status text not null default 'unconfigured' check (status in ('unconfigured', 'untested', 'connected', 'failing', 'disabled')),
  masked_hint text check (masked_hint is null or length(masked_hint) <= 16),
  secret_version integer not null default 0 check (secret_version >= 0),
  last_tested_at timestamptz,
  last_test_result text check (last_test_result is null or last_test_result in ('passed', 'failed')),
  last_error_code text,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, provider_kind)
);

create table ia_private.ia_provider_secrets (
  connection_id uuid not null,
  workspace_id uuid not null,
  secret_name text not null check (secret_name ~ '^[a-z][a-z0-9_]{1,79}$'),
  encrypted_value bytea not null,
  encryption_key_version integer not null check (encryption_key_version > 0),
  secret_fingerprint text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  primary key (workspace_id, connection_id, secret_name),
  foreign key (workspace_id, connection_id)
    references public.ia_provider_connections(workspace_id, id) on delete cascade,
  check (octet_length(encrypted_value) > 0)
);

create table public.ia_audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.ia_workspaces(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null check (length(btrim(event_type)) between 1 and 100),
  entity_type text not null check (length(btrim(entity_type)) between 1 and 80),
  entity_id uuid,
  outcome text not null check (outcome in ('success', 'denied', 'failed')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, id)
);

-- Mutable-row housekeeping and append-only guards. Only the history revision
-- trigger is SECURITY DEFINER, narrowly so an authorized invoker import can
-- append its private audit row without exposing that table.
create function ia_private.ia_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create function ia_private.ia_reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '55000';
end;
$$;

create function ia_private.ia_capture_historical_sale_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into ia_private.ia_historical_sales_revisions (
    workspace_id, historical_sale_id, action, prior_quantity, prior_import_batch_id,
    replacement_quantity, replacement_import_batch_id, changed_by
  ) values (
    old.workspace_id, old.id, lower(tg_op), old.quantity, old.source_import_batch_id,
    case when tg_op = 'UPDATE' then new.quantity end,
    case when tg_op = 'UPDATE' then new.source_import_batch_id end,
    auth.uid()
  );
  return case when tg_op = 'UPDATE' then new else old end;
end;
$$;

create function ia_private.ia_guard_last_super_admin()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_remaining integer;
begin
  if old.role = 'super_admin' and old.status = 'active'
     and (new.role <> 'super_admin' or new.status <> 'active') then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(old.workspace_id::text, 9173)
    );
    select count(*) into v_remaining
    from public.ia_workspace_memberships as membership
    where membership.workspace_id = old.workspace_id
      and membership.id <> old.id
      and membership.role = 'super_admin'
      and membership.status = 'active';
    if v_remaining < 1 then
      raise exception 'the final super admin cannot be demoted or suspended' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

-- Narrow SECURITY DEFINER RPC: direct table writes stay revoked. Parse/validation
-- happens in the application server first, then this function repeats the critical
-- identity, role, location, and type checks in one idempotent transaction.
create function public.ia_import_historical_sales(
  p_filename text,
  p_checksum text,
  p_rows jsonb
)
returns table (import_batch_id uuid, inserted_count integer, replaced_count integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_brand_id uuid;
  v_batch_id uuid;
  v_row_count integer;
  v_replaced integer;
  v_inserted integer;
  v_date_start date;
  v_date_end date;
begin
  select m.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as m
  where m.user_id = v_user_id and m.status = 'active'
  limit 1;

  if v_user_id is null
     or v_workspace_id is null
     or coalesce((select ia_private.ia_current_workspace_role(v_workspace_id))::text, '') not in ('super_admin', 'admin') then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ia_history:' || v_workspace_id::text, 41981)
  );
  if p_filename is null or length(btrim(p_filename)) not between 1 and 255 then
    raise exception 'invalid filename' using errcode = '22023';
  end if;
  if p_checksum is null or lower(p_checksum) !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid SHA-256 checksum' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(lower(p_checksum), 0));
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 100000 then
    raise exception 'rows must be a non-empty JSON array of at most 100000 items' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as item(value)
    where jsonb_typeof(item.value) <> 'object'
       or not (item.value ?& array['brand_id', 'location_id', 'product_name', 'business_date', 'quantity'])
       or (item.value - array['brand_id', 'location_id', 'product_name', 'business_date', 'quantity']::text[]) <> '{}'::jsonb
       or item.value ->> 'brand_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or item.value ->> 'location_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       or length(btrim(item.value ->> 'product_name')) not between 1 and 160
       or btrim(item.value ->> 'product_name') ~ '^[=+@-]'
       or item.value ->> 'business_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or item.value ->> 'quantity' !~ '^[0-9]+$'
       or (item.value ->> 'quantity')::numeric > 2147483647
  ) then
    raise exception 'one or more rows violate the import contract' using errcode = '22023';
  end if;

  with rows as (
    select
      r.brand_id::uuid as brand_id,
      r.location_id::uuid as location_id,
      btrim(r.product_name) as product_name,
      r.business_date::date as business_date,
      r.quantity::integer as quantity
    from jsonb_to_recordset(p_rows) as r(
      brand_id text, location_id text, product_name text, business_date text, quantity text
    )
  )
  select count(*), min(business_date), max(business_date)
    into v_row_count, v_date_start, v_date_end
  from rows;
  v_brand_id := (p_rows -> 0 ->> 'brand_id')::uuid;

  if exists (
    with rows as (
      select r.brand_id::uuid as brand_id, r.location_id::uuid as location_id,
        lower(btrim(r.product_name)) as product_name, r.business_date::date as business_date
      from jsonb_to_recordset(p_rows) as r(
        brand_id text, location_id text, product_name text, business_date text, quantity text
      )
    )
    select 1 from rows group by brand_id, location_id, product_name, business_date having count(*) > 1
  ) then
    raise exception 'duplicate product/location/date rows are not allowed in one import' using errcode = '23505';
  end if;

  if exists (
    with rows as (
      select r.brand_id::uuid as brand_id, r.location_id::uuid as location_id
      from jsonb_to_recordset(p_rows) as r(
        brand_id text, location_id text, product_name text, business_date text, quantity text
      )
    )
    select 1
    from rows
    left join public.ia_locations as l
      on l.workspace_id = v_workspace_id and l.brand_id = rows.brand_id and l.id = rows.location_id
    where l.id is null or not l.is_active
      or not (select ia_private.ia_has_location_access(v_workspace_id, rows.location_id))
  ) then
    raise exception 'row scope is invalid or includes an unassigned location' using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as row_data(
      brand_id text, location_id text, product_name text, business_date text, quantity text
    )
    join public.ia_locations as location
      on location.workspace_id = v_workspace_id
     and location.brand_id = row_data.brand_id::uuid
     and location.id = row_data.location_id::uuid
    where row_data.business_date::date
      > (pg_catalog.transaction_timestamp() at time zone location.time_zone)::date
  ) then
    raise exception 'historical sales cannot include a future local business date' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_rows) as r(brand_id text)
    where r.brand_id::uuid <> v_brand_id
  ) then
    raise exception 'one import batch must contain exactly one brand' using errcode = '23514';
  end if;

  select b.id,
    coalesce((b.validation_summary ->> 'inserted')::integer, b.row_count),
    coalesce((b.validation_summary ->> 'replaced')::integer, 0)
  into v_batch_id, v_inserted, v_replaced
  from public.ia_import_batches as b
  where b.workspace_id = v_workspace_id
    and b.source_sha256 = lower(p_checksum)
    and b.status = 'committed';

  if v_batch_id is not null then
    import_batch_id := v_batch_id;
    inserted_count := v_inserted;
    replaced_count := v_replaced;
    return next;
    return;
  end if;

  insert into public.ia_products (
    workspace_id, brand_id, name, import_code, created_by
  )
  select distinct v_workspace_id, r.brand_id::uuid, btrim(r.product_name),
    ('p_' || substr(encode(extensions.digest(lower(btrim(r.product_name)), 'sha256'), 'hex'), 1, 24))::extensions.citext,
    v_user_id
  from jsonb_to_recordset(p_rows) as r(
    brand_id text, location_id text, product_name text, business_date text, quantity text
  )
  on conflict (workspace_id, brand_id, import_code) do update
    set name = excluded.name;

  with rows as (
    select r.brand_id::uuid as brand_id, r.location_id::uuid as location_id,
      ('p_' || substr(encode(extensions.digest(lower(btrim(r.product_name)), 'sha256'), 'hex'), 1, 24))::extensions.citext as import_code,
      r.business_date::date as business_date
    from jsonb_to_recordset(p_rows) as r(
      brand_id text, location_id text, product_name text, business_date text, quantity text
    )
  )
  select count(*)::integer into v_replaced
  from rows
  join public.ia_products as p
    on p.workspace_id = v_workspace_id and p.brand_id = rows.brand_id and p.import_code = rows.import_code
  join public.ia_historical_sales as h
    on h.workspace_id = v_workspace_id
   and h.location_id = rows.location_id
   and h.product_id = p.id
   and h.business_date = rows.business_date;

  v_inserted := v_row_count - v_replaced;

  insert into public.ia_import_batches (
    workspace_id, brand_id, source_filename, source_sha256, status, duplicate_action,
    row_count, valid_row_count, error_count, date_start, date_end, validation_summary,
    uploaded_by, validated_at, committed_at
  ) values (
    v_workspace_id, v_brand_id, btrim(p_filename), lower(p_checksum), 'committed',
    case when v_replaced > 0 then 'replace' end,
    v_row_count, v_row_count, 0, v_date_start, v_date_end,
    jsonb_build_object('inserted', v_inserted, 'replaced', v_replaced),
    v_user_id, now(), now()
  ) returning id into v_batch_id;

  insert into public.ia_historical_sales (
    workspace_id, brand_id, location_id, product_id, business_date, quantity, source_import_batch_id
  )
  select v_workspace_id, r.brand_id::uuid, r.location_id::uuid, p.id,
    r.business_date::date, r.quantity::integer, v_batch_id
  from jsonb_to_recordset(p_rows) as r(
    brand_id text, location_id text, product_name text, business_date text, quantity text
  )
  join public.ia_products as p
    on p.workspace_id = v_workspace_id
   and p.brand_id = r.brand_id::uuid
   and p.import_code = ('p_' || substr(encode(extensions.digest(lower(btrim(r.product_name)), 'sha256'), 'hex'), 1, 24))::extensions.citext
  on conflict (workspace_id, location_id, product_id, business_date) do update
    set quantity = excluded.quantity,
        source_import_batch_id = excluded.source_import_batch_id;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'historical_import.committed', 'import_batch', v_batch_id,
    'success', jsonb_build_object('row_count', v_row_count, 'inserted', v_inserted, 'replaced', v_replaced)
  );

  import_batch_id := v_batch_id;
  inserted_count := v_inserted;
  replaced_count := v_replaced;
  return next;
end;
$$;

-- SECURITY INVOKER dashboard query. Every requested location must remain assigned
-- at query time; otherwise the whole request is denied without partial disclosure.
create function public.ia_historical_dashboard(
  p_period text,
  p_anchor date,
  p_location_ids uuid[]
)
returns table (
  location_id uuid,
  product_id uuid,
  product_name text,
  current_start date,
  current_end date,
  previous_start date,
  previous_end date,
  current_quantity bigint,
  previous_quantity bigint,
  change_percent numeric,
  series jsonb
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_current_start date;
  v_current_end date;
  v_previous_start date;
  v_previous_end date;
  v_bucket text;
begin
  select m.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as m
  where m.user_id = auth.uid() and m.status = 'active'
  limit 1;

  if auth.uid() is null or v_workspace_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_anchor is null or coalesce(cardinality(p_location_ids), 0) < 1 then
    raise exception 'anchor and at least one location are required' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_location_ids) as requested(id)
    where not (select ia_private.ia_has_location_access(v_workspace_id, requested.id))
  ) then
    raise exception 'location access denied' using errcode = '42501';
  end if;

  case lower(p_period)
    when 'day' then
      v_current_start := p_anchor; v_current_end := p_anchor;
      v_previous_start := p_anchor - 1; v_previous_end := p_anchor - 1; v_bucket := 'day';
    when 'week' then
      v_current_start := date_trunc('week', p_anchor::timestamp)::date;
      v_current_end := v_current_start + 6;
      v_previous_start := v_current_start - 7; v_previous_end := v_current_start - 1; v_bucket := 'day';
    when 'month' then
      v_current_start := date_trunc('month', p_anchor::timestamp)::date;
      v_current_end := (v_current_start + interval '1 month - 1 day')::date;
      v_previous_start := (v_current_start - interval '1 month')::date;
      v_previous_end := v_current_start - 1; v_bucket := 'day';
    when 'quarter' then
      v_current_start := date_trunc('quarter', p_anchor::timestamp)::date;
      v_current_end := (v_current_start + interval '3 months - 1 day')::date;
      v_previous_start := (v_current_start - interval '3 months')::date;
      v_previous_end := v_current_start - 1; v_bucket := 'month';
    when 'year' then
      v_current_start := date_trunc('year', p_anchor::timestamp)::date;
      v_current_end := (v_current_start + interval '1 year - 1 day')::date;
      v_previous_start := (v_current_start - interval '1 year')::date;
      v_previous_end := v_current_start - 1; v_bucket := 'month';
    else
      raise exception 'unsupported period' using errcode = '22023';
  end case;

  return query
  with totals as (
    select h.location_id, h.product_id,
      coalesce(sum(h.quantity) filter (
        where h.business_date between v_current_start and v_current_end
      ), 0)::bigint as current_qty,
      coalesce(sum(h.quantity) filter (
        where h.business_date between v_previous_start and v_previous_end
      ), 0)::bigint as previous_qty
    from public.ia_historical_sales as h
    where h.workspace_id = v_workspace_id
      and h.location_id = any(p_location_ids)
      and h.business_date between v_previous_start and v_current_end
    group by h.location_id, h.product_id
  )
  select t.location_id, t.product_id, p.name,
    v_current_start, v_current_end, v_previous_start, v_previous_end,
    t.current_qty, t.previous_qty,
    case when t.previous_qty = 0 then null
      else round(((t.current_qty - t.previous_qty)::numeric / t.previous_qty::numeric) * 100, 2)
    end,
    coalesce((
      select jsonb_agg(
        jsonb_build_object('date', bucketed.bucket_date, 'quantity', bucketed.quantity)
        order by bucketed.bucket_date
      )
      from (
        select date_trunc(v_bucket, h2.business_date::timestamp)::date as bucket_date,
          sum(h2.quantity)::bigint as quantity
        from public.ia_historical_sales as h2
        where h2.workspace_id = v_workspace_id
          and h2.location_id = t.location_id
          and h2.product_id = t.product_id
          and h2.business_date between v_current_start and v_current_end
        group by 1
      ) as bucketed
    ), '[]'::jsonb)
  from totals as t
  join public.ia_products as p
    on p.workspace_id = v_workspace_id and p.id = t.product_id
  order by p.name, t.location_id;
end;
$$;

create function public.ia_save_email_schedule(
  p_schedule_id uuid,
  p_name text,
  p_enabled boolean,
  p_cadence text,
  p_weekday_mask smallint,
  p_local_send_time time,
  p_timezone_rule text,
  p_workspace_time_zone text,
  p_forecast_horizon text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_schedule_id uuid;
  v_user_id uuid := auth.uid();
begin
  select m.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as m
  where m.user_id = v_user_id and m.status = 'active'
  limit 1;
  if v_user_id is null
     or coalesce((select ia_private.ia_current_workspace_role(v_workspace_id))::text, '') not in ('super_admin', 'admin') then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120
     or lower(coalesce(p_cadence, '')) not in ('daily', 'weekdays', 'weekly', 'custom')
     or p_weekday_mask is null or p_weekday_mask not between 0 and 127
     or p_local_send_time is null
     or lower(coalesce(p_timezone_rule, '')) not in ('earliest_assigned_location', 'workspace', 'user_selected')
     or lower(coalesce(p_forecast_horizon, '')) not in ('today', 'tomorrow', 'next_7_days')
     or (lower(coalesce(p_timezone_rule, '')) = 'workspace'
       and length(btrim(coalesce(p_workspace_time_zone, ''))) not between 1 and 100)
     or (nullif(btrim(coalesce(p_workspace_time_zone, '')), '') is not null and not exists (
       select 1 from pg_catalog.pg_timezone_names as zone
       where zone.name = btrim(p_workspace_time_zone)
     ))
     or (lower(coalesce(p_cadence, '')) = 'weekly'
       and length(replace((p_weekday_mask::integer)::bit(7)::text, '0', '')) <> 1)
     or (lower(coalesce(p_cadence, '')) = 'custom' and p_weekday_mask = 0) then
    raise exception 'invalid email schedule' using errcode = '22023';
  end if;
  if p_enabled and not exists (
    select 1 from public.ia_workspaces as w
    where w.id = v_workspace_id and w.email_sending_enabled and w.status = 'active'
  ) then
    raise exception 'email delivery must be verified before enabling a schedule' using errcode = '23514';
  end if;

  if p_schedule_id is null then
    insert into public.ia_email_schedules (
      workspace_id, name, enabled, cadence, weekday_mask, local_send_time,
      timezone_rule, workspace_time_zone, forecast_horizon, created_by
    ) values (
      v_workspace_id, btrim(p_name), p_enabled, lower(p_cadence), p_weekday_mask,
      p_local_send_time, lower(p_timezone_rule), nullif(btrim(p_workspace_time_zone), ''),
      lower(p_forecast_horizon), v_user_id
    ) returning id into v_schedule_id;
  else
    update public.ia_email_schedules
    set name = btrim(p_name), enabled = p_enabled, cadence = lower(p_cadence),
      weekday_mask = p_weekday_mask, local_send_time = p_local_send_time,
      timezone_rule = lower(p_timezone_rule),
      workspace_time_zone = nullif(btrim(p_workspace_time_zone), ''),
      forecast_horizon = lower(p_forecast_horizon)
    where workspace_id = v_workspace_id and id = p_schedule_id
    returning id into v_schedule_id;
    if v_schedule_id is null then
      raise exception 'schedule not found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome,
    metadata
  ) values (
    v_workspace_id, v_user_id, 'email_schedule.saved', 'email_schedule', v_schedule_id,
    'success', jsonb_build_object('enabled', p_enabled, 'cadence', lower(p_cadence))
  );
  return v_schedule_id;
end;
$$;

create trigger ia_workspaces_updated_at before update on public.ia_workspaces
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_profiles_updated_at before update on public.ia_profiles
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_memberships_updated_at before update on public.ia_workspace_memberships
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_memberships_keep_super_admin before update on public.ia_workspace_memberships
  for each row execute function ia_private.ia_guard_last_super_admin();
create trigger ia_brands_updated_at before update on public.ia_brands
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_locations_updated_at before update on public.ia_locations
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_products_updated_at before update on public.ia_products
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_history_updated_at before update on public.ia_historical_sales
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_schedules_updated_at before update on public.ia_email_schedules
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_connections_updated_at before update on public.ia_provider_connections
  for each row execute function ia_private.ia_set_updated_at();
create trigger ia_history_revision before update or delete on public.ia_historical_sales
  for each row execute function ia_private.ia_capture_historical_sale_revision();
create trigger ia_policy_revisions_immutable before update or delete on public.ia_analysis_policy_revisions
  for each row execute function ia_private.ia_reject_mutation();
create trigger ia_audit_events_immutable before update or delete on public.ia_audit_events
  for each row execute function ia_private.ia_reject_mutation();

-- These two narrowly scoped SECURITY DEFINER helpers avoid recursive RLS on the
-- membership/assignment tables. They are unexposed, bind only to auth.uid(),
-- reject anonymous identities, and have an empty search_path.
create function ia_private.ia_current_workspace_role(p_workspace_id uuid)
returns public.ia_membership_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.ia_workspace_memberships as m
  where m.workspace_id = p_workspace_id
    and m.user_id = auth.uid()
    and m.status = 'active'
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  limit 1
$$;

create function ia_private.ia_has_location_access(p_workspace_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid() is not null
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
    and exists (
      select 1
      from public.ia_workspace_memberships as m
      join public.ia_user_location_assignments as a
        on a.workspace_id = m.workspace_id and a.user_id = m.user_id
      where m.workspace_id = p_workspace_id
        and m.user_id = auth.uid()
        and m.status = 'active'
        and a.location_id = p_location_id
        and a.is_active
    )
$$;

-- Admin-only creation RPCs keep brand/location writes atomic and audited without
-- granting authenticated clients direct INSERT access to tenant tables.
create function public.ia_create_brand(p_name text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_brand public.ia_brands%rowtype;
  v_code text := lower(btrim(coalesce(p_code, '')));
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id and membership.status = 'active'
    and membership.role in ('super_admin', 'admin')
  limit 1;
  if v_workspace_id is null then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 2 and 120
     or v_code !~ '^[a-z0-9][a-z0-9_-]{1,23}$' then
    raise exception 'invalid brand' using errcode = '22023';
  end if;

  insert into public.ia_brands (workspace_id, name, code, created_by)
  values (v_workspace_id, btrim(p_name), v_code, v_user_id)
  returning * into v_brand;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'brand.created', 'brand', v_brand.id, 'success',
    jsonb_build_object('code', v_brand.code::text)
  );

  return jsonb_build_object(
    'id', v_brand.id,
    'name', v_brand.name,
    'code', v_brand.code::text,
    'is_active', v_brand.is_active
  );
end;
$$;

create function public.ia_create_location(
  p_brand_id uuid,
  p_name text,
  p_import_code text,
  p_street_address text,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country_code text,
  p_time_zone text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_location public.ia_locations%rowtype;
  v_import_code text := lower(btrim(coalesce(p_import_code, '')));
  v_country_code text := upper(btrim(coalesce(p_country_code, '')));
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id and membership.status = 'active'
    and membership.role in ('super_admin', 'admin')
  limit 1;
  if v_workspace_id is null then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if p_brand_id is null
     or length(btrim(coalesce(p_name, ''))) not between 2 and 120
     or v_import_code !~ '^[a-z0-9][a-z0-9_-]{1,23}$'
     or length(btrim(coalesce(p_street_address, ''))) not between 2 and 160
     or length(btrim(coalesce(p_city, ''))) not between 2 and 100
     or length(btrim(coalesce(p_region, ''))) not between 2 and 100
     or length(btrim(coalesce(p_postal_code, ''))) not between 2 and 20
     or v_country_code !~ '^[A-Z]{2}$'
     or length(btrim(coalesce(p_time_zone, ''))) not between 3 and 80
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as zone
       where zone.name = btrim(p_time_zone)
     ) then
    raise exception 'invalid location' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.ia_brands as brand
    where brand.workspace_id = v_workspace_id and brand.id = p_brand_id
      and brand.archived_at is null
  ) then
    raise exception 'brand not found' using errcode = 'P0002';
  end if;

  insert into public.ia_locations (
    workspace_id, brand_id, name, import_code, street_address, city, region,
    country_code, postal_code, time_zone, created_by
  ) values (
    v_workspace_id, p_brand_id, btrim(p_name), v_import_code,
    btrim(p_street_address), btrim(p_city), btrim(p_region), v_country_code,
    btrim(p_postal_code), btrim(p_time_zone), v_user_id
  ) returning * into v_location;

  insert into public.ia_user_location_assignments (
    workspace_id, user_id, location_id, is_active, assigned_by, assigned_at
  ) values (
    v_workspace_id, v_user_id, v_location.id, true, v_user_id, now()
  )
  on conflict (workspace_id, user_id, location_id) do update
    set is_active = true, assigned_by = excluded.assigned_by,
        assigned_at = now(), revoked_by = null, revoked_at = null;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'location.created', 'location', v_location.id, 'success',
    jsonb_build_object('brand_id', p_brand_id, 'import_code', v_location.import_code::text)
  );

  return jsonb_build_object(
    'id', v_location.id,
    'brand_id', v_location.brand_id,
    'name', v_location.name,
    'import_code', v_location.import_code::text,
    'street_address', v_location.street_address,
    'city', v_location.city,
    'region', v_location.region,
    'country_code', v_location.country_code,
    'postal_code', v_location.postal_code,
    'time_zone', v_location.time_zone,
    'is_active', v_location.is_active
  );
end;
$$;

-- Service-only handoff from OWNER_SETUP_SECRET verification to confirmed-email
-- bootstrap. The browser cannot mint this authorization through user_metadata.
create function public.ia_server_authorize_owner_bootstrap(
  p_user_id uuid,
  p_workspace_name text,
  p_workspace_slug text,
  p_default_time_zone text,
  p_username text,
  p_display_name text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_workspace uuid;
  v_authorized_at timestamptz := now();
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select state.workspace_id into v_existing_workspace
  from public.ia_installation_state as state
  where state.singleton
  for update;
  if not found or v_existing_workspace is not null then
    raise exception 'workspace setup is already complete' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (
    select 1 from auth.users as auth_user
    where auth_user.id = p_user_id
      and auth_user.email is not null
      and not coalesce(auth_user.is_anonymous, false)
  ) then
    raise exception 'permanent email user required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_workspace_name, ''))) not between 2 and 120
     or lower(btrim(coalesce(p_workspace_slug, ''))) !~ '^[a-z0-9][a-z0-9-]{1,62}$'
     or length(btrim(coalesce(p_default_time_zone, ''))) not between 3 and 100
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as zone
       where zone.name = btrim(p_default_time_zone)
     )
     or lower(btrim(coalesce(p_username, ''))) !~ '^[a-z0-9][a-z0-9._-]{2,39}$'
     or length(btrim(coalesce(p_display_name, ''))) not between 2 and 100 then
    raise exception 'invalid owner bootstrap authorization' using errcode = '22023';
  end if;

  delete from ia_private.ia_owner_bootstrap_authorizations
  where expires_at <= v_authorized_at;

  insert into ia_private.ia_owner_bootstrap_authorizations (
    user_id, workspace_name, workspace_slug, default_time_zone, username,
    display_name, authorized_at, expires_at
  ) values (
    p_user_id, btrim(p_workspace_name), lower(btrim(p_workspace_slug)),
    btrim(p_default_time_zone), lower(btrim(p_username)), btrim(p_display_name),
    v_authorized_at, v_authorized_at + interval '24 hours'
  )
  on conflict (user_id) do update
    set workspace_name = excluded.workspace_name,
        workspace_slug = excluded.workspace_slug,
        default_time_zone = excluded.default_time_zone,
        username = excluded.username,
        display_name = excluded.display_name,
        authorized_at = excluded.authorized_at,
        expires_at = excluded.expires_at;
end;
$$;

create function public.ia_server_bootstrap_workspace(p_user_id uuid)
returns table (workspace_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_workspace uuid;
  v_workspace_id uuid;
  v_membership_id uuid;
  v_auth_email extensions.citext;
  v_email_confirmed_at timestamptz;
  v_is_anonymous boolean;
  v_authorization ia_private.ia_owner_bootstrap_authorizations%rowtype;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;

  select state.workspace_id into v_existing_workspace
  from public.ia_installation_state as state
  where state.singleton
  for update;
  if not found or v_existing_workspace is not null then
    raise exception 'workspace setup is already complete' using errcode = '42501';
  end if;

  select auth_user.email::extensions.citext, auth_user.email_confirmed_at,
    coalesce(auth_user.is_anonymous, false)
  into v_auth_email, v_email_confirmed_at, v_is_anonymous
  from auth.users as auth_user
  where auth_user.id = p_user_id;
  if not found or v_auth_email is null or v_email_confirmed_at is null or v_is_anonymous then
    raise exception 'confirmed permanent email user required' using errcode = '42501';
  end if;

  select authorization.* into v_authorization
  from ia_private.ia_owner_bootstrap_authorizations as authorization
  where authorization.user_id = p_user_id
  for update;
  if not found or v_authorization.expires_at <= now() then
    raise exception 'owner bootstrap authorization is missing or expired' using errcode = '42501';
  end if;

  insert into public.ia_workspaces (name, slug, default_time_zone, created_by)
  values (
    v_authorization.workspace_name, v_authorization.workspace_slug,
    v_authorization.default_time_zone, p_user_id
  )
  returning id into v_workspace_id;

  insert into public.ia_profiles (user_id, email, username, display_name)
  values (p_user_id, v_auth_email, v_authorization.username, v_authorization.display_name);

  insert into public.ia_workspace_memberships (
    workspace_id, user_id, role, status, email_enabled, created_by
  ) values (
    v_workspace_id, p_user_id, 'super_admin', 'active', true, p_user_id
  ) returning id into v_membership_id;

  update public.ia_installation_state
  set workspace_id = v_workspace_id, bootstrapped_by = p_user_id, bootstrapped_at = now()
  where singleton;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, p_user_id, 'workspace.bootstrapped', 'workspace', v_workspace_id,
    'success', jsonb_build_object('authorization_ttl_hours', 24)
  );

  delete from ia_private.ia_owner_bootstrap_authorizations;

  workspace_id := v_workspace_id;
  membership_id := v_membership_id;
  return next;
end;
$$;

-- Invitation acceptance is atomic and bound to both the current auth identity
-- and the invitation email. Only the token hash is stored.
create function public.ia_accept_invitation(p_token text)
returns table (workspace_id uuid, membership_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_auth_email extensions.citext;
  v_invitation public.ia_invitations%rowtype;
  v_membership_id uuid;
  v_location_count integer;
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  if p_token is null or length(p_token) < 32 then
    raise exception 'invalid invitation' using errcode = '22023';
  end if;

  select u.email::extensions.citext into v_auth_email
  from auth.users as u where u.id = v_user_id;

  select i.* into v_invitation
  from public.ia_invitations as i
  where i.token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if not found
     or v_invitation.accepted_at is not null
     or v_invitation.revoked_at is not null
     or v_invitation.expires_at <= now()
     or v_auth_email is null
     or v_auth_email <> v_invitation.email then
    raise exception 'invitation is invalid or expired' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.ia_installation_state as s
    where s.singleton and s.workspace_id = v_invitation.workspace_id
  ) then
    raise exception 'invitation workspace is not active' using errcode = '42501';
  end if;

  select count(*) into v_location_count
  from public.ia_invitation_locations as il
  join public.ia_locations as l
    on l.workspace_id = il.workspace_id and l.id = il.location_id
  where il.workspace_id = v_invitation.workspace_id
    and il.invitation_id = v_invitation.id
    and l.is_active;

  if v_location_count < 1 then
    raise exception 'at least one active location assignment is required' using errcode = '23514';
  end if;

  insert into public.ia_profiles (user_id, email, username, display_name)
  values (v_user_id, v_auth_email, v_invitation.username, v_invitation.display_name)
  on conflict (user_id) do update
    set email = excluded.email, username = excluded.username, display_name = excluded.display_name;

  insert into public.ia_workspace_memberships (
    workspace_id, user_id, role, status, email_enabled, created_by
  ) values (
    v_invitation.workspace_id, v_user_id, v_invitation.role, 'active',
    v_invitation.email_enabled, v_invitation.created_by
  ) returning id into v_membership_id;

  insert into public.ia_user_location_assignments (
    workspace_id, user_id, location_id, assigned_by
  )
  select il.workspace_id, v_user_id, il.location_id, v_invitation.created_by
  from public.ia_invitation_locations as il
  join public.ia_locations as l
    on l.workspace_id = il.workspace_id and l.id = il.location_id
  where il.workspace_id = v_invitation.workspace_id
    and il.invitation_id = v_invitation.id
    and l.is_active;

  update public.ia_invitations
  set accepted_by = v_user_id, accepted_at = now()
  where id = v_invitation.id;

  workspace_id := v_invitation.workspace_id;
  membership_id := v_membership_id;
  return next;
end;
$$;

create function public.ia_update_member(
  p_membership_id uuid,
  p_role text,
  p_status text,
  p_email_enabled boolean,
  p_location_ids uuid[]
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_target public.ia_workspace_memberships%rowtype;
  v_caller_role public.ia_membership_role;
  v_new_role public.ia_membership_role;
  v_new_status public.ia_membership_status;
begin
  select m.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as m
  where m.user_id = v_user_id and m.status = 'active'
  limit 1;
  v_caller_role := ia_private.ia_current_workspace_role(v_workspace_id);
  if v_workspace_id is null or coalesce(v_caller_role::text, '') not in ('super_admin', 'admin') then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;

  select membership.* into v_target
  from public.ia_workspace_memberships as membership
  where membership.workspace_id = v_workspace_id and membership.id = p_membership_id
  for update;
  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;

  v_new_role := lower(p_role)::public.ia_membership_role;
  v_new_status := lower(p_status)::public.ia_membership_status;
  if v_caller_role = 'admin'
     and (v_target.role not in ('manager', 'viewer') or v_new_role not in ('manager', 'viewer')) then
    raise exception 'admins cannot manage admin or super-admin roles' using errcode = '42501';
  end if;

  if v_new_status = 'active' then
    if coalesce(cardinality(p_location_ids), 0) < 1 then
      raise exception 'an active member requires at least one location' using errcode = '23514';
    end if;
    if exists (
      select 1 from unnest(p_location_ids) as requested(id)
      where not exists (
        select 1 from public.ia_locations as location
        where location.workspace_id = v_workspace_id
          and location.id = requested.id and location.is_active
      )
    ) then
      raise exception 'one or more locations are invalid or inactive' using errcode = '42501';
    end if;

    insert into public.ia_user_location_assignments (
      workspace_id, user_id, location_id, is_active, assigned_by, assigned_at
    )
    select v_workspace_id, v_target.user_id, requested.id, true, v_user_id, now()
    from (select distinct id from unnest(p_location_ids) as input(id)) as requested
    on conflict (workspace_id, user_id, location_id) do update
      set is_active = true, assigned_by = excluded.assigned_by,
          assigned_at = now(), revoked_by = null, revoked_at = null;

    update public.ia_user_location_assignments as assignment
    set is_active = false, revoked_by = v_user_id, revoked_at = now()
    where assignment.workspace_id = v_workspace_id
      and assignment.user_id = v_target.user_id
      and assignment.is_active
      and not (assignment.location_id = any(p_location_ids));
  end if;

  update public.ia_workspace_memberships
  set role = v_new_role,
      status = v_new_status,
      email_enabled = case when v_new_status = 'active' then coalesce(p_email_enabled, false) else false end,
      suspended_at = case when v_new_status = 'suspended' then now() else null end
  where workspace_id = v_workspace_id and id = p_membership_id;

  if v_new_status = 'suspended' then
    update public.ia_user_location_assignments as assignment
    set is_active = false, revoked_by = v_user_id, revoked_at = now()
    where assignment.workspace_id = v_workspace_id
      and assignment.user_id = v_target.user_id and assignment.is_active;
  end if;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'member.updated', 'workspace_membership', p_membership_id,
    'success', jsonb_build_object(
      'role', v_new_role, 'status', v_new_status,
      'email_enabled', case when v_new_status = 'active' then coalesce(p_email_enabled, false) else false end,
      'location_count', case when v_new_status = 'active' then cardinality(p_location_ids) else 0 end
    )
  );
  return p_membership_id;
end;
$$;

-- Service-role-only secret envelope access. ia_private remains outside the Data
-- API; these invoker RPCs expose only ciphertext and key version to the server.
create function public.ia_server_get_provider_secret(
  p_workspace_id uuid,
  p_provider_kind text,
  p_secret_name text
)
returns table (encrypted_value bytea, encryption_key_version integer)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_installation_state as s
    where s.singleton and s.workspace_id = p_workspace_id
  ) then
    raise exception 'workspace scope denied' using errcode = '42501';
  end if;

  return query
  select secret.encrypted_value, secret.encryption_key_version
  from public.ia_provider_connections as connection
  join ia_private.ia_provider_secrets as secret
    on secret.workspace_id = connection.workspace_id and secret.connection_id = connection.id
  where connection.workspace_id = p_workspace_id
    and connection.provider_kind = lower(p_provider_kind)
    and secret.secret_name = lower(p_secret_name)
  limit 1;
end;
$$;

create function public.ia_server_save_provider_connection(
  p_workspace_id uuid,
  p_provider_kind text,
  p_provider_name text,
  p_base_url text,
  p_model_name text,
  p_sender_email text,
  p_repository_owner text,
  p_repository_name text,
  p_repository_branch text,
  p_status text,
  p_secret_name text,
  p_encrypted_value bytea,
  p_encryption_key_version integer,
  p_masked_hint text,
  p_secret_fingerprint text,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection_id uuid;
  v_kind text := lower(btrim(p_provider_kind));
  v_status text := lower(btrim(p_status));
  v_has_secret boolean;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_installation_state as s
    where s.singleton and s.workspace_id = p_workspace_id
  ) then
    raise exception 'workspace scope denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_workspace_memberships as membership
    where membership.workspace_id = p_workspace_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and membership.role in ('super_admin', 'admin')
  ) then
    raise exception 'active administrator audit actor required' using errcode = '42501';
  end if;
  if v_kind not in ('resend', 'ai', 'github')
     or v_status not in ('unconfigured', 'untested', 'connected', 'failing', 'disabled')
     or (p_base_url is not null and btrim(p_base_url) !~ '^https://') then
    raise exception 'invalid provider metadata' using errcode = '22023';
  end if;
  if v_kind = 'ai'
     and (coalesce(btrim(p_provider_name), '') = '' or coalesce(btrim(p_model_name), '') = '') then
    raise exception 'AI provider and model are required' using errcode = '23514';
  elsif v_kind = 'resend'
     and coalesce(lower(btrim(p_sender_email)), '') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'verified sender email is required' using errcode = '23514';
  elsif v_kind = 'github'
     and (
       coalesce(btrim(p_repository_owner), '') = ''
       or coalesce(btrim(p_repository_name), '') = ''
       or btrim(p_repository_branch) <> 'trunk'
     ) then
    raise exception 'GitHub owner, repository, and trunk branch are required' using errcode = '23514';
  end if;

  v_has_secret := p_secret_name is not null
    or p_encrypted_value is not null
    or p_encryption_key_version is not null
    or p_masked_hint is not null
    or p_secret_fingerprint is not null;
  if v_has_secret and (
    lower(coalesce(p_secret_name, '')) !~ '^[a-z][a-z0-9_]{1,79}$'
    or p_encrypted_value is null or octet_length(p_encrypted_value) < 1
    or p_encryption_key_version is null or p_encryption_key_version < 1
    or coalesce(btrim(p_masked_hint), '') = '' or length(p_masked_hint) > 16
    or coalesce(btrim(p_secret_fingerprint), '') = ''
  ) then
    raise exception 'provider secret envelope must be complete' using errcode = '22023';
  end if;

  insert into public.ia_provider_connections (
    workspace_id, provider_kind, provider_name, base_url, model_name, sender_email,
    repository_owner, repository_name, repository_branch, status, masked_hint,
    secret_version, updated_by
  ) values (
    p_workspace_id, v_kind, nullif(btrim(p_provider_name), ''), nullif(btrim(p_base_url), ''),
    nullif(btrim(p_model_name), ''), nullif(lower(btrim(p_sender_email)), ''),
    nullif(btrim(p_repository_owner), ''), nullif(btrim(p_repository_name), ''),
    nullif(btrim(p_repository_branch), ''),
    case when v_has_secret then 'untested' else v_status end,
    case when v_has_secret then btrim(p_masked_hint) end,
    case when v_has_secret then 1 else 0 end, p_actor_user_id
  )
  on conflict (workspace_id, provider_kind) do update
    set provider_name = excluded.provider_name,
        base_url = excluded.base_url,
        model_name = excluded.model_name,
        sender_email = excluded.sender_email,
        repository_owner = excluded.repository_owner,
        repository_name = excluded.repository_name,
        repository_branch = excluded.repository_branch,
        status = excluded.status,
        masked_hint = case when v_has_secret then excluded.masked_hint
          else public.ia_provider_connections.masked_hint end,
        secret_version = public.ia_provider_connections.secret_version
          + case when v_has_secret then 1 else 0 end,
        last_tested_at = null,
        last_test_result = null,
        last_error_code = null,
        updated_by = p_actor_user_id,
        updated_at = now()
  returning id into v_connection_id;

  if v_has_secret then
    insert into ia_private.ia_provider_secrets (
      workspace_id, connection_id, secret_name, encrypted_value,
      encryption_key_version, secret_fingerprint, rotated_at
    ) values (
      p_workspace_id, v_connection_id, lower(p_secret_name), p_encrypted_value,
      p_encryption_key_version, p_secret_fingerprint, now()
    )
    on conflict (workspace_id, connection_id, secret_name) do update
      set encrypted_value = excluded.encrypted_value,
          encryption_key_version = excluded.encryption_key_version,
          secret_fingerprint = excluded.secret_fingerprint,
          rotated_at = now();
  elsif v_status = 'connected' and not exists (
    select 1 from ia_private.ia_provider_secrets as secret
    where secret.workspace_id = p_workspace_id and secret.connection_id = v_connection_id
  ) then
    raise exception 'a connection cannot be marked connected without a saved secret' using errcode = '23514';
  end if;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    p_workspace_id, p_actor_user_id, 'provider_connection.saved', 'provider_connection',
    v_connection_id, 'success', jsonb_build_object(
      'provider_kind', v_kind, 'secret_rotated', v_has_secret,
      'secret_name', case when v_has_secret then lower(p_secret_name) end,
      'status', case when v_has_secret then 'untested' else v_status end
    )
  );
  return v_connection_id;
end;
$$;

-- Only the trusted application server may persist and activate the repository
-- analysis policy. Revisions are append-only and content-addressed by a
-- host-computed SHA-256; activating the same content again reuses its revision.
create function public.ia_server_activate_analysis_policy(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_policy_id text,
  p_policy_version text,
  p_output_schema_version text,
  p_active_variable_revision integer,
  p_markdown_content text,
  p_active_variables jsonb,
  p_sha256 text,
  p_repository_commit_sha text,
  p_repository_blob_sha text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_revision_id uuid;
  v_prior_revision_id uuid;
  v_existing public.ia_analysis_policy_revisions%rowtype;
  v_sha256 text := lower(btrim(p_sha256));
  v_repository_commit_sha text := nullif(lower(btrim(p_repository_commit_sha)), '');
  v_repository_blob_sha text := nullif(lower(btrim(p_repository_blob_sha)), '');
  v_reused boolean := false;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_installation_state as state
    where state.singleton and state.workspace_id = p_workspace_id
  ) then
    raise exception 'workspace scope denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_workspace_memberships as membership
    where membership.workspace_id = p_workspace_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and membership.role in ('super_admin', 'admin')
  ) then
    raise exception 'active administrator audit actor required' using errcode = '42501';
  end if;

  if p_policy_id is null or length(btrim(p_policy_id)) not between 1 and 100
     or p_policy_version is null or btrim(p_policy_version) !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     or p_output_schema_version is null
     or length(btrim(p_output_schema_version)) not between 1 and 30
     or p_active_variable_revision is null or p_active_variable_revision < 0
     or p_markdown_content is null or length(p_markdown_content) < 1
     or p_active_variables is null or jsonb_typeof(p_active_variables) <> 'array'
     or p_sha256 is null
     or v_sha256 !~ '^[0-9a-f]{64}$'
     or (v_repository_commit_sha is not null and v_repository_commit_sha !~ '^[0-9a-f]{40}$')
     or (v_repository_blob_sha is not null and v_repository_blob_sha !~ '^[0-9a-f]{40}$') then
    raise exception 'invalid analysis policy metadata' using errcode = '22023';
  end if;
  if encode(extensions.digest(convert_to(p_markdown_content, 'UTF8'), 'sha256'), 'hex') <> v_sha256 then
    raise exception 'analysis policy SHA-256 does not match markdown content' using errcode = '22023';
  end if;

  -- Serialize activation per workspace so prior_revision_id forms one clear
  -- chain even when two server requests arrive concurrently.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('analysis-policy:' || p_workspace_id::text, 0)
  );

  select revision.* into v_existing
  from public.ia_analysis_policy_revisions as revision
  where revision.workspace_id = p_workspace_id and revision.sha256 = v_sha256;

  if found then
    if v_existing.policy_id <> btrim(p_policy_id)
       or v_existing.policy_version <> btrim(p_policy_version)
       or v_existing.output_schema_version <> btrim(p_output_schema_version)
       or v_existing.active_variable_revision <> p_active_variable_revision
       or v_existing.markdown_content <> p_markdown_content
       or v_existing.active_variables <> p_active_variables
       or (
         v_existing.repository_blob_sha is not null
         and v_repository_blob_sha is not null
         and v_existing.repository_blob_sha <> v_repository_blob_sha
       ) then
      raise exception 'analysis policy checksum already exists with different content metadata'
        using errcode = '23505';
    end if;
    v_revision_id := v_existing.id;
    v_reused := true;
  else
    select state.active_policy_revision_id into v_prior_revision_id
    from public.ia_workspace_analysis_state as state
    where state.workspace_id = p_workspace_id;

    insert into public.ia_analysis_policy_revisions (
      workspace_id, policy_id, policy_version, output_schema_version,
      active_variable_revision, markdown_content, active_variables, sha256,
      repository_commit_sha, repository_blob_sha, prior_revision_id, created_by
    ) values (
      p_workspace_id, btrim(p_policy_id), btrim(p_policy_version),
      btrim(p_output_schema_version), p_active_variable_revision,
      p_markdown_content, p_active_variables, v_sha256,
      v_repository_commit_sha, v_repository_blob_sha, v_prior_revision_id,
      p_actor_user_id
    ) returning id into v_revision_id;
  end if;

  insert into public.ia_workspace_analysis_state (
    workspace_id, active_policy_revision_id, updated_by, updated_at
  ) values (
    p_workspace_id, v_revision_id, p_actor_user_id, now()
  )
  on conflict (workspace_id) do update
    set active_policy_revision_id = excluded.active_policy_revision_id,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    p_workspace_id, p_actor_user_id, 'analysis_policy.activated',
    'analysis_policy_revision', v_revision_id, 'success', jsonb_build_object(
      'policy_id', btrim(p_policy_id),
      'policy_version', btrim(p_policy_version),
      'output_schema_version', btrim(p_output_schema_version),
      'active_variable_revision', p_active_variable_revision,
      'sha256', v_sha256,
      'repository_commit_sha', v_repository_commit_sha,
      'repository_blob_sha', v_repository_blob_sha,
      'revision_reused', v_reused
    )
  );

  return v_revision_id;
end;
$$;

create function public.ia_forecast_input(
  p_location_id uuid,
  p_history_start date,
  p_history_end date
)
returns table (
  business_date date,
  location_id uuid,
  brand_id uuid,
  product_id uuid,
  product_name text,
  quantity integer
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_is_service_role boolean := current_user = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  if v_is_service_role then
    select state.workspace_id into v_workspace_id
    from public.ia_installation_state as state
    where state.singleton;
  else
    select m.workspace_id into v_workspace_id
    from public.ia_workspace_memberships as m
    where m.user_id = auth.uid() and m.status = 'active'
    limit 1;
  end if;
  if v_workspace_id is null
     or (not v_is_service_role and not (select ia_private.ia_has_location_access(v_workspace_id, p_location_id)))
     or (v_is_service_role and not exists (
       select 1 from public.ia_locations as location
       where location.workspace_id = v_workspace_id
         and location.id = p_location_id and location.is_active
     )) then
    raise exception 'location access denied' using errcode = '42501';
  end if;
  if p_history_start is null or p_history_end is null
     or p_history_start > p_history_end
     or p_history_end - p_history_start > 3653 then
    raise exception 'invalid history range' using errcode = '22023';
  end if;

  return query
  select h.business_date, h.location_id, h.brand_id, h.product_id, p.name, h.quantity
  from public.ia_historical_sales as h
  join public.ia_products as p
    on p.workspace_id = h.workspace_id and p.brand_id = h.brand_id and p.id = h.product_id
  where h.workspace_id = v_workspace_id
    and h.location_id = p_location_id
    and h.business_date between p_history_start and p_history_end
  order by h.business_date, p.name;
end;
$$;

-- Stores a server-validated analysis result atomically through service_role only,
-- while independently rechecking the singleton workspace, active policy, location,
-- and product scope.
create function public.ia_store_forecast_result(
  p_run jsonb,
  p_items jsonb,
  p_sources jsonb
)
returns table (run_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_workspace_id uuid;
  v_brand_id uuid;
  v_location_id uuid;
  v_policy_revision_id uuid;
  v_period_start date;
  v_period_end date;
  v_run_source text;
  v_actor_user_id uuid;
  v_run_id uuid;
  v_item_id uuid;
  v_item jsonb;
  v_source jsonb;
  v_source_key text;
  v_policy public.ia_analysis_policy_revisions%rowtype;
  v_status public.ia_forecast_status;
  v_research_completed boolean;
  v_history_watermark timestamptz;
  v_claim ia_private.ia_scheduled_forecast_claims%rowtype;
  v_is_service_role boolean := current_user = 'service_role'
    or coalesce(auth.jwt() ->> 'role', '') = 'service_role';
begin
  if not v_is_service_role then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select state.workspace_id into v_workspace_id
  from public.ia_installation_state as state
  join public.ia_workspaces as workspace on workspace.id = state.workspace_id
  where state.singleton and workspace.status = 'active';
  if v_workspace_id is null then
    raise exception 'active installation workspace required' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('ia_history:' || v_workspace_id::text, 41981)
  );
  if jsonb_typeof(p_run) <> 'object'
     or not (p_run ?& array[
       'brand_id', 'location_id', 'policy_revision_id', 'period_grouping',
       'period_start', 'period_end', 'location_time_zone', 'status',
       'run_source', 'actor_user_id'
     ])
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_typeof(p_sources) <> 'array' then
    raise exception 'invalid forecast payload' using errcode = '22023';
  end if;

  v_brand_id := (p_run ->> 'brand_id')::uuid;
  v_location_id := (p_run ->> 'location_id')::uuid;
  v_policy_revision_id := (p_run ->> 'policy_revision_id')::uuid;
  v_period_start := (p_run ->> 'period_start')::date;
  v_period_end := (p_run ->> 'period_end')::date;
  v_run_source := p_run ->> 'run_source';
  v_actor_user_id := nullif(p_run ->> 'actor_user_id', '')::uuid;
  v_status := (p_run ->> 'status')::public.ia_forecast_status;
  v_research_completed := coalesce((p_run ->> 'research_completed')::boolean, false);
  if coalesce(v_run_source, '') not in ('manual', 'scheduled', 'email_test')
     or ((v_run_source = 'scheduled') <> (v_actor_user_id is null)) then
    raise exception 'invalid forecast source or actor' using errcode = '22023';
  end if;

  perform 1 from public.ia_locations as location
  where location.workspace_id = v_workspace_id and location.brand_id = v_brand_id
    and location.id = v_location_id and location.is_active
  for share of location;
  if not found then
    raise exception 'forecast location scope denied' using errcode = '42501';
  end if;

  select revision.* into v_policy
  from public.ia_analysis_policy_revisions as revision
  join public.ia_workspace_analysis_state as state
    on state.workspace_id = revision.workspace_id
   and state.active_policy_revision_id = revision.id
  where revision.workspace_id = v_workspace_id and revision.id = v_policy_revision_id
  for share of state;
  if not found then
    raise exception 'forecast policy is not active' using errcode = '42501';
  end if;

  select claim.* into v_claim
  from ia_private.ia_scheduled_forecast_claims as claim
  where claim.workspace_id = v_workspace_id
    and claim.location_id = v_location_id
    and claim.period_start = v_period_start
    and claim.period_end = v_period_end
  for update;
  if not found or v_claim.status <> 'running'
     or v_claim.claimed_at <= now() - interval '15 minutes'
     or v_claim.policy_revision_id <> v_policy_revision_id
     or v_claim.run_source <> v_run_source
     or v_claim.actor_user_id is distinct from v_actor_user_id then
    raise exception 'matching active forecast claim required' using errcode = '42501';
  end if;

  select max(batch.committed_at) into v_history_watermark
  from public.ia_import_batches as batch
  where batch.workspace_id = v_workspace_id and batch.status = 'committed';
  if v_history_watermark is distinct from v_claim.history_watermark then
    raise exception 'historical data changed during forecast generation' using errcode = '40001';
  end if;
  if v_run_source in ('manual', 'email_test') then
    perform 1
    from public.ia_workspace_memberships as membership
    join public.ia_user_location_assignments as assignment
      on assignment.workspace_id = membership.workspace_id
     and assignment.user_id = membership.user_id
    where membership.workspace_id = v_workspace_id
      and membership.user_id = v_actor_user_id
      and membership.status = 'active'
      and (
        membership.role in ('super_admin', 'admin')
        or (v_run_source = 'manual' and membership.role = 'manager')
      )
      and assignment.location_id = v_location_id and assignment.is_active
    for share of membership, assignment;
    if not found then
      raise exception 'forecast actor lost location access during generation' using errcode = '42501';
    end if;
  end if;

  if v_research_completed and jsonb_array_length(p_sources) < 1 then
    raise exception 'researched forecasts require direct sources' using errcode = '23514';
  end if;
  if v_status in ('complete', 'baseline_only', 'needs_review') and jsonb_array_length(p_items) < 1 then
    raise exception 'forecast recommendations are required' using errcode = '23514';
  end if;

  insert into public.ia_forecast_runs (
    workspace_id, brand_id, location_id, policy_revision_id, period_grouping,
    period_start, period_end, location_time_zone, status, run_source,
    research_completed, policy_id, policy_version, output_schema_version,
    policy_sha256, ai_provider, ai_model, provider_request_id, baseline_method,
    adjustment_method, rounding_rule, historical_start_date, historical_end_date,
    rows_used, data_quality_issues, warnings, initiated_by, started_at,
    generated_at, completed_at
  ) values (
    v_workspace_id, v_brand_id, v_location_id, v_policy_revision_id,
    (p_run ->> 'period_grouping')::public.ia_forecast_period,
    v_period_start, v_period_end,
    p_run ->> 'location_time_zone', v_status,
    v_run_source, v_research_completed,
    v_policy.policy_id, v_policy.policy_version, v_policy.output_schema_version,
    v_policy.sha256, nullif(p_run ->> 'ai_provider', ''), nullif(p_run ->> 'ai_model', ''),
    nullif(p_run ->> 'provider_request_id', ''), nullif(p_run ->> 'baseline_method', ''),
    nullif(p_run ->> 'adjustment_method', ''), nullif(p_run ->> 'rounding_rule', ''),
    nullif(p_run ->> 'historical_start_date', '')::date,
    nullif(p_run ->> 'historical_end_date', '')::date,
    nullif(p_run ->> 'rows_used', '')::integer,
    coalesce(p_run -> 'data_quality_issues', '[]'::jsonb),
    coalesce(p_run -> 'warnings', '[]'::jsonb), v_actor_user_id, now(),
    coalesce(nullif(p_run ->> 'generated_at', '')::timestamptz, now()), now()
  ) returning id into v_run_id;

  for v_source in select value from jsonb_array_elements(p_sources)
  loop
    if jsonb_typeof(v_source) <> 'object'
       or not (v_source ?& array['source_key', 'title', 'publisher', 'url', 'accessed_at', 'fact_used']) then
      raise exception 'invalid forecast source' using errcode = '22023';
    end if;
    insert into public.ia_forecast_sources (
      workspace_id, location_id, forecast_run_id, source_key, title, publisher,
      url, published_or_updated_date, accessed_at, fact_used
    ) values (
      v_workspace_id, v_location_id, v_run_id, v_source ->> 'source_key',
      v_source ->> 'title', v_source ->> 'publisher', v_source ->> 'url',
      nullif(v_source ->> 'published_or_updated_date', '')::date,
      (v_source ->> 'accessed_at')::timestamptz, v_source ->> 'fact_used'
    );
  end loop;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) <> 'object'
       or not (v_item ?& array[
         'product_id', 'baseline_quantity', 'recommended_quantity', 'confidence', 'explanation'
       ])
       or jsonb_typeof(coalesce(v_item -> 'adjustments', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_item -> 'source_keys', '[]'::jsonb)) <> 'array' then
      raise exception 'invalid forecast item' using errcode = '22023';
    end if;
    perform 1 from public.ia_products as product
    where product.workspace_id = v_workspace_id and product.brand_id = v_brand_id
      and product.id = (v_item ->> 'product_id')::uuid and product.archived_at is null
    for share of product;
    if not found then
      raise exception 'forecast product scope denied' using errcode = '42501';
    end if;
    if exists (
      select 1
      from jsonb_array_elements_text(coalesce(v_item -> 'source_keys', '[]'::jsonb)) as key(value)
      where not exists (
        select 1 from public.ia_forecast_sources as source
        where source.workspace_id = v_workspace_id and source.forecast_run_id = v_run_id
          and source.source_key = key.value
      )
    ) then
      raise exception 'forecast item references an unknown source' using errcode = '23503';
    end if;

    insert into public.ia_forecast_items (
      workspace_id, brand_id, location_id, forecast_run_id, product_id,
      baseline_quantity, adjustments, recommended_quantity, confidence, explanation
    ) values (
      v_workspace_id, v_brand_id, v_location_id, v_run_id,
      (v_item ->> 'product_id')::uuid, (v_item ->> 'baseline_quantity')::numeric,
      coalesce(v_item -> 'adjustments', '[]'::jsonb),
      (v_item ->> 'recommended_quantity')::integer,
      (v_item ->> 'confidence')::public.ia_confidence, v_item ->> 'explanation'
    ) returning id into v_item_id;

    for v_source_key in
      select value from jsonb_array_elements_text(coalesce(v_item -> 'source_keys', '[]'::jsonb))
    loop
      insert into public.ia_forecast_item_sources (
        workspace_id, forecast_run_id, forecast_item_id, forecast_source_id
      )
      select v_workspace_id, v_run_id, v_item_id, source.id
      from public.ia_forecast_sources as source
      where source.workspace_id = v_workspace_id and source.forecast_run_id = v_run_id
        and source.source_key = v_source_key;
    end loop;
  end loop;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_actor_user_id, 'forecast.stored', 'forecast_run', v_run_id,
    'success', jsonb_build_object(
      'location_id', v_location_id, 'status', v_status,
      'item_count', jsonb_array_length(p_items), 'source_count', jsonb_array_length(p_sources)
    )
  );

  update ia_private.ia_scheduled_forecast_claims
  set status = 'complete', finished_at = now(), failure_code = null,
      forecast_run_id = v_run_id
  where workspace_id = v_workspace_id and location_id = v_location_id
    and period_start = v_period_start and period_end = v_period_end
    and status = 'running';
  if not found then
    raise exception 'forecast claim changed before storage completed' using errcode = '40001';
  end if;
  run_id := v_run_id;
  return next;
end;
$$;

-- Query-path indexes, including the predicates used by RLS.
create index ia_memberships_user_active_idx
  on public.ia_workspace_memberships (user_id, workspace_id) where status = 'active';
create index ia_assignments_user_active_idx
  on public.ia_user_location_assignments (user_id, workspace_id, location_id) where is_active;
create index ia_assignments_location_active_idx
  on public.ia_user_location_assignments (workspace_id, location_id, user_id) where is_active;
create index ia_locations_brand_idx on public.ia_locations (workspace_id, brand_id) where is_active;
create index ia_products_brand_idx on public.ia_products (workspace_id, brand_id) where archived_at is null;
create index ia_history_dashboard_idx
  on public.ia_historical_sales (workspace_id, location_id, business_date, product_id);
create index ia_history_product_idx
  on public.ia_historical_sales (workspace_id, product_id, business_date);
create index ia_import_batches_recent_idx on public.ia_import_batches (workspace_id, created_at desc);
create index ia_policy_revisions_recent_idx on public.ia_analysis_policy_revisions (workspace_id, created_at desc);
create index ia_forecast_runs_dashboard_idx
  on public.ia_forecast_runs (workspace_id, location_id, period_start desc, status);
create index ia_forecast_items_run_idx on public.ia_forecast_items (workspace_id, forecast_run_id);
create index ia_forecast_sources_run_idx on public.ia_forecast_sources (workspace_id, forecast_run_id);
create index ia_email_deliveries_due_idx
  on public.ia_email_deliveries (due_at, status) where status in ('queued', 'failed');
create index ia_email_deliveries_recipient_idx
  on public.ia_email_deliveries (workspace_id, recipient_user_id, created_at desc);
create index ia_audit_events_recent_idx on public.ia_audit_events (workspace_id, created_at desc);

-- RLS is enabled on every application table, including server-only private tables.
alter table public.ia_workspaces enable row level security;
alter table public.ia_workspaces force row level security;
alter table public.ia_installation_state enable row level security;
alter table public.ia_installation_state force row level security;
alter table public.ia_migration_markers enable row level security;
alter table public.ia_migration_markers force row level security;
alter table ia_private.ia_owner_bootstrap_authorizations enable row level security;
alter table ia_private.ia_owner_bootstrap_authorizations force row level security;
alter table public.ia_profiles enable row level security;
alter table public.ia_profiles force row level security;
alter table public.ia_workspace_memberships enable row level security;
alter table public.ia_workspace_memberships force row level security;
alter table public.ia_brands enable row level security;
alter table public.ia_brands force row level security;
alter table public.ia_locations enable row level security;
alter table public.ia_locations force row level security;
alter table public.ia_user_location_assignments enable row level security;
alter table public.ia_user_location_assignments force row level security;
alter table public.ia_invitations enable row level security;
alter table public.ia_invitations force row level security;
alter table public.ia_invitation_locations enable row level security;
alter table public.ia_invitation_locations force row level security;
alter table public.ia_products enable row level security;
alter table public.ia_products force row level security;
alter table public.ia_import_batches enable row level security;
alter table public.ia_import_batches force row level security;
alter table public.ia_historical_sales enable row level security;
alter table public.ia_historical_sales force row level security;
alter table ia_private.ia_historical_sales_revisions enable row level security;
alter table ia_private.ia_historical_sales_revisions force row level security;
alter table public.ia_analysis_policy_revisions enable row level security;
alter table public.ia_analysis_policy_revisions force row level security;
alter table public.ia_workspace_analysis_state enable row level security;
alter table public.ia_workspace_analysis_state force row level security;
alter table public.ia_forecast_runs enable row level security;
alter table public.ia_forecast_runs force row level security;
alter table public.ia_forecast_items enable row level security;
alter table public.ia_forecast_items force row level security;
alter table public.ia_forecast_sources enable row level security;
alter table public.ia_forecast_sources force row level security;
alter table public.ia_forecast_item_sources enable row level security;
alter table public.ia_forecast_item_sources force row level security;
alter table ia_private.ia_scheduled_forecast_claims enable row level security;
alter table ia_private.ia_scheduled_forecast_claims force row level security;
alter table public.ia_email_schedules enable row level security;
alter table public.ia_email_schedules force row level security;
alter table public.ia_email_recipient_preferences enable row level security;
alter table public.ia_email_recipient_preferences force row level security;
alter table public.ia_email_deliveries enable row level security;
alter table public.ia_email_deliveries force row level security;
alter table public.ia_email_delivery_locations enable row level security;
alter table public.ia_email_delivery_locations force row level security;
alter table public.ia_email_delivery_attempts enable row level security;
alter table public.ia_email_delivery_attempts force row level security;
alter table public.ia_provider_connections enable row level security;
alter table public.ia_provider_connections force row level security;
alter table ia_private.ia_provider_secrets enable row level security;
alter table ia_private.ia_provider_secrets force row level security;
alter table public.ia_audit_events enable row level security;
alter table public.ia_audit_events force row level security;

-- Read policies. Operational data never has a role-based bypass: even admins
-- require an active assignment for sales, forecasts, and email location detail.
create policy ia_workspaces_select on public.ia_workspaces for select to authenticated
  using ((select ia_private.ia_current_workspace_role(id)) is not null);

create policy ia_profiles_select on public.ia_profiles for select to authenticated
  using (
    user_id = (select auth.uid())
    or exists (
      select 1 from public.ia_workspace_memberships as target
      where target.user_id = ia_profiles.user_id
        and (select ia_private.ia_current_workspace_role(target.workspace_id)) in ('super_admin', 'admin')
    )
  );
create policy ia_profiles_update_self on public.ia_profiles for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

create policy ia_memberships_select on public.ia_workspace_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
  );
create policy ia_brands_select on public.ia_brands for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
    or exists (
      select 1 from public.ia_locations as l
      where l.workspace_id = ia_brands.workspace_id
        and l.brand_id = ia_brands.id
        and (select ia_private.ia_has_location_access(l.workspace_id, l.id))
    )
  );

create policy ia_locations_select on public.ia_locations for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
    or (select ia_private.ia_has_location_access(workspace_id, id))
  );

create policy ia_assignments_select on public.ia_user_location_assignments for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
  );
create policy ia_invitations_select on public.ia_invitations for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
create policy ia_invitation_locations_select on public.ia_invitation_locations for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));

create policy ia_products_select on public.ia_products for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
    or exists (
      select 1 from public.ia_locations as l
      where l.workspace_id = ia_products.workspace_id
        and l.brand_id = ia_products.brand_id
        and (select ia_private.ia_has_location_access(l.workspace_id, l.id))
    )
  );
create policy ia_import_batches_select on public.ia_import_batches for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
create policy ia_historical_sales_select on public.ia_historical_sales for select to authenticated
  using ((select ia_private.ia_has_location_access(workspace_id, location_id)));

create policy ia_policy_revisions_select on public.ia_analysis_policy_revisions for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
create policy ia_analysis_state_select on public.ia_workspace_analysis_state for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) is not null);

create policy ia_forecast_runs_select on public.ia_forecast_runs for select to authenticated
  using ((select ia_private.ia_has_location_access(workspace_id, location_id)));
create policy ia_forecast_items_select on public.ia_forecast_items for select to authenticated
  using ((select ia_private.ia_has_location_access(workspace_id, location_id)));
create policy ia_forecast_sources_select on public.ia_forecast_sources for select to authenticated
  using ((select ia_private.ia_has_location_access(workspace_id, location_id)));
create policy ia_forecast_item_sources_select on public.ia_forecast_item_sources for select to authenticated
  using (
    exists (
      select 1 from public.ia_forecast_items as fi
      where fi.workspace_id = ia_forecast_item_sources.workspace_id
        and fi.id = ia_forecast_item_sources.forecast_item_id
        and (select ia_private.ia_has_location_access(fi.workspace_id, fi.location_id))
    )
  );
create policy ia_email_schedules_select on public.ia_email_schedules for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) is not null);
create policy ia_recipient_preferences_select on public.ia_email_recipient_preferences for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
  );
create policy ia_deliveries_select on public.ia_email_deliveries for select to authenticated
  using (
    recipient_user_id = (select auth.uid())
    or (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
  );
create policy ia_delivery_locations_select on public.ia_email_delivery_locations for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin')
    or (
      (select ia_private.ia_has_location_access(workspace_id, location_id))
      and exists (
        select 1 from public.ia_email_deliveries as d
        where d.workspace_id = ia_email_delivery_locations.workspace_id
          and d.id = ia_email_delivery_locations.delivery_id
          and d.recipient_user_id = (select auth.uid())
      )
    )
  );
create policy ia_delivery_attempts_select on public.ia_email_delivery_attempts for select to authenticated
  using (
    exists (
      select 1 from public.ia_email_deliveries as d
      where d.workspace_id = ia_email_delivery_attempts.workspace_id
        and d.id = ia_email_delivery_attempts.delivery_id
        and (
          d.recipient_user_id = (select auth.uid())
          or (select ia_private.ia_current_workspace_role(d.workspace_id)) in ('super_admin', 'admin')
        )
    )
  );

create policy ia_provider_connections_select on public.ia_provider_connections for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
create policy ia_audit_events_select on public.ia_audit_events for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
-- Explicit Data API privileges. The browser receives read access only, except
-- for a user's own display profile. All high-risk writes go through authorized
-- server routes; service_role still must re-check workspace and location scope.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all tables in schema ia_private from public, anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema ia_private from public, anon, authenticated;

grant select on public.ia_workspaces,
  public.ia_profiles,
  public.ia_workspace_memberships,
  public.ia_brands,
  public.ia_locations,
  public.ia_user_location_assignments,
  public.ia_invitations,
  public.ia_invitation_locations,
  public.ia_products,
  public.ia_import_batches,
  public.ia_historical_sales,
  public.ia_analysis_policy_revisions,
  public.ia_workspace_analysis_state,
  public.ia_forecast_runs,
  public.ia_forecast_items,
  public.ia_forecast_sources,
  public.ia_forecast_item_sources,
  public.ia_email_schedules,
  public.ia_email_recipient_preferences,
  public.ia_email_deliveries,
  public.ia_email_delivery_locations,
  public.ia_email_delivery_attempts,
  public.ia_provider_connections,
  public.ia_audit_events
to authenticated;
grant update (username, display_name) on public.ia_profiles to authenticated;

grant usage on schema ia_private to authenticated;
grant execute on function ia_private.ia_current_workspace_role(uuid) to authenticated;
grant execute on function ia_private.ia_has_location_access(uuid, uuid) to authenticated;
grant execute on function public.ia_accept_invitation(text) to authenticated;
grant execute on function public.ia_create_brand(text, text) to authenticated;
grant execute on function public.ia_create_location(uuid, text, text, text, text, text, text, text, text) to authenticated;
grant execute on function public.ia_import_historical_sales(text, text, jsonb) to authenticated;
grant execute on function public.ia_historical_dashboard(text, date, uuid[]) to authenticated;
grant execute on function public.ia_save_email_schedule(uuid, text, boolean, text, smallint, time, text, text, text) to authenticated;
grant execute on function public.ia_forecast_input(uuid, date, date) to authenticated;
grant execute on function public.ia_update_member(uuid, text, text, boolean, uuid[]) to authenticated;

revoke all on function public.ia_store_forecast_result(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ia_store_forecast_result(jsonb, jsonb, jsonb) to service_role;

revoke all on function public.ia_server_authorize_owner_bootstrap(uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.ia_server_bootstrap_workspace(uuid)
  from public, anon, authenticated;
grant execute on function public.ia_server_authorize_owner_bootstrap(uuid, text, text, text, text, text)
  to service_role;
grant execute on function public.ia_server_bootstrap_workspace(uuid)
  to service_role;

revoke all on function public.ia_server_get_provider_secret(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ia_server_save_provider_connection(uuid, text, text, text, text, text, text, text, text, text, text, bytea, integer, text, text, uuid) from public, anon, authenticated;
revoke all on function public.ia_server_activate_analysis_policy(uuid, uuid, text, text, text, integer, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.ia_server_get_provider_secret(uuid, text, text) to service_role;
grant execute on function public.ia_server_save_provider_connection(uuid, text, text, text, text, text, text, text, text, text, text, bytea, integer, text, text, uuid) to service_role;
grant execute on function public.ia_server_activate_analysis_policy(uuid, uuid, text, text, text, integer, text, jsonb, text, text, text) to service_role;

grant usage on schema ia_private to service_role;
grant all on all tables in schema public to service_role;
grant all on all tables in schema ia_private to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
grant execute on all functions in schema ia_private to service_role;

-- Future objects stay closed by default. Migrations must grant intentionally.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema ia_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema ia_private revoke execute on functions from public, anon, authenticated;

comment on table public.ia_installation_state is 'Singleton lock: exactly one workspace may be bootstrapped per deployment.';
comment on table public.ia_historical_sales is 'Date-only canonical sales. Timestamp source values must be rejected before insert.';
comment on table ia_private.ia_provider_secrets is 'Application-encrypted, write-only provider secrets; encryption key remains in Railway.';
comment on table ia_private.ia_owner_bootstrap_authorizations is 'Private 24-hour first-owner authorizations minted only after server-side OWNER_SETUP_SECRET verification.';
comment on function public.ia_server_authorize_owner_bootstrap(uuid, text, text, text, text, text) is 'Service-role-only creation of a short-lived first-owner authorization while the singleton installation is empty.';
comment on function public.ia_server_bootstrap_workspace(uuid) is 'Service-role-only atomic consumer of a valid owner authorization for a confirmed Auth email user.';
comment on function public.ia_accept_invitation(text) is 'Consumes one expiring app invitation for the authenticated email identity.';
comment on function public.ia_create_brand(text, text) is 'Admin-only normalized brand creation with an atomic audit event.';
comment on function public.ia_create_location(uuid, text, text, text, text, text, text, text, text) is 'Admin-only location creation, creator assignment, and audit event in one transaction.';
comment on function public.ia_import_historical_sales(text, text, jsonb) is 'Atomic authorized date-only sales upsert with import and audit records.';
comment on function public.ia_historical_dashboard(text, date, uuid[]) is 'Location-assignment scoped current/previous product aggregates and series.';
comment on function public.ia_save_email_schedule(uuid, text, boolean, text, smallint, time, text, text, text) is 'Admin-only schedule insert/update; enabling requires verified workspace email.';
comment on function public.ia_forecast_input(uuid, date, date) is 'Assignment-scoped, uncapped historical rows for one forecast location.';
comment on function public.ia_store_forecast_result(jsonb, jsonb, jsonb) is 'Service-role-only atomic normalized forecast storage with singleton workspace, policy, location, and product checks.';
comment on function public.ia_update_member(uuid, text, text, boolean, uuid[]) is 'Atomic role, status, email, and location update with final-super-admin protection.';
comment on function public.ia_server_get_provider_secret(uuid, text, text) is 'Service-role-only read of one application-encrypted secret envelope.';
comment on function public.ia_server_save_provider_connection(uuid, text, text, text, text, text, text, text, text, text, text, bytea, integer, text, text, uuid) is 'Service-role-only atomic normalized metadata, optional encrypted secret, and actor audit save.';
comment on function public.ia_server_activate_analysis_policy(uuid, uuid, text, text, text, integer, text, jsonb, text, text, text) is 'Service-role-only idempotent append and atomic activation of one verified analysis policy revision.';

insert into public.ia_migration_markers (migration_id)
values ('20260716210000_inventory_auditor');
