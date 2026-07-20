-- Inventory Auditor: brand-guided historical imports.
--
-- Administrators select one brand, the application resolves spreadsheet labels
-- to active locations/products, and these RPCs repeat every critical scope and
-- type check before any write. The original ia_import_historical_sales RPC is
-- retained as a compatibility wrapper.

create table public.ia_location_import_aliases (
  workspace_id uuid not null,
  brand_id uuid not null,
  source_name extensions.citext not null,
  location_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (workspace_id, brand_id, source_name),
  foreign key (workspace_id, brand_id, location_id)
    references public.ia_locations(workspace_id, brand_id, id) on delete cascade,
  check (
    length(source_name::text) between 1 and 160
    and source_name::text = btrim(source_name::text)
    and source_name::text = regexp_replace(
      source_name::text, '[[:space:]]+', ' ', 'g'
    )
    and source_name::text !~ '[[:cntrl:]]'
  )
);

create table public.ia_product_import_aliases (
  workspace_id uuid not null,
  brand_id uuid not null,
  source_name extensions.citext not null,
  product_id uuid not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (workspace_id, brand_id, source_name),
  foreign key (workspace_id, brand_id, product_id)
    references public.ia_products(workspace_id, brand_id, id) on delete cascade,
  check (
    length(source_name::text) between 1 and 160
    and source_name::text = btrim(source_name::text)
    and source_name::text = regexp_replace(
      source_name::text, '[[:space:]]+', ' ', 'g'
    )
    and source_name::text !~ '[[:cntrl:]]'
  )
);

-- PostgreSQL does not add indexes on the referencing side of foreign keys.
create index ia_location_import_aliases_location_fk_idx
  on public.ia_location_import_aliases (workspace_id, brand_id, location_id);
create index ia_product_import_aliases_product_fk_idx
  on public.ia_product_import_aliases (workspace_id, brand_id, product_id);

-- A byte-identical export is a duplicate only within its selected brand. The
-- prior workspace-wide constraint prevented two brands from importing separate
-- files that happened to have the same bytes (for example an empty template).
alter table public.ia_import_batches
  drop constraint if exists ia_import_batches_workspace_id_source_sha256_key;
alter table public.ia_import_batches
  add constraint ia_import_batches_workspace_brand_source_sha256_key
  unique (workspace_id, brand_id, source_sha256);

-- This unexposed helper performs only deterministic row resolution. Public RPCs
-- validate raw JSON, authorization, active records, ambiguity, and aliases before
-- consuming it. Existing aliases take precedence over case-insensitive name
-- matching; a supplied product UUID takes precedence only after conflict checks.
create function ia_private.ia_resolve_historical_import_rows_v2(
  p_workspace_id uuid,
  p_brand_id uuid,
  p_rows jsonb
)
returns table (
  row_number bigint,
  location_id uuid,
  supplied_product_id uuid,
  resolved_product_id uuid,
  input_product_name text,
  canonical_product_name text,
  source_location text,
  source_product text,
  business_date date,
  quantity integer,
  product_key text,
  deterministic_import_code text
)
language sql
stable
security invoker
set search_path = ''
as $$
  with parsed as (
    select
      item.ordinality as row_number,
      (item.value ->> 'location_id')::uuid as location_id,
      nullif(item.value ->> 'product_id', '')::uuid as supplied_product_id,
      regexp_replace(
        btrim(item.value ->> 'product_name'), '[[:space:]]+', ' ', 'g'
      ) as input_product_name,
      regexp_replace(
        btrim(item.value ->> 'source_location'), '[[:space:]]+', ' ', 'g'
      ) as source_location,
      regexp_replace(
        btrim(item.value ->> 'source_product'), '[[:space:]]+', ' ', 'g'
      ) as source_product,
      (item.value ->> 'business_date')::date as business_date,
      (item.value ->> 'quantity')::integer as quantity
    from jsonb_array_elements(p_rows) with ordinality as item(value, ordinality)
  ),
  matched as (
    select
      parsed.*,
      explicit_product.id as explicit_product_id,
      explicit_product.name as explicit_product_name,
      alias_product.id as alias_product_id,
      alias_product.name as alias_product_name,
      name_product.id as name_product_id,
      name_product.name as name_product_name,
      'p_' || substr(
        encode(
          extensions.digest(
            p_brand_id::text || ':' || lower(parsed.input_product_name),
            'sha256'
          ),
          'hex'
        ),
        1,
        32
      ) as deterministic_import_code
    from parsed
    left join public.ia_products as explicit_product
      on explicit_product.workspace_id = p_workspace_id
     and explicit_product.brand_id = p_brand_id
     and explicit_product.id = parsed.supplied_product_id
     and explicit_product.archived_at is null
    left join public.ia_product_import_aliases as product_alias
      on product_alias.workspace_id = p_workspace_id
     and product_alias.brand_id = p_brand_id
     and product_alias.source_name = parsed.source_product::extensions.citext
    left join public.ia_products as alias_product
      on alias_product.workspace_id = product_alias.workspace_id
     and alias_product.brand_id = product_alias.brand_id
     and alias_product.id = product_alias.product_id
     and alias_product.archived_at is null
    left join lateral (
      select product.id, product.name
      from public.ia_products as product
      where product.workspace_id = p_workspace_id
        and product.brand_id = p_brand_id
        and product.archived_at is null
        and lower(
          regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
        ) = lower(parsed.input_product_name)
      order by product.id
      limit 1
    ) as name_product on true
  )
  select
    matched.row_number,
    matched.location_id,
    matched.supplied_product_id,
    coalesce(
      matched.explicit_product_id,
      matched.alias_product_id,
      matched.name_product_id
    ) as resolved_product_id,
    matched.input_product_name,
    coalesce(
      matched.explicit_product_name,
      matched.alias_product_name,
      matched.name_product_name,
      matched.input_product_name
    ) as canonical_product_name,
    matched.source_location,
    matched.source_product,
    matched.business_date,
    matched.quantity,
    case
      when coalesce(
        matched.explicit_product_id,
        matched.alias_product_id,
        matched.name_product_id
      ) is not null then
        'id:' || coalesce(
          matched.explicit_product_id,
          matched.alias_product_id,
          matched.name_product_id
        )::text
      else 'new:' || matched.deterministic_import_code
    end as product_key,
    matched.deterministic_import_code
  from matched
  order by matched.row_number
