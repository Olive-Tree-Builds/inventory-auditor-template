import { requireWorkspaceContext } from "../../lib/api/auth";
import { HttpError, jsonError, jsonOk } from "../../lib/api/http";
import type { AppBootstrapData, AppBrand, AppUser } from "../../lib/app-data";
import { createSupabaseAdminClient } from "../../lib/supabase/admin";
import { BRAND_LOGO_BUCKET } from "../../lib/server/brand-logo";
import {
  SupabaseIntegrationConnectionRepository,
  summarizeProviderConnections,
  type ProviderConnectionRecord,
} from "../../lib/server/integration-connections";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { supabase, user, membership } = await requireWorkspaceContext();
    const isAdmin = membership.role === "super_admin" || membership.role === "admin";

    const [workspaceResult, profileResult, brandsResult, locationsResult, assignmentsResult, connectionsResult, scheduleResult, contactResult, contactLocationsResult, importResult, analysisStateResult] = await Promise.all([
      supabase.from("ia_workspaces").select("id, name, slug, default_time_zone, email_sending_enabled").eq("id", membership.workspace_id).single(),
      supabase.from("ia_profiles").select("user_id, email, username, display_name, position_title").eq("user_id", user.id).single(),
      supabase.from("ia_brands").select("id, name, code, default_time_zone, logo_object_path, is_active, updated_at").eq("workspace_id", membership.workspace_id).order("name"),
      supabase.from("ia_locations").select("id, brand_id, name, import_code, street_address, city, region, country_code, postal_code, time_zone, is_active, updated_at").eq("workspace_id", membership.workspace_id).order("name"),
      supabase.from("ia_user_location_assignments").select("user_id, location_id, is_active").eq("workspace_id", membership.workspace_id).eq("is_active", true),
      isAdmin
        ? new SupabaseIntegrationConnectionRepository(supabase)
          .list(membership.workspace_id)
          .then((data) => ({ data, error: null }))
          .catch((error: unknown) => ({ data: [] as ProviderConnectionRecord[], error }))
        : Promise.resolve({ data: [] as ProviderConnectionRecord[], error: null }),
      isAdmin
        ? supabase.from("ia_email_schedules").select("id, name, enabled, cadence, weekday_mask, local_send_time, timezone_rule, workspace_time_zone, forecast_horizon").eq("workspace_id", membership.workspace_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      isAdmin
        ? supabase.from("ia_email_contacts")
          .select("id, schedule_id, email, display_name, enabled")
          .eq("workspace_id", membership.workspace_id)
          .is("archived_at", null)
          .order("display_name")
        : Promise.resolve({ data: [], error: null }),
      isAdmin
        ? supabase.from("ia_email_contact_locations")
          .select("contact_id, location_id")
          .eq("workspace_id", membership.workspace_id)
        : Promise.resolve({ data: [], error: null }),
      isAdmin
        ? supabase.from("ia_import_batches").select("source_filename, row_count, date_start, date_end, committed_at").eq("workspace_id", membership.workspace_id).eq("status", "committed").order("committed_at", { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      supabase.from("ia_workspace_analysis_state").select("active_policy_revision_id").eq("workspace_id", membership.workspace_id).maybeSingle(),
    ]);

    const firstError = [
      workspaceResult,
      profileResult,
      brandsResult,
      locationsResult,
      assignmentsResult,
      analysisStateResult,
      ...(isAdmin ? [connectionsResult, scheduleResult, contactResult, contactLocationsResult, importResult] : []),
    ].find((result) => result.error)?.error;
    if (firstError || !workspaceResult.data || !profileResult.data) {
      throw new HttpError(500, "Workspace data could not be loaded.", "app_data_unavailable");
    }

    let membershipRows: Array<Record<string, unknown>> = [membership as unknown as Record<string, unknown>];
    let profileRows: Array<Record<string, unknown>> = [profileResult.data as Record<string, unknown>];
    if (isAdmin) {
      const membershipsResult = await supabase
        .from("ia_workspace_memberships")
        .select("id, user_id, role, status, email_enabled")
        .eq("workspace_id", membership.workspace_id)
        .order("created_at");
      if (membershipsResult.error) throw new HttpError(500, "Workspace users could not be loaded.", "users_unavailable");
      membershipRows = (membershipsResult.data ?? []) as Array<Record<string, unknown>>;
      const userIds = membershipRows.map((row) => String(row.user_id));
      if (userIds.length > 0) {
        const profilesResult = await supabase
          .from("ia_profiles")
          .select("user_id, email, username, display_name, position_title")
          .in("user_id", userIds);
        if (profilesResult.error) throw new HttpError(500, "Workspace profiles could not be loaded.", "profiles_unavailable");
        profileRows = (profilesResult.data ?? []) as Array<Record<string, unknown>>;
      }
    }

    const profileByUser = new Map(profileRows.map((profile) => [String(profile.user_id), profile]));
    const assignmentRows = (assignmentsResult.data ?? []) as Array<{ user_id: string; location_id: string }>;
    const users: AppUser[] = membershipRows.map((row) => {
      const userId = String(row.user_id);
      const profile = profileByUser.get(userId) ?? {};
      return {
        membershipId: String(row.id),
        userId,
        email: String(profile.email || ""),
        displayName: String(profile.display_name || profile.email || "User"),
        username: String(profile.username || ""),
        positionTitle: String(profile.position_title || ""),
        role: row.role as AppUser["role"],
        status: String(row.status),
        emailEnabled: Boolean(row.email_enabled),
        locationIds: assignmentRows.filter((assignment) => assignment.user_id === userId).map((assignment) => assignment.location_id),
      };
    });

    const locationRows = (locationsResult.data ?? []) as Array<Record<string, unknown>>;
    const brands: AppBrand[] = ((brandsResult.data ?? []) as Array<Record<string, unknown>>).map((brand) => ({
      id: String(brand.id),
      updatedAt: String(brand.updated_at),
      name: String(brand.name),
      code: String(brand.code || ""),
      active: Boolean(brand.is_active),
      defaultTimeZone: String(brand.default_time_zone || workspaceResult.data.default_time_zone),
      logoUrl: brand.logo_object_path
        ? supabase.storage.from(BRAND_LOGO_BUCKET).getPublicUrl(String(brand.logo_object_path)).data.publicUrl
        : null,
      locations: locationRows.filter((location) => String(location.brand_id) === String(brand.id)).map((location) => ({
        id: String(location.id),
        updatedAt: String(location.updated_at),
        brandId: String(location.brand_id),
        name: String(location.name),
        code: String(location.import_code || ""),
        addressLine1: String(location.street_address || ""),
        city: String(location.city || ""),
        region: String(location.region || ""),
        countryCode: String(location.country_code || ""),
        postalCode: String(location.postal_code || ""),
        timezone: String(location.time_zone || workspaceResult.data.default_time_zone),
        researchArea: [location.street_address, location.city, location.region, location.postal_code, location.country_code].filter(Boolean).join(", "),
        active: Boolean(location.is_active),
      })),
    }));

    const currentUser = users.find((candidate) => candidate.userId === user.id);
    if (!currentUser) throw new HttpError(403, "Your workspace membership is incomplete.", "profile_incomplete");
    const schedule = scheduleResult.data as Record<string, unknown> | null;
    const latestImport = importResult.data as Record<string, unknown> | null;
    const providerConnections = isAdmin
      ? summarizeProviderConnections(connectionsResult.data ?? [], process.env)
      : [];
    let analysisSkill: AppBootstrapData["analysisSkill"] = null;
    if (analysisStateResult.data?.active_policy_revision_id) {
      const admin = createSupabaseAdminClient();
      const { data: policy, error: policyError } = await admin
        .from("ia_analysis_policy_revisions")
        .select("markdown_content, policy_version, active_variable_revision, active_variables, sha256")
        .eq("workspace_id", membership.workspace_id)
        .eq("id", analysisStateResult.data.active_policy_revision_id)
        .single();
      if (policyError || !policy) throw new HttpError(500, "The active Analysis Skill could not be loaded.", "analysis_skill_unavailable");
      analysisSkill = {
        markdown: isAdmin ? String(policy.markdown_content) : null,
        policyVersion: String(policy.policy_version),
        activeVariableRevision: Number(policy.active_variable_revision),
        variables: Array.isArray(policy.active_variables)
          ? policy.active_variables.flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const row = value as { id?: unknown; name?: unknown };
            return typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : [];
          })
          : [],
        sha256: String(policy.sha256),
      };
    }

    const payload: AppBootstrapData = {
      workspace: {
        id: String(workspaceResult.data.id),
        name: String(workspaceResult.data.name),
        slug: String(workspaceResult.data.slug),
        defaultTimeZone: String(workspaceResult.data.default_time_zone),
      },
      emailDeliveryReady: Boolean(workspaceResult.data.email_sending_enabled),
      currentUser,
      users,
      brands,
      assignedLocationIds: currentUser.locationIds,
      providerConnections: providerConnections.map((connection) => ({
        provider: connection.provider,
        status: connection.status,
        maskedHint: connection.maskedHint,
        lastTestedAt: connection.lastTestedAt,
        configuration: connection.configuration ?? {},
      })),
      emailSchedule: schedule ? {
        id: String(schedule.id),
        name: String(schedule.name),
        enabled: Boolean(schedule.enabled),
        cadence: String(schedule.cadence),
        weekdayMask: Number(schedule.weekday_mask),
        localSendTime: String(schedule.local_send_time),
        timezoneRule: String(schedule.timezone_rule),
        workspaceTimeZone: String(schedule.workspace_time_zone),
        forecastHorizon: String(schedule.forecast_horizon),
      } : null,
      emailRecipients: ((contactResult.data ?? []) as Array<Record<string, unknown>>).map((contact) => ({
        id: String(contact.id),
        scheduleId: String(contact.schedule_id),
        email: String(contact.email),
        displayName: String(contact.display_name),
        enabled: Boolean(contact.enabled),
        locationIds: ((contactLocationsResult.data ?? []) as Array<Record<string, unknown>>)
          .filter((assignment) => String(assignment.contact_id) === String(contact.id))
          .map((assignment) => String(assignment.location_id)),
      })),
      analysisSkill,
      latestImport: latestImport ? {
        filename: String(latestImport.source_filename),
        rowCount: Number(latestImport.row_count),
        dateFrom: latestImport.date_start ? String(latestImport.date_start) : null,
        dateTo: latestImport.date_end ? String(latestImport.date_end) : null,
        committedAt: latestImport.committed_at ? String(latestImport.committed_at) : null,
      } : null,
    };

    return jsonOk(payload);
  } catch (error) {
    return jsonError(error);
  }
}
