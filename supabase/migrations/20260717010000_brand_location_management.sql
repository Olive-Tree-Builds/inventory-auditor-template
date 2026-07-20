-- Inventory Auditor: editable brands and locations, per-brand timezone defaults,
-- and a public, non-sensitive logo bucket with server-only writes.

alter table public.ia_brands
  add column default_time_zone text,
  add column logo_object_path text;

update public.ia_brands as brand
set default_time_zone = workspace.default_time_zone
from public.ia_workspaces as workspace
where workspace.id = brand.workspace_id;

alter table public.ia_brands
  alter column default_time_zone set not null,
  add constraint ia_brands_default_time_zone_check check (
    length(btrim(default_time_zone)) between 1 and 100
    and default_time_zone !~ '[[:cntrl:]]'
  ),
  add constraint ia_brands_logo_object_path_check check (
    logo_object_path is null
    or logo_object_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|webp)$'
  );

-- Public means anyone with the object URL can read a logo. It does not grant
-- uploads, updates, or deletes. No authenticated storage.objects write policy
-- is created; the application route writes with the server-only secret key.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'brand-logos',
  'brand-logos',
  true,
  2097152,
  array['image/png', 'image/jpeg', 'image/webp']::text[]
)
on conflict (id) do nothing;

do $$
declare
  v_bucket storage.buckets%rowtype;
begin
  select bucket.* into v_bucket
  from storage.buckets as bucket
  where bucket.id = 'brand-logos';
  if not found
     or not v_bucket.public
     or v_bucket.file_size_limit is distinct from 2097152
     or v_bucket.allowed_mime_types is null
     or not (
       v_bucket.allowed_mime_types @> array['image/png', 'image/jpeg', 'image/webp']::text[]
       and v_bucket.allowed_mime_types <@ array['image/png', 'image/jpeg', 'image/webp']::text[]
     ) then
    raise exception 'brand-logos Storage bucket exists with unsafe or incompatible settings'
      using errcode = '23514';
  end if;
end;
$$;

-- This trigger is the race-safe invariant behind every location write. It
-- serializes against brand deactivation and prevents an active location from
-- being inserted or reactivated under an inactive brand.
create function ia_private.ia_guard_location_brand_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_brand_active boolean;
begin
  select brand.archived_at is null into v_brand_active
  from public.ia_brands as brand
  where brand.workspace_id = new.workspace_id and brand.id = new.brand_id
  for update;
  if not found then
    raise exception 'location brand not found' using errcode = '23503';
  end if;
  if new.is_active and not v_brand_active then
    raise exception 'cannot activate a location under an inactive brand' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger ia_locations_guard_brand_state
  before insert or update of workspace_id, brand_id, is_active, archived_at
  on public.ia_locations
  for each row execute function ia_private.ia_guard_location_brand_state();

revoke all on function public.ia_create_brand(text, text) from public, anon, authenticated;
drop function public.ia_create_brand(text, text);

create function public.ia_create_brand(
  p_name text,
  p_code text,
  p_default_time_zone text
)
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
  v_time_zone text := btrim(coalesce(p_default_time_zone, ''));
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id
    and membership.status = 'active'
    and membership.role in ('super_admin', 'admin')
  limit 1;
  if v_workspace_id is null then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) not between 2 and 120
     or btrim(p_name) ~ '[[:cntrl:]]'
     or v_code !~ '^[a-z0-9][a-z0-9_-]{1,23}$'
     or length(v_time_zone) not between 3 and 100
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as zone where zone.name = v_time_zone
     ) then
    raise exception 'invalid brand' using errcode = '22023';
  end if;

  insert into public.ia_brands (
    workspace_id, name, code, default_time_zone, created_by
  ) values (
    v_workspace_id, btrim(p_name), v_code, v_time_zone, v_user_id
  ) returning * into v_brand;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'brand.created', 'brand', v_brand.id, 'success',
    jsonb_build_object('code', v_brand.code::text, 'default_time_zone', v_brand.default_time_zone)
  );

  return jsonb_build_object(
    'id', v_brand.id,
    'name', v_brand.name,
    'code', v_brand.code::text,
    'default_time_zone', v_brand.default_time_zone,
    'is_active', v_brand.is_active
  );
end;
$$;

