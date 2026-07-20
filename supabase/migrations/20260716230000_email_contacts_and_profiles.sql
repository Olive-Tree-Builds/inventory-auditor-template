-- Inventory Auditor: location-scoped email contacts, manual delivery audit fields,
-- and editable display-only profile position/title.

alter table public.ia_profiles
  add column position_title text
    check (
      position_title is null
      or (
        length(btrim(position_title)) between 1 and 120
        and position_title !~ '[[:cntrl:]]'
      )
    );

grant update (position_title) on public.ia_profiles to authenticated;

-- The UI, manual sender, and scheduler all share one workspace schedule. Do not
-- guess which legacy row to keep if an earlier deployment somehow created more.
do $$
begin
  if exists (
    select 1 from public.ia_email_schedules
    group by workspace_id having count(*) > 1
  ) then
    raise exception 'multiple email schedules exist for one workspace; resolve them before this migration'
      using errcode = '23505';
  end if;
end;
$$;

create unique index ia_email_schedules_one_per_workspace_idx
  on public.ia_email_schedules (workspace_id);

create or replace function public.ia_save_email_schedule(
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
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id and membership.status = 'active'
  limit 1;
  if v_user_id is null
     or coalesce((select ia_private.ia_current_workspace_role(v_workspace_id))::text, '')
       not in ('super_admin', 'admin') then
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
    select 1 from public.ia_workspaces as workspace
    where workspace.id = v_workspace_id
      and workspace.email_sending_enabled and workspace.status = 'active'
  ) then
    raise exception 'email delivery must be verified before enabling a schedule' using errcode = '23514';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('email-schedule:' || v_workspace_id::text, 0)
  );
  select schedule.id into v_schedule_id
  from public.ia_email_schedules as schedule
  where schedule.workspace_id = v_workspace_id
  for update;

  if p_schedule_id is not null and v_schedule_id is distinct from p_schedule_id then
    raise exception 'schedule not found' using errcode = 'P0002';
  end if;

  if v_schedule_id is null then
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
    where workspace_id = v_workspace_id and id = v_schedule_id;
  end if;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'email_schedule.saved', 'email_schedule', v_schedule_id,
    'success', jsonb_build_object('enabled', p_enabled, 'cadence', lower(p_cadence))
  );
  return v_schedule_id;
end;
$$;

create table public.ia_email_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  schedule_id uuid not null,
  email extensions.citext not null
    check (
      length(btrim(email::text)) between 3 and 320
      and email::text ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      and email::text !~ '[[:cntrl:]]'
    ),
  display_name text not null
    check (length(btrim(display_name)) between 1 and 120 and display_name !~ '[[:cntrl:]]'),
  enabled boolean not null default true,
  created_by uuid not null references auth.users(id) on delete restrict,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id),
  unique (workspace_id, schedule_id, id),
  foreign key (workspace_id, schedule_id)
    references public.ia_email_schedules(workspace_id, id) on delete restrict,
  check (archived_at is null or not enabled)
);

create unique index ia_email_contacts_active_address_idx
  on public.ia_email_contacts (workspace_id, schedule_id, email)
  where archived_at is null;

create table public.ia_email_contact_locations (
  workspace_id uuid not null,
  contact_id uuid not null,
  location_id uuid not null,
  assigned_by uuid not null references auth.users(id) on delete restrict,
  assigned_at timestamptz not null default now(),
  primary key (workspace_id, contact_id, location_id),
  foreign key (workspace_id, contact_id)
    references public.ia_email_contacts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, location_id)
    references public.ia_locations(workspace_id, id) on delete restrict
);

create index ia_email_contact_locations_location_idx
  on public.ia_email_contact_locations (workspace_id, location_id, contact_id);

-- Serialize both sides of the cross-table email identity rule. The route-level
-- precheck gives a friendly error; these triggers are the race-safe authority.
create function ia_private.ia_guard_email_contact_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email extensions.citext := lower(btrim(new.email::text))::extensions.citext;
begin
  if new.archived_at is not null then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-identity:' || new.workspace_id::text || ':' || v_email::text,
      0
    )
  );
  if exists (
    select 1 from public.ia_invitations as invitation
    where invitation.workspace_id = new.workspace_id
      and invitation.email = v_email
      and invitation.accepted_at is null
      and invitation.revoked_at is null
      and invitation.expires_at > now()
  ) then
    raise exception 'this email has a pending workspace invitation'
      using errcode = '23505';
  end if;
  if exists (
    select 1
    from public.ia_profiles as profile
    join public.ia_workspace_memberships as membership
      on membership.user_id = profile.user_id
     and membership.workspace_id = new.workspace_id
    where profile.email = v_email
  ) then
    raise exception 'this email belongs to a workspace user; use the user email setting instead'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

