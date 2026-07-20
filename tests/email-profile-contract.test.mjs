import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const migration = readFileSync("supabase/migrations/20260716230000_email_contacts_and_profiles.sql", "utf8");

test("email contacts are archive-preserving, location-scoped, RLS-protected, and explicitly granted", () => {
  assert.match(migration, /create table public\.ia_email_contacts/);
  assert.match(migration, /create table public\.ia_email_contact_locations/);
  assert.match(migration, /references public\.ia_locations\(workspace_id, id\)/);
  assert.match(migration, /alter table public\.ia_email_contacts enable row level security/);
  assert.match(migration, /alter table public\.ia_email_contacts force row level security/);
  assert.match(migration, /revoke all on table public\.ia_email_contacts from public, anon, authenticated/);
  assert.match(migration, /grant select on public\.ia_email_contacts, public\.ia_email_contact_locations to authenticated/);
  assert.match(migration, /grant select, insert, update, delete on public\.ia_email_contacts, public\.ia_email_contact_locations to service_role/);
  assert.match(migration, /num_nonnulls\(recipient_user_id, recipient_contact_id\) = 1/);
  assert.match(migration, /check \(archived_at is null or not enabled\)/);
  assert.match(migration, /values \('20260716230000_email_contacts_and_profiles'\)/);
});

test("contact mutations repeat administrator, workspace, schedule, and active-location checks", () => {
  assert.match(migration, /create function public\.ia_save_email_contact/);
  assert.match(migration, /security definer\s+set search_path = ''/);
  assert.match(migration, /not in \('super_admin', 'admin'\)/);
  assert.match(migration, /location\.workspace_id = v_workspace_id[\s\S]*location\.is_active/);
  assert.match(migration, /this email belongs to a workspace user/);
  assert.match(migration, /revoke all on function public\.ia_save_email_contact/);
  assert.match(migration, /grant execute on function public\.ia_save_email_contact[\s\S]*to authenticated/);
});