create function public.ia_update_brand(
  p_brand_id uuid,
  p_name text,
  p_code text,
  p_default_time_zone text,
  p_is_active boolean,
  p_expected_updated_at timestamptz
)
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
  v_time_zone text := btrim(coalesce(p_default_time_zone, ''));
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id
    and membership.status = 'active'
    and membership.role in ('super_admin', 'admin')
  limit 1;
  if v_workspace_id is null then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if p_brand_id is null
     or p_is_active is null
     or p_expected_updated_at is null
     or length(btrim(coalesce(p_name, ''))) not between 2 and 120
     or btrim(p_name) ~ '[[:cntrl:]]'
     or v_code !~ '^[a-z0-9][a-z0-9_-]{1,23}$'
     or length(v_time_zone) not between 3 and 100
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as zone where zone.name = v_time_zone
     ) then
    raise exception 'invalid brand' using errcode = '22023';
  end if;

  select brand.* into v_brand
  from public.ia_brands as brand
  where brand.workspace_id = v_workspace_id and brand.id = p_brand_id
  for update;
  if not found then
    raise exception 'brand not found' using errcode = 'P0002';
  end if;
  if v_brand.updated_at is distinct from p_expected_updated_at then
    raise exception 'brand was changed by another administrator'
      using errcode = 'IA409';
  end if;
  if not p_is_active and exists (
    select 1 from public.ia_locations as location
    where location.workspace_id = v_workspace_id
      and location.brand_id = p_brand_id
      and location.is_active
  ) then
    raise exception 'brand has an active location' using errcode = '23514';
  end if;

  update public.ia_brands
  set name = btrim(p_name),
      code = v_code,
      default_time_zone = v_time_zone,
      archived_at = case
        when p_is_active then null
        else coalesce(v_brand.archived_at, now())
      end
  where workspace_id = v_workspace_id and id = p_brand_id
  returning * into v_brand;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'brand.updated', 'brand', v_brand.id, 'success',
    jsonb_build_object(
      'code', v_brand.code::text,
      'default_time_zone', v_brand.default_time_zone,
      'is_active', v_brand.is_active
    )
  );

  return jsonb_build_object(
    'id', v_brand.id,
    'name', v_brand.name,
    'code', v_brand.code::text,
    'default_time_zone', v_brand.default_time_zone,
    'is_active', v_brand.is_active,
    'updated_at', v_brand.updated_at
  );
end;
$$;

create function public.ia_update_location(
  p_location_id uuid,
  p_name text,
  p_import_code text,
  p_street_address text,
  p_city text,
  p_region text,
  p_postal_code text,
  p_country_code text,
  p_time_zone text,
  p_is_active boolean,
  p_expected_updated_at timestamptz
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
  v_time_zone text := btrim(coalesce(p_time_zone, ''));
begin
  if v_user_id is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  select membership.workspace_id into v_workspace_id
  from public.ia_workspace_memberships as membership
  where membership.user_id = v_user_id
    and membership.status = 'active'
    and membership.role in ('super_admin', 'admin')
  limit 1;
  if v_workspace_id is null then
    raise exception 'workspace administrator required' using errcode = '42501';
  end if;
  if p_location_id is null
     or p_is_active is null
     or p_expected_updated_at is null
     or length(btrim(coalesce(p_name, ''))) not between 2 and 120
     or btrim(p_name) ~ '[[:cntrl:]]'
     or v_import_code !~ '^[a-z0-9][a-z0-9_-]{1,23}$'
     or length(btrim(coalesce(p_street_address, ''))) not between 2 and 160
     or btrim(p_street_address) ~ '[[:cntrl:]]'
     or length(btrim(coalesce(p_city, ''))) not between 2 and 100
     or btrim(p_city) ~ '[[:cntrl:]]'
     or length(btrim(coalesce(p_region, ''))) not between 2 and 100
     or btrim(p_region) ~ '[[:cntrl:]]'
     or length(btrim(coalesce(p_postal_code, ''))) not between 2 and 20
     or btrim(p_postal_code) ~ '[[:cntrl:]]'
     or v_country_code !~ '^[A-Z]{2}$'
     or length(v_time_zone) not between 3 and 80
     or not exists (
       select 1 from pg_catalog.pg_timezone_names as zone where zone.name = v_time_zone
     ) then
    raise exception 'invalid location' using errcode = '22023';
  end if;

  select location.* into v_location
  from public.ia_locations as location
  where location.workspace_id = v_workspace_id and location.id = p_location_id
  for update;
  if not found then
    raise exception 'location not found' using errcode = 'P0002';
  end if;
  if v_location.updated_at is distinct from p_expected_updated_at then
    raise exception 'location was changed by another administrator'
      using errcode = 'IA409';
  end if;
  if p_is_active and not exists (
    select 1 from public.ia_brands as brand
    where brand.workspace_id = v_workspace_id
      and brand.id = v_location.brand_id
      and brand.archived_at is null
  ) then
    raise exception 'cannot activate a location under an inactive brand' using errcode = '23514';
  end if;

  update public.ia_locations
  set name = btrim(p_name),
      import_code = v_import_code,
      street_address = btrim(p_street_address),
      city = btrim(p_city),
      region = btrim(p_region),
      postal_code = btrim(p_postal_code),
      country_code = v_country_code,
      time_zone = v_time_zone,
      is_active = p_is_active,
      archived_at = case
        when p_is_active then null
        else coalesce(v_location.archived_at, now())
      end
  where workspace_id = v_workspace_id and id = p_location_id
  returning * into v_location;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    v_workspace_id, v_user_id, 'location.updated', 'location', v_location.id, 'success',
    jsonb_build_object(
      'brand_id', v_location.brand_id,
      'import_code', v_location.import_code::text,
      'time_zone', v_location.time_zone,
      'is_active', v_location.is_active
    )
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
    'is_active', v_location.is_active,
    'updated_at', v_location.updated_at
  );
