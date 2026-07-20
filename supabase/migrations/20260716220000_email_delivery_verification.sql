-- Inventory Auditor: keep scheduled email disabled until the exact Resend
-- credential/sender pair has completed an internal delivery test.

create table ia_private.ia_email_delivery_verifications (
  workspace_id uuid primary key references public.ia_workspaces(id) on delete cascade,
  credential_fingerprint text not null check (credential_fingerprint ~ '^[0-9a-f]{64}$'),
  sender_email text not null check (length(btrim(sender_email)) between 3 and 320),
  provider_message_id text not null check (length(btrim(provider_message_id)) between 1 and 200),
  verified_by uuid not null references auth.users(id) on delete restrict,
  recipient_user_id uuid not null references auth.users(id) on delete restrict,
  verified_at timestamptz not null default now(),
  foreign key (workspace_id, recipient_user_id)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete restrict
);

alter table ia_private.ia_email_delivery_verifications enable row level security;
alter table ia_private.ia_email_delivery_verifications force row level security;
revoke all on table ia_private.ia_email_delivery_verifications from public, anon, authenticated;
grant select, insert, update on table ia_private.ia_email_delivery_verifications to service_role;

create function public.ia_server_mark_email_verified(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_recipient_user_id uuid,
  p_credential_fingerprint text,
  p_sender_email text,
  p_provider_message_id text,
  p_location_ids uuid[]
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_location_ids uuid[];
  v_requested_location_ids uuid[];
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_credential_fingerprint !~ '^[0-9a-f]{64}$'
     or length(btrim(coalesce(p_sender_email, ''))) not between 3 and 320
     or position(chr(10) in p_sender_email) > 0 or position(chr(13) in p_sender_email) > 0
     or length(btrim(coalesce(p_provider_message_id, ''))) not between 1 and 200
     or position(chr(10) in p_provider_message_id) > 0 or position(chr(13) in p_provider_message_id) > 0
     or coalesce(cardinality(p_location_ids), 0) < 1 then
    raise exception 'invalid email verification record' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.ia_installation_state as state
    join public.ia_workspaces as workspace on workspace.id = state.workspace_id
    where state.singleton and state.workspace_id = p_workspace_id
      and workspace.status = 'active'
  ) then
    raise exception 'workspace scope denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_workspace_memberships as actor
    where actor.workspace_id = p_workspace_id and actor.user_id = p_actor_user_id
      and actor.status = 'active' and actor.role in ('super_admin', 'admin')
  ) then
    raise exception 'active administrator audit actor required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_workspace_memberships as recipient
    join public.ia_profiles as profile on profile.user_id = recipient.user_id
    where recipient.workspace_id = p_workspace_id
      and recipient.user_id = p_recipient_user_id
      and recipient.status = 'active' and recipient.email_enabled
  ) then
    raise exception 'recipient is not eligible for forecast email' using errcode = '42501';
  end if;

  select array_agg(location.id order by location.id) into v_location_ids
  from public.ia_user_location_assignments as assignment
  join public.ia_locations as location
    on location.workspace_id = assignment.workspace_id
   and location.id = assignment.location_id
  where assignment.workspace_id = p_workspace_id
    and assignment.user_id = p_recipient_user_id
    and assignment.is_active and location.is_active;
  select array_agg(value order by value) into v_requested_location_ids
  from (select distinct unnest(p_location_ids) as value) as requested;
  if v_location_ids is distinct from v_requested_location_ids
     or cardinality(v_requested_location_ids) <> cardinality(p_location_ids) then
    raise exception 'recipient location scope changed during delivery test' using errcode = '40001';
  end if;

  insert into ia_private.ia_email_delivery_verifications (
    workspace_id, credential_fingerprint, sender_email, provider_message_id,
    verified_by, recipient_user_id, verified_at
  ) values (
    p_workspace_id, p_credential_fingerprint, btrim(p_sender_email),
    btrim(p_provider_message_id), p_actor_user_id, p_recipient_user_id, now()
  )
  on conflict (workspace_id) do update
    set credential_fingerprint = excluded.credential_fingerprint,
        sender_email = excluded.sender_email,
        provider_message_id = excluded.provider_message_id,
        verified_by = excluded.verified_by,
        recipient_user_id = excluded.recipient_user_id,
        verified_at = now();

  update public.ia_workspaces
  set email_sending_enabled = true, updated_at = now()
  where id = p_workspace_id and status = 'active';

  update public.ia_provider_connections
  set status = 'connected', last_tested_at = now(), last_test_result = 'passed',
      last_error_code = null, updated_by = p_actor_user_id, updated_at = now()
  where workspace_id = p_workspace_id and provider_kind = 'resend'
    and status <> 'disabled';

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    p_workspace_id, p_actor_user_id, 'email_delivery.verified', 'workspace',
    p_workspace_id, 'success', jsonb_build_object(
      'recipient_user_id', p_recipient_user_id,
      'location_count', cardinality(v_location_ids),
      'provider_message_id', btrim(p_provider_message_id),
      'automatic_delivery_enabled', true
    )
  );