test("invitation and email-contact identities are serialized and acceptance rechecks conflicts", () => {
  const inviteRoute = readFileSync("app/api/users/invite/route.ts", "utf8");
  assert.match(migration, /ia_guard_email_contact_identity/);
  assert.match(migration, /ia_guard_invitation_contact_identity/);
  assert.ok((migration.match(/pg_catalog\.hashtextextended\(\s*'email-identity:'/g) ?? []).length >= 3);
  assert.match(migration, /create or replace function public\.ia_accept_invitation/);
  assert.match(migration, /invitation email belongs to an additional email recipient/);
  assert.match(migration, /ia_guard_email_contact_identity\(\)[\s\S]*join public\.ia_workspace_memberships[\s\S]*profile\.email = v_email/);
  assert.match(migration, /accepted_at is null and revoked_at is null/);
  assert.match(inviteRoute, /from\("ia_email_contacts"\)/);
  assert.match(inviteRoute, /recipient_email_conflict/);
  assert.ok(inviteRoute.indexOf('from("ia_email_contacts")') < inviteRoute.indexOf('from("ia_invitations")'));
});

test("profile updates use the signed-in RLS client and cannot change authorization fields", () => {
  const route = readFileSync("app/api/profile/route.ts", "utf8");
  assert.match(migration, /add column position_title text/);
  assert.match(migration, /grant update \(position_title\) on public\.ia_profiles to authenticated/);
  assert.match(route, /requireWorkspaceContext\(\)/);
  assert.match(route, /\.eq\("user_id", user\.id\)/);
  assert.doesNotMatch(route, /createSupabaseAdminClient|service_role|workspace_id:|role:/);
  assert.match(route, /username_taken/);
});

test("manual delivery is admin-only, exact-run scoped, and rechecks safety before Resend", () => {
  const route = readFileSync("app/api/email/send-now/route.ts", "utf8");
  const service = readFileSync("app/lib/server/manual-email-delivery.ts", "utf8");
  assert.match(route, /requireWorkspaceContext\(\["super_admin", "admin"\]\)/);
  assert.match(route, /requireLocationAccess\(locationIds/);
  assert.ok(route.indexOf("await requireWorkspaceContext") < route.indexOf("admin: createSupabaseAdminClient()"));
  assert.match(service, /expectedRunIds/);
  assert.match(service, /forecast_changed/);
  assert.ok((service.match(/assertActorScope\(/g) ?? []).length >= 2);
  assert.match(service, /reconcileAnalysisPolicy\(/);
  assert.ok((service.match(/assertAnalysisPolicyCurrent\(/g) ?? []).length >= 3);
  assert.match(service, /verifyCurrentEmailCredential/);
  assert.match(service, /restrictRecipientScope/);
  assert.match(service, /buildManualSendIdempotencyKey/);
  assert.match(service, /buildManualSendDedupeKey/);
  assert.match(service, /deliverySource: "manual"/);
  assert.match(service, /manualDedupeKey/);
  assert.match(service, /recipient_scope_changed/);
  assert.ok(service.indexOf('.in("location_id", selectedLocationIds)') < service.indexOf("references.length > 100"));
  assert.doesNotMatch(route, /EMAIL_DELIVERY_ENABLED/);
});

test("manual email claims use a rolling DB window and stale attempts cannot finish", () => {
  const service = readFileSync("app/lib/server/supabase-email-delivery.ts", "utf8");
  assert.match(migration, /create function public\.ia_server_claim_manual_email_delivery/);
  assert.match(migration, /pg_catalog\.pg_advisory_xact_lock/);
  assert.match(migration, /created_at > now\(\) - interval '5 minutes'/);
  assert.match(migration, /manual_dedupe_key/);
  assert.match(migration, /current_attempt_id/);
  assert.match(migration, /create function public\.ia_server_finish_email_delivery/);
  assert.match(migration, /delivery\.current_attempt_id = p_attempt_id/);
  assert.match(service, /ia_server_claim_manual_email_delivery/);
  assert.match(service, /ia_server_finish_email_delivery/);
  assert.match(service, /current_attempt_id: attemptId/);
  assert.match(service, /id: attemptId/);
  assert.match(service, /staleDeliveryPointer\.is\("current_attempt_id", null\)/);
  assert.doesNotMatch(service, /current_attempt_id", String\(attempts\.data\?\.id \?\? ""\)/);
});

test("one schedule is enforced and null-id saves update the singleton", () => {
  assert.match(migration, /multiple email schedules exist for one workspace/);
  assert.match(migration, /create unique index ia_email_schedules_one_per_workspace_idx/);
  assert.match(migration, /pg_catalog\.hashtextextended\('email-schedule:'/);
  assert.match(migration, /if p_schedule_id is not null and v_schedule_id is distinct from p_schedule_id/);
  const manual = readFileSync("app/lib/server/manual-email-delivery.ts", "utf8");
  assert.doesNotMatch(manual, /from\("ia_email_schedules"\)[\s\S]{0,180}\.limit\(1\)/);
});

test("forecast claim tokens bind storage and failure to the current generation", () => {
  const claims = readFileSync("app/lib/server/forecast-claims.ts", "utf8");
  const runner = readFileSync("app/lib/server/forecast-runner.ts", "utf8");
  assert.match(migration, /add column claim_token uuid not null default gen_random_uuid\(\)/);
  assert.match(migration, /v_claim\.claim_token <> p_claim_token/);
  assert.match(migration, /matching forecast claim token required/);
  assert.match(migration, /ia_store_forecast_result_unchecked/);
  assert.match(claims, /Promise<string \| null>/);
  assert.match(claims, /p_claim_token: input\.claimToken/);
  assert.match(runner, /p_claim_token: input\.claimToken/);
});

test("app bootstrap uses the shared redacted provider summary including environment fallbacks", () => {
  const route = readFileSync("app/api/app/route.ts", "utf8");
  assert.match(route, /SupabaseIntegrationConnectionRepository/);
  assert.match(route, /summarizeProviderConnections\(connectionsResult\.data \?\? \[\], process\.env\)/);
  assert.doesNotMatch(route, /provider_kind[\s\S]{0,400}masked_hint/);
});

test("scheduled delivery includes contacts through the same scope and ledger helpers", () => {
  const route = readFileSync("app/api/jobs/forecast/route.ts", "utf8");
  assert.match(route, /loadActiveEmailContactScope/);
  assert.match(route, /from\("ia_email_contacts"\)/);
  assert.match(route, /recipientContactId: scope\.recipientContactId/);
  assert.match(route, /recipientKey: scope\.recipientKey/);
  assert.match(route, /scopeSignature\(currentScope\) !== scopeSignature\(scope\)/);
  assert.ok((route.match(/verifyCurrentEmailCredential\(/g) ?? []).length >= 2);
});