end;
$$;

-- The route uploads a uniquely named object first, then atomically swaps the
-- database pointer through this service-only function. Its returned old path is
-- removed through the Storage API; Storage metadata must never be deleted via SQL.
create function public.ia_server_set_brand_logo(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_brand_id uuid,
  p_new_object_path text
)
returns text
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_old_object_path text;
begin
  if current_user <> 'service_role'
     and coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_workspace_id is null
     or p_actor_user_id is null
     or p_brand_id is null
     or not exists (
       select 1 from public.ia_workspace_memberships as actor
       where actor.workspace_id = p_workspace_id
         and actor.user_id = p_actor_user_id
         and actor.status = 'active'
         and actor.role in ('super_admin', 'admin')
     )
     or (
       p_new_object_path is not null
       and (
         length(p_new_object_path) > 200
         or p_new_object_path !~ (
           '^' || p_workspace_id::text || '/' || p_brand_id::text ||
           '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](png|jpg|webp)$'
         )
       )
     ) then
    raise exception 'brand logo scope denied' using errcode = '42501';
  end if;

  select brand.logo_object_path into v_old_object_path
  from public.ia_brands as brand
  where brand.workspace_id = p_workspace_id and brand.id = p_brand_id
  for update;
  if not found then
    raise exception 'brand not found' using errcode = 'P0002';
  end if;

  update public.ia_brands
  set logo_object_path = p_new_object_path
  where workspace_id = p_workspace_id and id = p_brand_id;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id, outcome, metadata
  ) values (
    p_workspace_id, p_actor_user_id, 'brand.logo.updated', 'brand', p_brand_id,
    'success', jsonb_build_object('has_logo', p_new_object_path is not null)
  );
  return v_old_object_path;
end;
$$;

revoke all on function public.ia_create_brand(text, text, text)
  from public, anon, authenticated;
revoke all on function public.ia_update_brand(uuid, text, text, text, boolean, timestamptz)
  from public, anon, authenticated;
revoke all on function public.ia_update_location(
  uuid, text, text, text, text, text, text, text, text, boolean, timestamptz
) from public, anon, authenticated;
revoke all on function public.ia_server_set_brand_logo(uuid, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function ia_private.ia_guard_location_brand_state()
  from public, anon, authenticated, service_role;

grant execute on function public.ia_create_brand(text, text, text) to authenticated;
grant execute on function public.ia_update_brand(uuid, text, text, text, boolean, timestamptz) to authenticated;
grant execute on function public.ia_update_location(
  uuid, text, text, text, text, text, text, text, text, boolean, timestamptz
) to authenticated;
grant execute on function public.ia_server_set_brand_logo(uuid, uuid, uuid, text) to service_role;

comment on column public.ia_brands.default_time_zone is
  'IANA timezone used as the default when an administrator creates a location for this brand.';
comment on column public.ia_brands.logo_object_path is
  'Non-secret public Storage object path. Objects contain brand artwork only, never customer data.';
comment on function public.ia_create_brand(text, text, text) is
  'Admin-only normalized brand creation with a validated IANA default timezone and atomic audit event.';
comment on function public.ia_update_brand(uuid, text, text, text, boolean, timestamptz) is
  'Admin-only workspace-scoped brand edit with optimistic concurrency; active locations block brand deactivation.';
comment on function public.ia_update_location(
  uuid, text, text, text, text, text, text, text, text, boolean, timestamptz
) is 'Admin-only workspace-scoped location edit with IANA timezone validation and optimistic concurrency.';
comment on function public.ia_server_set_brand_logo(uuid, uuid, uuid, text) is
  'Service-role-only atomic brand logo pointer swap returning the replaced Storage object path.';
comment on function ia_private.ia_guard_location_brand_state() is
  'Unexposed trigger invariant serializing active location writes against brand deactivation.';

insert into public.ia_migration_markers (migration_id)
values ('20260717010000_brand_location_management');