create function ia_private.ia_guard_invitation_contact_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email extensions.citext := lower(btrim(new.email::text))::extensions.citext;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-identity:' || new.workspace_id::text || ':' || v_email::text,
      0
    )
  );
  if exists (
    select 1 from public.ia_email_contacts as contact
    where contact.workspace_id = new.workspace_id
      and contact.email = v_email
      and contact.archived_at is null
  ) then
    raise exception 'invitation email belongs to an additional email recipient'
      using errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger ia_email_contacts_identity_guard
  before insert or update of workspace_id, email, archived_at
  on public.ia_email_contacts
  for each row execute function ia_private.ia_guard_email_contact_identity();

create trigger ia_invitations_contact_identity_guard
  before insert or update of workspace_id, email
  on public.ia_invitations
  for each row execute function ia_private.ia_guard_invitation_contact_identity();

alter table public.ia_email_deliveries
  alter column recipient_user_id drop not null,
  add column recipient_contact_id uuid,
  add column delivery_source text not null default 'scheduled'
    check (delivery_source in ('scheduled', 'manual')),
  add column triggered_by uuid,
  add column manual_dedupe_key text,
  add column current_attempt_id uuid,
  add constraint ia_email_deliveries_one_recipient_check
    check (num_nonnulls(recipient_user_id, recipient_contact_id) = 1),
  add constraint ia_email_deliveries_contact_fk
    foreign key (workspace_id, schedule_id, recipient_contact_id)
    references public.ia_email_contacts(workspace_id, schedule_id, id) on delete restrict,
  add constraint ia_email_deliveries_triggered_by_fk
    foreign key (workspace_id, triggered_by)
    references public.ia_workspace_memberships(workspace_id, user_id) on delete restrict,
  add constraint ia_email_deliveries_source_actor_check
    check (
      (delivery_source = 'scheduled' and triggered_by is null)
      or (delivery_source = 'manual' and triggered_by is not null)
    ),
  add constraint ia_email_deliveries_manual_dedupe_check
    check (
      (delivery_source = 'scheduled' and manual_dedupe_key is null)
      or (
        delivery_source = 'manual'
        and manual_dedupe_key ~ '^inventory-auditor:manual-dedupe:[0-9a-f]{64}$'
      )
    );

update public.ia_email_deliveries as delivery
set current_attempt_id = (
  select attempt.id
  from public.ia_email_delivery_attempts as attempt
  where attempt.workspace_id = delivery.workspace_id
    and attempt.delivery_id = delivery.id
    and attempt.status = 'started'
  order by attempt.attempt_number desc
  limit 1
)
where delivery.status = 'sending';

create index ia_email_deliveries_contact_idx
  on public.ia_email_deliveries (workspace_id, recipient_contact_id, created_at desc)
  where recipient_contact_id is not null;

create index ia_email_deliveries_manual_dedupe_idx
  on public.ia_email_deliveries (workspace_id, manual_dedupe_key, created_at desc)
  where delivery_source = 'manual';

create trigger ia_email_contacts_updated_at before update on public.ia_email_contacts
  for each row execute function ia_private.ia_set_updated_at();

