import { z } from "zod";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { bootstrapWorkspace } from "../../../lib/api/bootstrap";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";

const schema = z.object({
  login: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    let email = input.login;
    if (!email.includes("@")) {
      const admin = createSupabaseAdminClient();
      const { data } = await admin
        .from("ia_profiles")
        .select("email")
        .eq("username", input.login)
        .maybeSingle();
      if (!data?.email) throw new HttpError(400, "The email/username or password is incorrect.", "invalid_credentials");
      email = data.email as string;
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password: input.password });
    if (error || !data.user) throw new HttpError(400, "The email/username or password is incorrect.", "invalid_credentials");

    const { data: membership } = await supabase
      .from("ia_workspace_memberships")
      .select("id")
      .eq("user_id", data.user.id)
      .maybeSingle();

    if (!membership) {
      const admin = createSupabaseAdminClient();
      try {
        await bootstrapWorkspace(admin, data.user.id);
      } catch {
        await supabase.auth.signOut();
        throw new HttpError(403, "Your account does not have workspace access. Ask an administrator for an invitation.", "membership_required");
      }
    }

    return jsonOk({ authenticated: true });
  } catch (error) {
    return jsonError(error);
  }
}