$$;

create function public.ia_preview_historical_import_v2(
  p_brand_id uuid,
  p_rows jsonb
)
returns table (
  inserted_count integer,
  corrected_count integer,
  unchanged_count integer,
  new_product_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user_id is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;

  select brand.workspace_id into v_workspace_id
  from public.ia_brands as brand
  join public.ia_workspaces as workspace
    on workspace.id = brand.workspace_id and workspace.status = 'active'
  join public.ia_workspace_memberships as membership
    on membership.workspace_id = brand.workspace_id
   and membership.user_id = v_user_id
   and membership.status = 'active'
   and membership.role in ('super_admin', 'admin')
  where brand.id = p_brand_id and brand.archived_at is null;

  if v_workspace_id is null then
    raise exception 'active brand workspace administrator required' using errcode = '42501';
  end if;

  -- A standalone preview serializes only within its selected brand. The commit
  -- path first takes the established shared history workspace lock, then this
  -- same brand lock, and finally its checksum lock.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'ia_history_v2_workspace_brand:' || v_workspace_id::text || ':' || p_brand_id::text,
      41981
    )
  );

  if coalesce(jsonb_typeof(p_rows), '') <> 'array' then
    raise exception 'rows must be a non-empty JSON array of at most 100000 items'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 100000 then
    raise exception 'rows must be a non-empty JSON array of at most 100000 items'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_rows) as item(value)
    where jsonb_typeof(item.value) <> 'object'
       or not (item.value ?& array[
         'location_id', 'product_name', 'source_location', 'source_product',
         'business_date', 'quantity'
       ])
       or (item.value - array[
         'location_id', 'product_id', 'product_name', 'source_location',
         'source_product', 'business_date', 'quantity'
       ]::text[]) <> '{}'::jsonb
       or jsonb_typeof(item.value -> 'location_id') <> 'string'
       or item.value ->> 'location_id'
         !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or (
         item.value ? 'product_id'
         and coalesce(jsonb_typeof(item.value -> 'product_id'), 'null')
           not in ('string', 'null')
       )
       or (
         nullif(item.value ->> 'product_id', '') is not null
         and item.value ->> 'product_id'
           !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       )
       or jsonb_typeof(item.value -> 'product_name') <> 'string'
       or length(btrim(item.value ->> 'product_name')) not between 1 and 160
       or btrim(item.value ->> 'product_name') ~ '^[=+@-]'
       or btrim(item.value ->> 'product_name') ~ '[[:cntrl:]]'
       or jsonb_typeof(item.value -> 'source_location') <> 'string'
       or length(btrim(item.value ->> 'source_location')) not between 1 and 160
       or btrim(item.value ->> 'source_location') ~ '^[=+@-]'
       or btrim(item.value ->> 'source_location') ~ '[[:cntrl:]]'
       or jsonb_typeof(item.value -> 'source_product') <> 'string'
       or length(btrim(item.value ->> 'source_product')) not between 1 and 160
       or btrim(item.value ->> 'source_product') ~ '^[=+@-]'
       or btrim(item.value ->> 'source_product') ~ '[[:cntrl:]]'
       or jsonb_typeof(item.value -> 'business_date') <> 'string'
       or item.value ->> 'business_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or coalesce(jsonb_typeof(item.value -> 'quantity'), '')
         not in ('number', 'string')
       or item.value ->> 'quantity' !~ '^[0-9]+$'
       or length(item.value ->> 'quantity') > 10
       or (item.value ->> 'quantity')::numeric > 2147483647
  ) then
    raise exception 'one or more rows violate the guided import contract'
      using errcode = '22023';
  end if;

  -- UUIDs and dates are cast only after the strict lexical checks above. An
  -- impossible calendar date therefore fails the whole preview transaction.
  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    left join public.ia_locations as location
      on location.workspace_id = v_workspace_id
     and location.brand_id = p_brand_id
     and location.id = row_data.location_id
     and location.is_active
    where location.id is null
  ) then
    raise exception 'one or more rows reference an inactive or out-of-brand location'
      using errcode = '42501';
  end if;

  -- Role-based administration never bypasses the location boundary for sales.
  -- This repeats the original importer denial rule for admins and super admins.
  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    where not (
      select ia_private.ia_has_location_access(
        v_workspace_id, row_data.location_id
      )
    )
  ) then
    raise exception 'one or more rows reference an unassigned location'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_locations as location
      on location.workspace_id = v_workspace_id
     and location.brand_id = p_brand_id
     and location.id = row_data.location_id
    where row_data.business_date
      > (pg_catalog.transaction_timestamp() at time zone location.time_zone)::date
  ) then
    raise exception 'historical sales cannot include a future local business date'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    group by lower(row_data.source_location)
    having count(distinct row_data.location_id) > 1
  ) then
    raise exception 'one source location maps to multiple locations in this import'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_location_import_aliases as alias
      on alias.workspace_id = v_workspace_id
     and alias.brand_id = p_brand_id
     and alias.source_name = row_data.source_location::extensions.citext
    where alias.location_id <> row_data.location_id
  ) then
    raise exception 'a source location conflicts with its saved alias'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    left join public.ia_products as product
      on product.workspace_id = v_workspace_id
     and product.brand_id = p_brand_id
     and product.id = row_data.supplied_product_id
     and product.archived_at is null
    where row_data.supplied_product_id is not null and product.id is null
  ) then
    raise exception 'a supplied product is inactive or outside the selected brand'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_products as product
      on product.workspace_id = v_workspace_id
     and product.brand_id = p_brand_id
     and product.id = row_data.supplied_product_id
    where lower(
      regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
    ) <> lower(row_data.input_product_name)
  ) then
    raise exception 'a supplied product conflicts with its canonical name'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_product_import_aliases as alias
      on alias.workspace_id = v_workspace_id
     and alias.brand_id = p_brand_id
     and alias.source_name = row_data.source_product::extensions.citext
    where row_data.supplied_product_id is not null
      and alias.product_id <> row_data.supplied_product_id
  ) then
    raise exception 'a source product conflicts with its saved alias'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_product_import_aliases as alias
      on alias.workspace_id = v_workspace_id
     and alias.brand_id = p_brand_id
     and alias.source_name = row_data.source_product::extensions.citext
    join public.ia_products as product
      on product.workspace_id = alias.workspace_id
     and product.brand_id = alias.brand_id
     and product.id = alias.product_id
    where product.archived_at is not null
       or lower(
         regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
       ) <> lower(row_data.input_product_name)
  ) then
    raise exception 'a source product alias is inactive or conflicts with its canonical name'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_products as product
      on product.workspace_id = v_workspace_id
     and product.brand_id = p_brand_id
     and product.archived_at is null
     and lower(
       regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
     ) = lower(row_data.input_product_name)
    where row_data.supplied_product_id is null
    group by row_data.row_number
    having count(*) > 1
  ) then
    raise exception 'a product name is ambiguous within the selected brand'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_products as product
      on product.workspace_id = v_workspace_id
     and product.brand_id = p_brand_id
     and lower(
       regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
     ) = lower(row_data.input_product_name)
     and product.archived_at is not null
    where row_data.resolved_product_id is null
  ) then
    raise exception 'an archived product must be restored or renamed before import'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    join public.ia_products as product
      on product.workspace_id = v_workspace_id
     and product.brand_id = p_brand_id
     and product.import_code = row_data.deterministic_import_code::extensions.citext
    where row_data.resolved_product_id is null
      and (
        product.archived_at is not null
        or lower(
          regexp_replace(btrim(product.name), '[[:space:]]+', ' ', 'g')
        ) <> lower(row_data.input_product_name)
      )
  ) then
    raise exception 'the deterministic product code conflicts with an existing product'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    group by lower(row_data.source_product)
    having count(distinct row_data.product_key) > 1
  ) then
    raise exception 'one source product maps to multiple products in this import'
      using errcode = '23514';
  end if;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as row_data
    group by row_data.location_id, row_data.product_key, row_data.business_date
    having count(*) > 1
  ) then
    raise exception 'duplicate resolved product/location/date rows are not allowed'
      using errcode = '23505';
  end if;

  return query
  with resolved as (
    select *
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    )
  )
  select
    count(*) filter (where history.id is null)::integer as inserted_count,
    count(*) filter (
      where history.id is not null
        and history.quantity is distinct from resolved.quantity
    )::integer as corrected_count,
    count(*) filter (
      where history.id is not null
        and history.quantity is not distinct from resolved.quantity
    )::integer as unchanged_count,
    count(distinct resolved.product_key) filter (
      where resolved.resolved_product_id is null
    )::integer as new_product_count
  from resolved
  left join public.ia_historical_sales as history
    on history.workspace_id = v_workspace_id
   and history.brand_id = p_brand_id
   and history.location_id = resolved.location_id
   and history.product_id = resolved.resolved_product_id
   and history.business_date = resolved.business_date;