create function public.ia_save_email_contact(
  p_contact_id uuid,
  p_schedule_id uuid,
  p_email text,
  p_display_name text,
  p_enabled boolean,
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
  v_contact_id uuid;
  v_email extensions.citext;
begin
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id and membership.status = 'active'
  limit 1;

  if v_user_id is null
     or v_workspace_id is null
     or coalesce((select ia_private.ia_current_workspace_role(v_workspace_id))::text, '')
       not in ('super_admin', 'admin') then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')))::extensions.citext;
  if length(v_email::text) not between 3 and 320
     or v_email::text !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or v_email::text ~ '[[:cntrl:]]'
     or length(btrim(coalesce(p_display_name, ''))) not between 1 and 120
     or btrim(p_display_name) ~ '[[:cntrl:]]'
     or p_enabled is null then
    raise exception 'invalid email recipient' using errcode = '22023';
  end if;

  if not exists (
    select 1 from public.ia_email_schedules as schedule
    where schedule.workspace_id = v_workspace_id and schedule.id = p_schedule_id
  ) then
    raise exception 'email schedule not found' using errcode = 'P0002';
  end if;

  if coalesce(cardinality(p_location_ids), 0) < 1
     or cardinality(p_location_ids) > 100
     or cardinality(p_location_ids) <> (
       select count(distinct requested.id)::integer
       from unnest(p_location_ids) as requested(id)
     ) then
    raise exception 'choose between one and one hundred unique locations' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(p_location_ids) as requested(id)
    where not exists (
      select 1 from public.ia_locations as location
      where location.workspace_id = v_workspace_id
        and location.id = requested.id
        and location.is_active
    )
  ) then
    raise exception 'one or more locations are invalid or inactive' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.ia_profiles as profile
    join public.ia_workspace_memberships as membership
      on membership.user_id = profile.user_id
     and membership.workspace_id = v_workspace_id
    where profile.email = v_email
  ) then
    raise exception 'this email belongs to a workspace user; use the user email setting instead'
      using errcode = '23505';
  end if;

  if p_contact_id is null then
    insert into public.ia_email_contacts (
      workspace_id, schedule_id, email, display_name, enabled, created_by, updated_by
    ) values (
      v_workspace_id, p_schedule_id, v_email, btrim(p_display_name), p_enabled, v_user_id, v_user_id
    ) returning id into v_contact_id;
  else
    update public.ia_email_contacts
    set email = v_email,
        display_name = btrim(p_display_name),
        enabled = p_enabled,
        updated_by = v_user_id
    where workspace_id = v_workspace_id
      and schedule_id = p_schedule_id
      and id = p_contact_id
      and archived_at is null
    returning id into v_contact_id;
    if v_contact_id is null then
      raise exception 'email recipient not found' using errcode = 'P0002';
    end if;
  end if;

  delete from public.ia_email_contact_locations
  where workspace_id = v_workspace_id and contact_id = v_contact_id;

  insert into public.ia_email_contact_locations (
    workspace_id, contact_id, location_id, assigned_by
  )
  select v_workspace_id, v_contact_id, requested.id, v_user_id
  from unnest(p_location_ids) as requested(id);

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'email_contact.saved', 'email_contact', v_contact_id,
    'success', jsonb_build_object(
      'enabled', p_enabled,
      'schedule_id', p_schedule_id,
      'location_count', cardinality(p_location_ids)
    )
  );

  return v_contact_id;
end;
$$;

create function public.ia_archive_email_contact(p_contact_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_contact_id uuid;
begin
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id and membership.status = 'active'
  limit 1;

  if v_user_id is null
     or v_workspace_id is null
     or coalesce((select ia_private.ia_current_workspace_role(v_workspace_id))::text, '')
       not in ('super_admin', 'admin') then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;

  update public.ia_email_contacts
  set enabled = false, archived_at = now(), updated_by = v_user_id
  where workspace_id = v_workspace_id and id = p_contact_id and archived_at is null
  returning id into v_contact_id;
  if v_contact_id is null then
    raise exception 'email recipient not found' using errcode = 'P0002';
  end if;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'email_contact.archived', 'email_contact', v_contact_id,
    'success', '{}'::jsonb
  );
  return v_contact_id;
end;
$$;

