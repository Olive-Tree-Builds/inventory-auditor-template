# Supabase verification and denial tests

Run all tests against a disposable local Supabase database. Never use production credentials or customer sales files.

## What happens first

1. Start the local Supabase stack and apply every migration.
2. Run `schema_contract.sql` with `ON_ERROR_STOP=1`.
3. Create four test Auth users: the first super admin, a manager assigned to Location A, a manager assigned to Location B, and an invited user.
4. In a transaction, simulate each user by setting the database role to `authenticated` and setting `request.jwt.claims` with that user's `sub`, `role: authenticated`, and `is_anonymous: false`.

Example session setup:

```sql
begin;
set local role authenticated;
select set_config(
  'request.jwt.claims',
  jsonb_build_object(
    'sub', '<AUTH-USER-UUID>',
    'role', 'authenticated',
    'is_anonymous', false
  )::text,
  true
);
-- Run one assertion, then rollback.
rollback;
```

## Required allow and denial matrix

### Bootstrap and invitations

- Confirm `ia_bootstrap_workspace` does not exist and neither `anon` nor `authenticated` can execute either owner-bootstrap server RPC.
- As `service_role`, authorize two different permanent email users with `ia_server_authorize_owner_bootstrap(uuid,text,text,text,text,text)`. Unconfirmed users cannot consume the authorization.
- After email confirmation, run `ia_server_bootstrap_workspace(uuid)` concurrently for both authorized users. Exactly one succeeds, `ia_installation_state` points to its workspace, exactly one `super_admin` membership exists, and all pending owner authorizations are deleted.
- An expired or missing 24-hour authorization fails without creating a workspace, profile, membership, or audit event. A second bootstrap call after setup also fails atomically.
- Changing browser-controlled `user_metadata` never authorizes owner bootstrap; only the private service-created authorization row does.
- An anonymous Auth identity cannot bootstrap or accept an invitation.
- A valid invitation can be consumed only by the authenticated user whose Auth email matches it.
- Expired, revoked, reused, wrong-email, and unknown tokens all fail without creating a profile, membership, or assignment.
- Issuing a replacement invite first revokes expired open invitations, while an unexpired open invite with the same email or username still conflicts.
- Invitation acceptance fails atomically when there is no active invited location.

### Workspace administration writes

- Authenticated users have no direct insert, update, or delete privileges on brands, locations, memberships, assignments, imports, sales, forecasts, email schedules, or audit events.
- `ia_create_brand` lowercases and validates the brand code, validates its IANA default timezone, permits only an active workspace admin, and appends its audit event atomically.
- `ia_create_location` permits only an active workspace admin, rejects a cross-workspace or archived brand, creates the location, assigns the caller, and appends its audit event atomically.
- `ia_update_brand` and `ia_update_location` keep edits inside the caller's workspace, validate IANA timezones, reject stale `updated_at` revisions, and append audit events atomically. An active location cannot exist under an inactive brand, including during concurrent writes.
- The `brand-logos` bucket is public-read for non-sensitive artwork, restricted to PNG/JPEG/WebP at 2 MiB, has no browser write policy, and its database pointer swap is service-role only.
- A failure in either creation RPC leaves no partial brand, location, assignment, or audit row.

### Location isolation

- The Location A manager can select Location A sales, forecast runs, forecast items, sources, and their own delivery-location rows.
- The same user sees zero rows for Location B and cannot request Location B through `ia_historical_dashboard`.
- The Location B manager has the inverse result.
- A workspace admin without a Location B assignment may configure Location B but cannot read its sales or forecasts.
- Suspend a membership or revoke an assignment while retaining the old JWT. The next dashboard query is denied immediately.
- A user with no active location assignment receives no operational rows and is not selected by the email worker.
- `ia_forecast_input` returns every authorized date-only row beyond the normal PostgREST page size, but rejects an unassigned location, reversed range, or range over ten years.

### Historical imports

- `ia_import_historical_sales` accepts rows shaped as `{brand_id, location_id, product_name, business_date, quantity}` and creates stable brand-scoped products automatically.
- Re-importing the same product name with different capitalization reuses the same product.
- Re-importing an existing location/product/date replaces the canonical quantity, creates a private sales revision, and reports one replacement.
- A timestamp such as `2026-07-16T09:30:00Z`, an invalid date, negative or fractional quantity, an unexpected key, duplicate payload row, multiple brands, inactive location, or unassigned location rejects the entire transaction.
- A business date after the location's current local date is rejected. The same UTC instant can therefore allow a date for one timezone and reject it as future for another.
- A failed import leaves no import batch, product, sale, revision, or audit event behind.
- Composite foreign keys reject a brand, location, product, import batch, forecast, or schedule from another workspace even if its UUID is known.

### Analysis policy and forecasts