end;
$$;

create function public.ia_import_historical_sales_v2(
  p_brand_id uuid,
  p_filename text,
  p_checksum text,
  p_rows jsonb
)
returns table (
  import_batch_id uuid,
  inserted_count integer,
  corrected_count integer,
  unchanged_count integer,
  products_created integer,
  already_imported boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_batch_id uuid;
  v_existing_batch public.ia_import_batches%rowtype;
  v_row_count integer;
  v_inserted integer;
  v_corrected integer;
  v_unchanged integer;
  v_new_product_count integer;
  v_products_created integer := 0;
  v_date_start date;
  v_date_end date;
begin
  if v_user_id is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  if p_filename is null or length(btrim(p_filename)) not between 1 and 255
     or btrim(p_filename) ~ '[[:cntrl:]]' then
    raise exception 'invalid filename' using errcode = '22023';
  end if;
  if p_checksum is null or lower(p_checksum) !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid SHA-256 checksum' using errcode = '22023';
  end if;

  select brand.workspace_id into v_workspace_id
  from public.ia_brands as brand
  join public.ia_workspaces as workspace
    on workspace.id = brand.workspace_id and workspace.status = 'active'
  join public.ia_workspace_memberships as membership
    on membership.workspace_id = brand.workspace_id
   and membership.user_id = v_user_id
   and membership.status = 'active'
   and membership.role in ('super_admin', 'admin')
  where brand.id = p_brand_id and brand.archived_at is null;
  if v_workspace_id is null then
    raise exception 'active brand workspace administrator required' using errcode = '42501';
  end if;

  -- Lock order is invariant: the established workspace history lock first (it
  -- also serializes forecast-store watermarks), then brand, then checksum.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'ia_history:' || v_workspace_id::text,
      41981
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'ia_history_v2_workspace_brand:' || v_workspace_id::text || ':' || p_brand_id::text,
      41981
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'ia_history_v2_checksum:' || v_workspace_id::text || ':' || p_brand_id::text
        || ':' || lower(p_checksum),
      41982
    )
  );

  select preview.inserted_count, preview.corrected_count,
    preview.unchanged_count, preview.new_product_count
  into v_inserted, v_corrected, v_unchanged, v_new_product_count
  from public.ia_preview_historical_import_v2(p_brand_id, p_rows) as preview;

  select batch.* into v_existing_batch
  from public.ia_import_batches as batch
  where batch.workspace_id = v_workspace_id
    and batch.brand_id = p_brand_id
    and batch.source_sha256 = lower(p_checksum)
    and batch.status = 'committed';

  if found then
    import_batch_id := v_existing_batch.id;
    -- A checksum replay is a verified no-op, not a replay of the first import's
    -- historical action counts. This keeps the UI truthful on retries.
    inserted_count := 0;
    corrected_count := 0;
    unchanged_count := v_existing_batch.row_count;
    products_created := 0;
    already_imported := true;
    return next;
    return;
  end if;

  insert into public.ia_products (
    workspace_id, brand_id, name, import_code, created_by
  )
  select distinct
    v_workspace_id,
    p_brand_id,
    resolved.canonical_product_name,
    resolved.deterministic_import_code::extensions.citext,
    v_user_id
  from ia_private.ia_resolve_historical_import_rows_v2(
    v_workspace_id, p_brand_id, p_rows
  ) as resolved
  where resolved.resolved_product_id is null
  order by resolved.deterministic_import_code::extensions.citext
  on conflict do nothing;
  get diagnostics v_products_created = row_count;

  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as resolved
    where resolved.resolved_product_id is null
  ) then
    raise exception 'one or more products could not be created deterministically'
      using errcode = '23514';
  end if;

  insert into public.ia_location_import_aliases (
    workspace_id, brand_id, source_name, location_id, created_by
  )
  select distinct
    v_workspace_id,
    p_brand_id,
    resolved.source_location::extensions.citext,
    resolved.location_id,
    v_user_id
  from ia_private.ia_resolve_historical_import_rows_v2(
    v_workspace_id, p_brand_id, p_rows
  ) as resolved
  order by resolved.source_location::extensions.citext
  on conflict (workspace_id, brand_id, source_name) do nothing;

  insert into public.ia_product_import_aliases (
    workspace_id, brand_id, source_name, product_id, created_by
  )
  select distinct
    v_workspace_id,
    p_brand_id,
    resolved.source_product::extensions.citext,
    resolved.resolved_product_id,
    v_user_id
  from ia_private.ia_resolve_historical_import_rows_v2(
    v_workspace_id, p_brand_id, p_rows
  ) as resolved
  order by resolved.source_product::extensions.citext
  on conflict (workspace_id, brand_id, source_name) do nothing;

  -- Recheck aliases after insertion so an unexpected privileged concurrent
  -- writer causes a rollback instead of silently accepting a changed mapping.
  if exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as resolved
    join public.ia_location_import_aliases as alias
      on alias.workspace_id = v_workspace_id
     and alias.brand_id = p_brand_id
     and alias.source_name = resolved.source_location::extensions.citext
    where alias.location_id <> resolved.location_id
  ) or exists (
    select 1
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    ) as resolved
    join public.ia_product_import_aliases as alias
      on alias.workspace_id = v_workspace_id
     and alias.brand_id = p_brand_id
     and alias.source_name = resolved.source_product::extensions.citext
    where alias.product_id <> resolved.resolved_product_id
  ) then
    raise exception 'an import alias changed during commit' using errcode = '40001';
  end if;

  with resolved as (
    select *
    from ia_private.ia_resolve_historical_import_rows_v2(
      v_workspace_id, p_brand_id, p_rows
    )
  )
  select count(*)::integer, min(business_date), max(business_date),
    count(*) filter (where history.id is null)::integer,
    count(*) filter (
      where history.id is not null
        and history.quantity is distinct from resolved.quantity
    )::integer,
    count(*) filter (
      where history.id is not null
        and history.quantity is not distinct from resolved.quantity
    )::integer
  into v_row_count, v_date_start, v_date_end,
    v_inserted, v_corrected, v_unchanged
  from resolved
  left join public.ia_historical_sales as history
    on history.workspace_id = v_workspace_id
   and history.brand_id = p_brand_id
   and history.location_id = resolved.location_id
   and history.product_id = resolved.resolved_product_id
   and history.business_date = resolved.business_date;

  insert into public.ia_import_batches (
    workspace_id, brand_id, source_filename, source_sha256, status,
    duplicate_action, row_count, valid_row_count, error_count,
    date_start, date_end, validation_summary, uploaded_by,
    validated_at, committed_at
  ) values (
    v_workspace_id,
    p_brand_id,
    btrim(p_filename),
    lower(p_checksum),
    'committed',
    case when v_corrected > 0 then 'replace' end,
    v_row_count,
    v_row_count,
    0,
    v_date_start,
    v_date_end,
    jsonb_build_object(
      'inserted', v_inserted,
      'corrected', v_corrected,
      'unchanged', v_unchanged,
      'products_created', v_products_created
    ),
    v_user_id,
    now(),
    now()
  ) returning id into v_batch_id;

  -- Insert only missing facts. A later correction update is deliberately
  -- separate so unchanged facts retain their original batch and updated_at.
  insert into public.ia_historical_sales (
    workspace_id, brand_id, location_id, product_id, business_date,
    quantity, source_import_batch_id
  )
  select
    v_workspace_id,
    p_brand_id,
    resolved.location_id,
    resolved.resolved_product_id,
    resolved.business_date,
    resolved.quantity,
    v_batch_id
  from ia_private.ia_resolve_historical_import_rows_v2(
    v_workspace_id, p_brand_id, p_rows
  ) as resolved
  order by resolved.location_id, resolved.resolved_product_id, resolved.business_date
  on conflict (workspace_id, location_id, product_id, business_date) do nothing;

  update public.ia_historical_sales as history
  set quantity = resolved.quantity,
      source_import_batch_id = v_batch_id
  from ia_private.ia_resolve_historical_import_rows_v2(
    v_workspace_id, p_brand_id, p_rows
  ) as resolved
  where history.workspace_id = v_workspace_id
    and history.brand_id = p_brand_id
    and history.location_id = resolved.location_id
    and history.product_id = resolved.resolved_product_id
    and history.business_date = resolved.business_date
    and history.quantity is distinct from resolved.quantity;

  insert into public.ia_audit_events (
    workspace_id, actor_user_id, event_type, entity_type, entity_id,
    outcome, metadata
  ) values (
    v_workspace_id,
    v_user_id,
    'historical_import_v2.committed',
    'import_batch',
    v_batch_id,
    'success',
    jsonb_build_object(
      'brand_id', p_brand_id,
      'row_count', v_row_count,
      'inserted', v_inserted,
      'corrected', v_corrected,
      'unchanged', v_unchanged,
      'products_created', v_products_created
    )
  );

  import_batch_id := v_batch_id;
  inserted_count := v_inserted;
  corrected_count := v_corrected;
  unchanged_count := v_unchanged;
  products_created := v_products_created;
  already_imported := false;
  return next;