-- Keep invitation consumption atomic with contact creation. The invitation row
-- lock protects one-time use; the shared advisory lock protects the email
-- identity across the two separate tables until this transaction commits.
create or replace function public.ia_accept_invitation(p_token text)
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

  select user_record.email::extensions.citext into v_auth_email
  from auth.users as user_record where user_record.id = v_user_id;

  select invitation.* into v_invitation
  from public.ia_invitations as invitation
  where invitation.token_hash = extensions.digest(p_token, 'sha256')
  for update;

  if not found
     or v_invitation.accepted_at is not null
     or v_invitation.revoked_at is not null
     or v_invitation.expires_at <= now()
     or v_auth_email is null
     or v_auth_email <> v_invitation.email then
    raise exception 'invitation is invalid or expired' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'email-identity:' || v_invitation.workspace_id::text || ':' ||
        lower(btrim(v_invitation.email::text)),
      0
    )
  );
  if exists (
    select 1 from public.ia_email_contacts as contact
    where contact.workspace_id = v_invitation.workspace_id
      and contact.email = v_invitation.email
      and contact.archived_at is null
  ) then
    raise exception 'invitation email belongs to an additional email recipient'
      using errcode = '23505';
  end if;

  if not exists (
    select 1 from public.ia_installation_state as state
    where state.singleton and state.workspace_id = v_invitation.workspace_id
  ) then
    raise exception 'invitation workspace is not active' using errcode = '42501';
  end if;

  select count(*) into v_location_count
  from public.ia_invitation_locations as invitation_location
  join public.ia_locations as location
    on location.workspace_id = invitation_location.workspace_id
   and location.id = invitation_location.location_id
  where invitation_location.workspace_id = v_invitation.workspace_id
    and invitation_location.invitation_id = v_invitation.id
    and location.is_active;
  if v_location_count < 1 then
    raise exception 'at least one active location assignment is required' using errcode = '23514';
  end if;

  insert into public.ia_profiles (user_id, email, username, display_name)
  values (v_user_id, v_auth_email, v_invitation.username, v_invitation.display_name)
  on conflict (user_id) do update
    set email = excluded.email,
        username = excluded.username,
        display_name = excluded.display_name;

  insert into public.ia_workspace_memberships (
    workspace_id, user_id, role, status, email_enabled, created_by
  ) values (
    v_invitation.workspace_id, v_user_id, v_invitation.role, 'active',
    v_invitation.email_enabled, v_invitation.created_by
  ) returning id into v_membership_id;

  insert into public.ia_user_location_assignments (
    workspace_id, user_id, location_id, assigned_by
  )
  select invitation_location.workspace_id, v_user_id,
    invitation_location.location_id, v_invitation.created_by
  from public.ia_invitation_locations as invitation_location
  join public.ia_locations as location
    on location.workspace_id = invitation_location.workspace_id
   and location.id = invitation_location.location_id
  where invitation_location.workspace_id = v_invitation.workspace_id
    and invitation_location.invitation_id = v_invitation.id
    and location.is_active;

  update public.ia_invitations
  set accepted_by = v_user_id, accepted_at = now()
  where id = v_invitation.id
    and accepted_at is null and revoked_at is null;
  if not found then
    raise exception 'invitation acceptance lost its one-time claim' using errcode = '40001';
  end if;

  workspace_id := v_invitation.workspace_id;
  membership_id := v_membership_id;
  return next;
end;
$$;

create function public.ia_server_claim_manual_email_delivery(
  p_workspace_id uuid,
  p_schedule_id uuid,
  p_recipient_user_id uuid,
  p_recipient_contact_id uuid,
  p_triggered_by uuid,
  p_period_start date,
  p_period_end date,
  p_due_at timestamptz,
  p_idempotency_key text,
  p_manual_dedupe_key text
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_delivery_id uuid;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_workspace_id is null or p_schedule_id is null or p_triggered_by is null
     or p_period_start is null or p_period_end is null
     or p_period_start > p_period_end or p_period_end - p_period_start > 366
     or p_due_at is null
     or num_nonnulls(p_recipient_user_id, p_recipient_contact_id) <> 1
     or coalesce(p_idempotency_key, '') !~ '^inventory-auditor:manual:[0-9a-f]{64}$'
     or coalesce(p_manual_dedupe_key, '') !~ '^inventory-auditor:manual-dedupe:[0-9a-f]{64}$' then
    raise exception 'invalid manual email delivery claim' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.ia_workspaces as workspace
    join public.ia_email_schedules as schedule
      on schedule.workspace_id = workspace.id and schedule.id = p_schedule_id
    where workspace.id = p_workspace_id and workspace.status = 'active'
      and workspace.email_sending_enabled
  ) or not exists (
    select 1 from public.ia_workspace_memberships as actor
    where actor.workspace_id = p_workspace_id
      and actor.user_id = p_triggered_by
      and actor.status = 'active'
      and actor.role in ('super_admin', 'admin')
  ) then
    raise exception 'manual email workspace or actor is not eligible' using errcode = '42501';
  end if;
  if p_recipient_user_id is not null and not exists (
    select 1 from public.ia_workspace_memberships as recipient
    where recipient.workspace_id = p_workspace_id
      and recipient.user_id = p_recipient_user_id
      and recipient.status = 'active' and recipient.email_enabled
  ) then
    raise exception 'manual email user is not eligible' using errcode = '42501';
  elsif p_recipient_contact_id is not null and not exists (
    select 1 from public.ia_email_contacts as contact
    where contact.workspace_id = p_workspace_id
      and contact.schedule_id = p_schedule_id
      and contact.id = p_recipient_contact_id
      and contact.enabled and contact.archived_at is null
  ) then
    raise exception 'manual email contact is not eligible' using errcode = '42501';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'manual-email:' || p_workspace_id::text || ':' || p_manual_dedupe_key,
      0
    )
  );
  if exists (
    select 1 from public.ia_email_deliveries as delivery
    where delivery.workspace_id = p_workspace_id
      and delivery.delivery_source = 'manual'
      and delivery.manual_dedupe_key = p_manual_dedupe_key
      and delivery.created_at > now() - interval '5 minutes'
  ) then
    return null;
  end if;

  insert into public.ia_email_deliveries (
    workspace_id, schedule_id, recipient_user_id, recipient_contact_id,
    delivery_source, triggered_by, manual_dedupe_key,
    forecast_period_start, forecast_period_end, due_at, status, idempotency_key
  ) values (
    p_workspace_id, p_schedule_id, p_recipient_user_id, p_recipient_contact_id,
    'manual', p_triggered_by, p_manual_dedupe_key,
    p_period_start, p_period_end, p_due_at, 'sending', p_idempotency_key
  ) returning id into v_delivery_id;
  return v_delivery_id;
