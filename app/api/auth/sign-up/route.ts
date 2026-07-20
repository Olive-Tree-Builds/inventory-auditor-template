import { z } from "zod";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { authorizeOwnerBootstrap, bootstrapWorkspace } from "../../../lib/api/bootstrap";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { verifyOwnerSetupSecret } from "../../../lib/server/owner-setup";
import { isValidIanaTimeZone } from "../../../lib/server/time-zone";

const schema = z.object({
  businessName: z.string().trim().min(2).max(120),
  displayName: z.string().trim().min(2).max(100),
  username: z.string().trim().min(3).max(40).regex(/^[a-zA-Z0-9._-]+$/),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
  timezone: z.string().trim().min(3).max(80).refine(isValidIanaTimeZone, "Choose a valid IANA timezone.").default("Etc/UTC"),
  setupCode: z.string().trim().min(32).max(4_096),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const admin = createSupabaseAdminClient();
    const { count, error: countError } = await admin
      .from("ia_workspaces")
      .select("id", { count: "exact", head: true });
    if (countError) throw new HttpError(503, "Run the Supabase migration before creating the first account.", "database_not_ready");
    if ((count ?? 0) > 0) throw new HttpError(409, "First-time setup is closed. Ask an administrator for an invitation.", "setup_closed");
    if (!verifyOwnerSetupSecret(input.setupCode, process.env.OWNER_SETUP_SECRET)) {
      throw new HttpError(403, "The owner setup code is incorrect. Copy the OWNER_SETUP_SECRET value from the organization password manager.", "invalid_setup_code");
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: {
        emailRedirectTo: `${process.env.APP_URL?.replace(/\/$/, "") || new URL(request.url).origin}/auth/callback`,
      },
    });

    if (error || !data.user) {
      throw new HttpError(400, error?.message || "The account could not be created.", "signup_failed");
    }

    try {
      await authorizeOwnerBootstrap(admin, data.user.id, {
        workspaceName: input.businessName,
        username: input.username,
        displayName: input.displayName,
        timezone: input.timezone,
      });
    } catch (authorizationError) {
      if ((data.user.identities?.length ?? 0) > 0) {
        await admin.auth.admin.deleteUser(data.user.id).catch(() => undefined);
      }
      throw authorizationError;
    }

    if (data.session) {
      await bootstrapWorkspace(admin, data.user.id);
    }

    return jsonOk({
      authenticated: Boolean(data.session),
      emailConfirmationRequired: !data.session,
      message: data.session
        ? "Your workspace is ready."
        : "Check your email, confirm your address, then sign in to finish creating the workspace.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