end;
$$;

-- Compatibility for callers using the original payload. It keeps the original
-- name/signature and return columns, but routes writes through the brand-safe v2
-- transaction. In old semantics every pre-existing key was "replaced", so the
-- wrapper reports corrected + unchanged rows in replaced_count.
create or replace function public.ia_import_historical_sales(
  p_filename text,
  p_checksum text,
  p_rows jsonb
)
returns table (
  import_batch_id uuid,
  inserted_count integer,
  replaced_count integer
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_brand_id uuid;
  v_rows_v2 jsonb;
  v_result record;
begin
  if v_user_id is null
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'permanent authentication required' using errcode = '42501';
  end if;
  if coalesce(jsonb_typeof(p_rows), '') <> 'array' then
    raise exception 'one or more rows violate the legacy import contract'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) < 1
     or jsonb_array_length(p_rows) > 100000
     or exists (
       select 1
       from jsonb_array_elements(p_rows) as item(value)
       where jsonb_typeof(item.value) <> 'object'
          or not (item.value ?& array[
            'brand_id', 'location_id', 'product_name', 'business_date', 'quantity'
          ])
          or item.value ->> 'brand_id'
            !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     ) then
    raise exception 'one or more rows violate the legacy import contract'
      using errcode = '22023';
  end if;

  v_brand_id := (p_rows -> 0 ->> 'brand_id')::uuid;
  if exists (
    select 1
    from jsonb_array_elements(p_rows) as item(value)
    where (item.value ->> 'brand_id')::uuid <> v_brand_id
  ) then
    raise exception 'one import batch must contain exactly one brand'
      using errcode = '23514';
  end if;

  select brand.workspace_id into v_workspace_id
  from public.ia_brands as brand
  join public.ia_workspace_memberships as membership
    on membership.workspace_id = brand.workspace_id
   and membership.user_id = v_user_id
   and membership.status = 'active'
   and membership.role in ('super_admin', 'admin')
  where brand.id = v_brand_id and brand.archived_at is null;
  if v_workspace_id is null then
    raise exception 'active brand workspace administrator required' using errcode = '42501';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'location_id', item.value ->> 'location_id',
      'product_id', null,
      'product_name', item.value ->> 'product_name',
      'source_location', location.import_code::text,
      'source_product', item.value ->> 'product_name',
      'business_date', item.value ->> 'business_date',
      'quantity', item.value -> 'quantity'
    )
    order by item.ordinality
  ) into v_rows_v2
  from jsonb_array_elements(p_rows) with ordinality as item(value, ordinality)
  left join public.ia_locations as location
    on location.workspace_id = v_workspace_id
   and location.brand_id = v_brand_id
   and location.id::text = item.value ->> 'location_id';

  select * into v_result
  from public.ia_import_historical_sales_v2(
    v_brand_id, p_filename, p_checksum, v_rows_v2
  );

  import_batch_id := v_result.import_batch_id;
  inserted_count := v_result.inserted_count;
  replaced_count := v_result.corrected_count + v_result.unchanged_count;
  return next;