end;
$$;

create function public.ia_server_finish_email_delivery(
  p_workspace_id uuid,
  p_delivery_id uuid,
  p_attempt_id uuid,
  p_outcome text,
  p_provider_message_id text,
  p_failure_code text
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_attempt_status text;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_workspace_id is null or p_delivery_id is null or p_attempt_id is null
     or coalesce(p_outcome, '') not in ('sent', 'failed', 'cancelled')
     or (
       p_outcome = 'sent' and (
         length(btrim(coalesce(p_provider_message_id, ''))) not between 1 and 200
         or p_provider_message_id ~ '[[:cntrl:]]'
         or p_failure_code is not null
       )
     )
     or (
       p_outcome <> 'sent' and (
         p_provider_message_id is not null
         or coalesce(p_failure_code, '') !~ '^[a-z][a-z0-9_]{0,63}$'
       )
     ) then
    raise exception 'invalid email delivery result' using errcode = '22023';
  end if;

  perform 1 from public.ia_email_deliveries as delivery
  where delivery.workspace_id = p_workspace_id
    and delivery.id = p_delivery_id
    and delivery.status = 'sending'
    and delivery.current_attempt_id = p_attempt_id
  for update;
  if not found then return false; end if;

  select attempt.status into v_attempt_status
  from public.ia_email_delivery_attempts as attempt
  where attempt.workspace_id = p_workspace_id
    and attempt.delivery_id = p_delivery_id
    and attempt.id = p_attempt_id
  for update;
  if not found or v_attempt_status <> 'started' then return false; end if;

  update public.ia_email_delivery_attempts
  set status = case when p_outcome = 'sent' then 'sent' else 'failed' end,
      provider_message_id = case when p_outcome = 'sent' then btrim(p_provider_message_id) end,
      failure_code = case when p_outcome = 'sent' then null else p_failure_code end
  where workspace_id = p_workspace_id and delivery_id = p_delivery_id
    and id = p_attempt_id and status = 'started';

  update public.ia_email_deliveries
  set status = p_outcome::public.ia_delivery_status,
      provider_message_id = case when p_outcome = 'sent' then btrim(p_provider_message_id) end,
      failure_code = case when p_outcome = 'sent' then null else p_failure_code end,
      sent_at = case when p_outcome = 'sent' then now() end
  where workspace_id = p_workspace_id and id = p_delivery_id
    and status = 'sending' and current_attempt_id = p_attempt_id;
  return found;
end;
$$;

-- Every forecast generation attempt receives a unique token. A worker whose
-- lease was refreshed cannot fail or store over the newer attempt.
alter table ia_private.ia_scheduled_forecast_claims
  add column claim_token uuid not null default gen_random_uuid();

create unique index ia_scheduled_forecast_claim_token_idx
  on ia_private.ia_scheduled_forecast_claims (claim_token);

drop function public.ia_server_claim_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid);