end;
$$;

create function public.ia_server_email_verification_matches(
  p_workspace_id uuid,
  p_credential_fingerprint text,
  p_sender_email text
)
returns boolean
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
  return exists (
    select 1
    from ia_private.ia_email_delivery_verifications as verification
    join public.ia_workspaces as workspace on workspace.id = verification.workspace_id
    where verification.workspace_id = p_workspace_id
      and verification.credential_fingerprint = p_credential_fingerprint
      and verification.sender_email = btrim(p_sender_email)
      and workspace.status = 'active'
      and workspace.email_sending_enabled
  );
end;
$$;

revoke all on function public.ia_server_mark_email_verified(uuid, uuid, uuid, text, text, text, uuid[])
  from public, anon, authenticated;
revoke all on function public.ia_server_email_verification_matches(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ia_server_mark_email_verified(uuid, uuid, uuid, text, text, text, uuid[])
  to service_role;
grant execute on function public.ia_server_email_verification_matches(uuid, text, text)
  to service_role;

comment on table ia_private.ia_email_delivery_verifications is
  'Server-only proof that the current credential/sender pair completed an internal forecast delivery test.';
comment on function public.ia_server_mark_email_verified(uuid, uuid, uuid, text, text, text, uuid[]) is
  'Service-role-only atomic email verification, workspace gate, provider status, and audit update.';
comment on function public.ia_server_email_verification_matches(uuid, text, text) is
  'Service-role-only check that scheduled delivery still uses the internally tested credential/sender pair.';

-- The foundation migration creates the private claim ledger. These service-only
-- RPCs enforce current-policy, import-watermark, actor-scope, and cooldown rules.

create function public.ia_server_claim_scheduled_forecast(
  p_workspace_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end date,
  p_policy_revision_id uuid,
  p_run_source text,
  p_actor_user_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim ia_private.ia_scheduled_forecast_claims%rowtype;
  v_history_watermark timestamptz;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_period_start is null or p_period_end is null or p_period_start > p_period_end
     or p_period_end - p_period_start > 366
     or p_policy_revision_id is null
     or coalesce(p_run_source, '') not in ('manual', 'scheduled', 'email_test')
     or not exists (
       select 1 from public.ia_installation_state as state
       join public.ia_locations as location
         on location.workspace_id = state.workspace_id
        and location.id = p_location_id
       where state.singleton and state.workspace_id = p_workspace_id
         and location.is_active
     ) then
    raise exception 'scheduled forecast scope denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.ia_workspace_analysis_state as state
    where state.workspace_id = p_workspace_id
      and state.active_policy_revision_id = p_policy_revision_id
  ) then
    raise exception 'current analysis policy required' using errcode = '42501';
  end if;
  if p_run_source = 'scheduled' and p_actor_user_id is not null then
    raise exception 'scheduled forecasts do not have a user actor' using errcode = '22023';
  elsif p_run_source in ('manual', 'email_test') and not exists (
    select 1
    from public.ia_workspace_memberships as membership
    join public.ia_user_location_assignments as assignment
      on assignment.workspace_id = membership.workspace_id
     and assignment.user_id = membership.user_id
    where membership.workspace_id = p_workspace_id
      and membership.user_id = p_actor_user_id
      and membership.status = 'active'
      and (
        membership.role in ('super_admin', 'admin')
        or (p_run_source = 'manual' and membership.role = 'manager')
      )
      and assignment.location_id = p_location_id and assignment.is_active
  ) then
    raise exception 'forecast actor is not authorized for this location' using errcode = '42501';
  end if;

  select max(batch.committed_at) into v_history_watermark
  from public.ia_import_batches as batch
  where batch.workspace_id = p_workspace_id and batch.status = 'committed';

  insert into ia_private.ia_scheduled_forecast_claims (
    workspace_id, location_id, period_start, period_end, policy_revision_id,
    history_watermark, run_source, actor_user_id, status, claimed_at
  ) values (
    p_workspace_id, p_location_id, p_period_start, p_period_end, p_policy_revision_id,
    v_history_watermark, p_run_source, p_actor_user_id, 'running', now()
  )
  on conflict do nothing;
  if found then return true; end if;

  select claim.* into v_claim
  from ia_private.ia_scheduled_forecast_claims as claim
  where claim.workspace_id = p_workspace_id and claim.location_id = p_location_id
    and claim.period_start = p_period_start and claim.period_end = p_period_end
  for update;

  if v_claim.status = 'complete'
     and v_claim.policy_revision_id = p_policy_revision_id
     and v_claim.history_watermark is not distinct from v_history_watermark
     and exists (
    select 1 from public.ia_forecast_runs as run
    where run.workspace_id = p_workspace_id and run.location_id = p_location_id
      and run.period_start = p_period_start and run.period_end = p_period_end
      and run.id = v_claim.forecast_run_id
      and run.policy_revision_id = p_policy_revision_id
      and run.status in ('complete', 'baseline_only', 'needs_review')
  ) and (p_run_source = 'scheduled' or v_claim.finished_at > now() - interval '6 hours') then
    return false;
  end if;
  if v_claim.status = 'running' and v_claim.claimed_at > now() - interval '15 minutes' then
    return false;
  end if;
  if v_claim.status = 'failed'
     and v_claim.policy_revision_id = p_policy_revision_id
     and v_claim.history_watermark is not distinct from v_history_watermark
     and coalesce(v_claim.finished_at, v_claim.claimed_at) > now() - interval '15 minutes' then
    return false;
  end if;

  update ia_private.ia_scheduled_forecast_claims
  set policy_revision_id = p_policy_revision_id,
      history_watermark = v_history_watermark,
      run_source = p_run_source,
      actor_user_id = p_actor_user_id,
      forecast_run_id = null,
      status = 'running', claimed_at = now(), finished_at = null, failure_code = null
  where workspace_id = p_workspace_id and location_id = p_location_id
    and period_start = p_period_start and period_end = p_period_end;
  return true;
end;
$$;

create function public.ia_server_finish_scheduled_forecast(
  p_workspace_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end date,
  p_policy_revision_id uuid,
  p_run_source text,
  p_actor_user_id uuid,
  p_outcome text,
  p_failure_code text
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim ia_private.ia_scheduled_forecast_claims%rowtype;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if not exists (
       select 1 from public.ia_installation_state as state
       where state.singleton and state.workspace_id = p_workspace_id
     )
     or p_policy_revision_id is null
     or coalesce(p_run_source, '') not in ('manual', 'scheduled', 'email_test')
     or ((p_run_source = 'scheduled') <> (p_actor_user_id is null))
     or coalesce(p_outcome, '') <> 'failed'
     or coalesce(p_failure_code, '') !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid scheduled forecast outcome' using errcode = '22023';
  end if;

  select claim.* into v_claim
  from ia_private.ia_scheduled_forecast_claims as claim
  where claim.workspace_id = p_workspace_id and claim.location_id = p_location_id
    and claim.period_start = p_period_start and claim.period_end = p_period_end
  for update;
  if not found or v_claim.status <> 'running'
     or v_claim.policy_revision_id <> p_policy_revision_id
     or v_claim.run_source <> p_run_source
     or v_claim.actor_user_id is distinct from p_actor_user_id then
    raise exception 'scheduled forecast claim is not active' using errcode = 'P0002';
  end if;

  update ia_private.ia_scheduled_forecast_claims
  set status = 'failed',
      finished_at = now(),
      failure_code = p_failure_code,
      forecast_run_id = null
  where workspace_id = p_workspace_id and location_id = p_location_id
    and period_start = p_period_start and period_end = p_period_end
    and status = 'running';
end;
$$;

revoke all on function public.ia_server_claim_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid)
  from public, anon, authenticated;
revoke all on function public.ia_server_finish_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.ia_server_claim_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid)
  to service_role;
grant execute on function public.ia_server_finish_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid, text, text)
  to service_role;

comment on table ia_private.ia_scheduled_forecast_claims is
  'Server-only policy/history-bound concurrency, retry, and paid-forecast cooldown ledger.';
comment on function public.ia_server_claim_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid) is
  'Service-role-only claim for manual or scheduled forecast generation with current-policy, import-watermark, actor-scope, and cooldown checks.';
comment on function public.ia_server_finish_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid, text, text) is
  'Service-role-only failed-claim finalization; successful claims complete atomically inside ia_store_forecast_result.';

insert into public.ia_migration_markers (migration_id)
values ('20260716220000_email_delivery_verification');
