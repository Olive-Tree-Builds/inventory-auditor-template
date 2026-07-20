import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { getPublicSupabaseConfig, hasSupabaseSecretKey } from "../../../lib/supabase/config";
import { jsonError, jsonOk } from "../../../lib/api/http";
import { inspectEnvironment } from "../../../lib/server/env";

export const dynamic = "force-dynamic";

const REQUIRED_MIGRATIONS = [
  "20260716210000_inventory_auditor",
  "20260716220000_email_delivery_verification",
  "20260716230000_email_contacts_and_profiles",
  "20260717010000_brand_location_management",
  "20260717203635_guided_history_import",
] as const;

export async function GET() {
  try {
    const publicConfig = getPublicSupabaseConfig();
    const environment = inspectEnvironment(process.env);
    const services = {
      supabase: Boolean(publicConfig && hasSupabaseSecretKey() && environment.supabase.status === "ready"),
      railway: environment.app.status === "ready",
      resend: environment.resend.status === "ready",
      ai: environment.ai.status === "ready",
      github: environment.github.status === "ready",
    };

    let databaseReady = false;
    let workspaceInitialized = false;
    let missingMigrations = [...REQUIRED_MIGRATIONS];
    if (services.supabase) {
      try {
        const admin = createSupabaseAdminClient();
        const [workspaceResult, migrationResult] = await Promise.all([
          admin.from("ia_workspaces").select("id", { count: "exact", head: true }),
          admin.from("ia_migration_markers").select("migration_id").in("migration_id", [...REQUIRED_MIGRATIONS]),
        ]);
        const applied = new Set((migrationResult.data ?? []).map((row) => String(row.migration_id)));
        missingMigrations = REQUIRED_MIGRATIONS.filter((migration) => !applied.has(migration));
        databaseReady = !workspaceResult.error && !migrationResult.error && missingMigrations.length === 0;
        workspaceInitialized = !workspaceResult.error && (workspaceResult.count ?? 0) > 0;
      } catch {
        databaseReady = false;
      }
    }

    return jsonOk({
      services,
      databaseReady,
      missingMigrations,
      workspaceInitialized,
      readyForSignIn: services.supabase && services.railway && databaseReady,
      invalidBootstrapValues: [...environment.app.invalid, ...environment.supabase.invalid],
      requiredBootstrap: [
        "NEXT_PUBLIC_SUPABASE_URL",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_SECRET_KEY",
        "APP_SECRET_ENCRYPTION_KEY",
        "CRON_SECRET",
        "OWNER_SETUP_SECRET",
        "APP_URL",
      ],
    });
  } catch (error) {
    return jsonError(error);
  }
}