create function public.ia_server_claim_scheduled_forecast(
  p_workspace_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end date,
  p_policy_revision_id uuid,
  p_run_source text,
  p_actor_user_id uuid
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claim ia_private.ia_scheduled_forecast_claims%rowtype;
  v_history_watermark timestamptz;
  v_claim_token uuid := gen_random_uuid();
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
         on location.workspace_id = state.workspace_id and location.id = p_location_id
       where state.singleton and state.workspace_id = p_workspace_id and location.is_active
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
    history_watermark, run_source, actor_user_id, status, claimed_at, claim_token
  ) values (
    p_workspace_id, p_location_id, p_period_start, p_period_end, p_policy_revision_id,
    v_history_watermark, p_run_source, p_actor_user_id, 'running', now(), v_claim_token
  )
  on conflict do nothing;
  if found then return v_claim_token; end if;

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
    return null;
  end if;
  if v_claim.status = 'running' and v_claim.claimed_at > now() - interval '15 minutes' then
    return null;
  end if;
  if v_claim.status = 'failed'
     and v_claim.policy_revision_id = p_policy_revision_id
     and v_claim.history_watermark is not distinct from v_history_watermark
     and coalesce(v_claim.finished_at, v_claim.claimed_at) > now() - interval '15 minutes' then
    return null;
  end if;

  v_claim_token := gen_random_uuid();
  update ia_private.ia_scheduled_forecast_claims
  set policy_revision_id = p_policy_revision_id,
      history_watermark = v_history_watermark,
      run_source = p_run_source,
      actor_user_id = p_actor_user_id,
      forecast_run_id = null,
      claim_token = v_claim_token,
      status = 'running', claimed_at = now(), finished_at = null, failure_code = null
  where workspace_id = p_workspace_id and location_id = p_location_id
    and period_start = p_period_start and period_end = p_period_end;
  return v_claim_token;
end;
$$;

drop function public.ia_server_finish_scheduled_forecast(uuid, uuid, date, date, uuid, text, uuid, text, text);