end;
$$;

alter table public.ia_location_import_aliases enable row level security;
alter table public.ia_location_import_aliases force row level security;
alter table public.ia_product_import_aliases enable row level security;
alter table public.ia_product_import_aliases force row level security;

create policy ia_location_import_aliases_select
  on public.ia_location_import_aliases
  for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id))
      in ('super_admin', 'admin')
  );

create policy ia_product_import_aliases_select
  on public.ia_product_import_aliases
  for select to authenticated
  using (
    (select ia_private.ia_current_workspace_role(workspace_id))
      in ('super_admin', 'admin')
  );

-- Public-table reads are admin-scoped by RLS. Direct writes stay revoked; only
-- the narrowly authorized SECURITY DEFINER commit RPC writes aliases and facts.
revoke all on table public.ia_location_import_aliases
  from public, anon, authenticated;
revoke all on table public.ia_product_import_aliases
  from public, anon, authenticated;
grant select on public.ia_location_import_aliases,
  public.ia_product_import_aliases to authenticated;
grant select, insert, update, delete on public.ia_location_import_aliases,
  public.ia_product_import_aliases to service_role;

revoke all on function ia_private.ia_resolve_historical_import_rows_v2(uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.ia_preview_historical_import_v2(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.ia_import_historical_sales_v2(uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.ia_import_historical_sales(text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.ia_preview_historical_import_v2(uuid, jsonb)
  to authenticated;
grant execute on function public.ia_import_historical_sales_v2(uuid, text, text, jsonb)
  to authenticated;
grant execute on function public.ia_import_historical_sales(text, text, jsonb)
  to authenticated;
grant execute on function ia_private.ia_resolve_historical_import_rows_v2(uuid, uuid, jsonb)
  to service_role;
grant execute on function public.ia_preview_historical_import_v2(uuid, jsonb)
  to service_role;
grant execute on function public.ia_import_historical_sales_v2(uuid, text, text, jsonb)
  to service_role;
grant execute on function public.ia_import_historical_sales(text, text, jsonb)
  to service_role;

comment on table public.ia_location_import_aliases is
  'Brand-scoped, case-insensitive source labels mapped to configured active locations by the guided importer.';
comment on table public.ia_product_import_aliases is
  'Brand-scoped, case-insensitive source labels mapped to canonical products by the guided importer.';
comment on function public.ia_preview_historical_import_v2(uuid, jsonb) is
  'Admin-only, read-only preview of brand-scoped inserts, corrections, unchanged facts, and new products.';
comment on function public.ia_import_historical_sales_v2(uuid, text, text, jsonb) is
  'Admin-only atomic brand-scoped import that creates products and aliases, preserves unchanged facts, audits corrections, and reports checksum replays explicitly.';
comment on function public.ia_import_historical_sales(text, text, jsonb) is
  'Compatibility wrapper for the original import payload, routed through the brand-safe v2 transaction.';

insert into public.ia_migration_markers (migration_id)
values ('20260717203635_guided_history_import');