- Only `service_role` can execute `ia_server_activate_analysis_policy(uuid,uuid,text,text,text,integer,text,jsonb,text,text,text)`, and it must independently validate the singleton workspace plus an active admin/super-admin audit actor.
- Activation rejects a claimed SHA-256 that does not match the exact Markdown bytes. Repeating the same semantically matching workspace/checksum payload returns the original revision ID; changed content requires a new policy version and checksum.
- A failed revision insert, state update, or audit insert rolls back the entire activation. A successful activation leaves one immutable revision, the matching active workspace state, and one audit event with repository provenance.
- Only admins can read policy-revision Markdown through the Data API. Non-admin dashboards receive only the server-redacted active variable metadata they need.
- Policy revisions and audit events reject update and delete operations.
- A forecast run can reference only a policy, brand, and location from the same workspace.
- Negative recommendations, non-HTTPS evidence URLs, invalid confidence values, and unsupported periods are rejected.
- Removing a user's assignment after a forecast completes hides the run, items, sources, and delivery location on the next request.
- `authenticated` and `anon` cannot execute `ia_store_forecast_result` or insert forecast/audit rows directly. Only the trusted service-role server path can store a result after the HTTP route has authorized the user.
- `ia_store_forecast_result` rejects an inactive location, inactive policy revision, product from another brand, unknown source key, non-HTTPS URL, negative quantity, or malformed JSON; any failure rolls back the run, items, sources, links, and audit event.
- Forecast claim calls are service-role-only, require the current policy revision, bind to the latest committed-import watermark, and reject an unauthorized manual actor. Concurrent calls are rejected, failed calls back off, and completed manual calls have a six-hour refresh cooldown. A policy or history change permits a new claim.
- `ia_store_forecast_result` requires the matching active claim and actor, locks the active policy, shares a workspace history lock with imports, rechecks the import watermark, then stores the result and marks that claim complete with the run ID in one transaction. A concurrent policy/import/assignment change leaves no deliverable run.

The forecast-store payload contract is:

```json
{
  "p_run": {
    "brand_id": "uuid",
    "location_id": "uuid",
    "policy_revision_id": "uuid",
    "period_grouping": "day|week|month|quarter|year",
    "period_start": "YYYY-MM-DD",
    "period_end": "YYYY-MM-DD",
    "location_time_zone": "America/Toronto",
    "status": "complete|baseline_only|needs_review|policy_unavailable|failed",
    "run_source": "manual|scheduled|email_test",
    "actor_user_id": "authorized-user-uuid-or-null-for-scheduled",
    "research_completed": true
  },
  "p_items": [{
    "product_id": "uuid",
    "baseline_quantity": 10,
    "adjustments": [],
    "recommended_quantity": 11,
    "confidence": "high|medium|low",
    "explanation": "Validated explanation",
    "source_keys": ["source-1"]
  }],
  "p_sources": [{
    "source_key": "source-1",
    "title": "Source title",
    "publisher": "Publisher",
    "url": "https://direct.example/source",
    "published_or_updated_date": "2026-07-16",
    "accessed_at": "2026-07-16T12:00:00Z",
    "fact_used": "Relevant fact"
  }]
}
```

### Member administration

- `ia_update_member` lets a super admin manage any member and lets an admin manage only managers/viewers.
- Active users require at least one active workspace location; suspended users have email disabled and all assignments revoked atomically.
- Two concurrent attempts cannot demote or suspend the final active super admin.
- Cross-workspace membership and location IDs are rejected.

### Provider secrets and email

- `anon` has no Inventory Auditor table or RPC access.
- `authenticated` cannot select, insert, or update `ia_private.ia_provider_secrets`; admins can see only sanitized `ia_provider_connections` metadata.
- Only `service_role` can execute the provider-secret getter and combined connection-save RPC. The combined save validates an active admin actor and commits normalized metadata, an optional encrypted envelope, and the audit event together; plaintext never enters Postgres and partial setup state rolls back.
- Call `ia_server_save_provider_connection(uuid,text,text,text,text,text,text,text,text,text,text,bytea,integer,text,text,uuid)`. For a metadata-only edit, pass all five secret arguments (`secret_name`, encrypted value, key version, masked hint, fingerprint) as `NULL`; for a rotation, provide all five. Test that a missing field, non-admin actor, invalid provider metadata, or audit failure leaves metadata and the prior secret unchanged.
- Every connection configuration save clears `last_tested_at`, `last_test_result`, and `last_error_code`; a fresh server-side connection test must populate them again before the UI can show a current passing result.
- Saving an enabled schedule fails until `ia_workspaces.email_sending_enabled` has been set by a verified server-side connection/test flow.
- A delivery idempotency key cannot be inserted twice.
- At send time, rebuild the recipient location list from active membership, `email_enabled`, recipient preference, active assignments, and active locations. Revoking any one of these prevents that location or recipient from being queued.
- Retry attempts append metadata only; they never store the email body, API key, or raw AI prompt.

## What happens after that

Run the Supabase security and performance advisors, inspect every warning, then test the same matrix through the Next.js server routes using the publishable browser client and server-only secret client. Include an `EXPLAIN (ANALYZE, BUFFERS)` check for historical dashboard queries at realistic row counts.

If a test fails, stop deployment, keep scheduled email disabled, and report the failing test name and sanitized error to the repository maintainer. Never paste credentials or customer rows into a ticket.