create function public.ia_server_finish_scheduled_forecast(
  p_workspace_id uuid,
  p_location_id uuid,
  p_period_start date,
  p_period_end date,
  p_policy_revision_id uuid,
  p_run_source text,
  p_actor_user_id uuid,
  p_claim_token uuid,
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
     or p_policy_revision_id is null or p_claim_token is null
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
     or v_claim.claim_token <> p_claim_token
     or v_claim.policy_revision_id <> p_policy_revision_id
     or v_claim.run_source <> p_run_source
     or v_claim.actor_user_id is distinct from p_actor_user_id then
    raise exception 'scheduled forecast claim is not active' using errcode = 'P0002';
  end if;

  update ia_private.ia_scheduled_forecast_claims
  set status = 'failed', finished_at = now(), failure_code = p_failure_code,
      forecast_run_id = null
  where workspace_id = p_workspace_id and location_id = p_location_id
    and period_start = p_period_start and period_end = p_period_end
    and status = 'running' and claim_token = p_claim_token;
  if not found then
    raise exception 'scheduled forecast claim changed before failure was stored'
      using errcode = '40001';
  end if;
end;
$$;

-- Move the foundation storage routine behind a token-checking public wrapper.
-- The row lock acquired here remains held while the original atomic store runs.
alter function public.ia_store_forecast_result(jsonb, jsonb, jsonb)
  set schema ia_private;
alter function ia_private.ia_store_forecast_result(jsonb, jsonb, jsonb)
  rename to ia_store_forecast_result_unchecked;

revoke all on function ia_private.ia_store_forecast_result_unchecked(jsonb, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function ia_private.ia_store_forecast_result_unchecked(jsonb, jsonb, jsonb)
  to service_role;

create function public.ia_store_forecast_result(
  p_claim_token uuid,
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
  v_location_id uuid;
  v_period_start date;
  v_period_end date;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_claim_token is null or jsonb_typeof(p_run) <> 'object'
     or not (p_run ?& array['location_id', 'period_start', 'period_end']) then
    raise exception 'claim-bound forecast payload required' using errcode = '22023';
  end if;
  select state.workspace_id into v_workspace_id
  from public.ia_installation_state as state
  join public.ia_workspaces as workspace on workspace.id = state.workspace_id
  where state.singleton and workspace.status = 'active';
  v_location_id := (p_run ->> 'location_id')::uuid;
  v_period_start := (p_run ->> 'period_start')::date;
  v_period_end := (p_run ->> 'period_end')::date;

  perform 1 from ia_private.ia_scheduled_forecast_claims as claim
  where claim.workspace_id = v_workspace_id
    and claim.location_id = v_location_id
    and claim.period_start = v_period_start
    and claim.period_end = v_period_end
    and claim.status = 'running'
    and claim.claim_token = p_claim_token
  for update;
  if not found then
    raise exception 'matching forecast claim token required' using errcode = '42501';
  end if;

  return query
  select stored.run_id
  from ia_private.ia_store_forecast_result_unchecked(p_run, p_items, p_sources) as stored;
end;
$$;

alter table public.ia_email_contacts enable row level security;
alter table public.ia_email_contacts force row level security;
alter table public.ia_email_contact_locations enable row level security;
alter table public.ia_email_contact_locations force row level security;

create policy ia_email_contacts_select on public.ia_email_contacts for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));
create policy ia_email_contact_locations_select on public.ia_email_contact_locations for select to authenticated
  using ((select ia_private.ia_current_workspace_role(workspace_id)) in ('super_admin', 'admin'));

revoke all on table public.ia_email_contacts from public, anon, authenticated;
revoke all on table public.ia_email_contact_locations from public, anon, authenticated;
grant select on public.ia_email_contacts, public.ia_email_contact_locations to authenticated;
grant select, insert, update, delete on public.ia_email_contacts, public.ia_email_contact_locations to service_role;

revoke all on function public.ia_save_email_contact(uuid, uuid, text, text, boolean, uuid[])
  from public, anon, authenticated;
revoke all on function public.ia_archive_email_contact(uuid)
  from public, anon, authenticated;
revoke all on function ia_private.ia_guard_email_contact_identity()
  from public, anon, authenticated, service_role;
revoke all on function ia_private.ia_guard_invitation_contact_identity()
  from public, anon, authenticated, service_role;
revoke all on function public.ia_server_claim_manual_email_delivery(
  uuid, uuid, uuid, uuid, uuid, date, date, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.ia_server_finish_email_delivery(
  uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.ia_server_claim_scheduled_forecast(
  uuid, uuid, date, date, uuid, text, uuid
) from public, anon, authenticated;
revoke all on function public.ia_server_finish_scheduled_forecast(
  uuid, uuid, date, date, uuid, text, uuid, uuid, text, text
) from public, anon, authenticated;
revoke all on function public.ia_store_forecast_result(uuid, jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ia_save_email_contact(uuid, uuid, text, text, boolean, uuid[])
  to authenticated;
grant execute on function public.ia_archive_email_contact(uuid)
  to authenticated;
grant execute on function public.ia_server_claim_manual_email_delivery(
  uuid, uuid, uuid, uuid, uuid, date, date, timestamptz, text, text
) to service_role;
grant execute on function public.ia_server_finish_email_delivery(
  uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.ia_server_claim_scheduled_forecast(
  uuid, uuid, date, date, uuid, text, uuid
) to service_role;
grant execute on function public.ia_server_finish_scheduled_forecast(
  uuid, uuid, date, date, uuid, text, uuid, uuid, text, text
) to service_role;
grant execute on function public.ia_store_forecast_result(uuid, jsonb, jsonb, jsonb)
  to service_role;

comment on table public.ia_email_contacts is
  'Additional non-login forecast email recipients. Every active contact has explicit location mappings.';
comment on function public.ia_save_email_contact(uuid, uuid, text, text, boolean, uuid[]) is
  'Admin-only atomic save of a schedule contact and its location-scoped delivery authorization.';
comment on function public.ia_archive_email_contact(uuid) is
  'Admin-only archive of an additional email contact without deleting delivery history.';
comment on function public.ia_server_claim_manual_email_delivery(
  uuid, uuid, uuid, uuid, uuid, date, date, timestamptz, text, text
) is 'Service-role-only rolling five-minute manual email claim, serialized per recipient and exact forecast set.';
comment on function public.ia_server_finish_email_delivery(
  uuid, uuid, uuid, text, text, text
) is 'Service-role-only atomic email completion bound to the delivery current attempt.';
comment on function public.ia_store_forecast_result(uuid, jsonb, jsonb, jsonb) is
  'Service-role-only forecast storage wrapper bound to the current generation claim token.';

insert into public.ia_migration_markers (migration_id)
values ('20260716230000_email_contacts_and_profiles');
