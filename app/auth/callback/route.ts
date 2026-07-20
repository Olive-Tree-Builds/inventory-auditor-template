import { NextResponse } from "next/server";
import { bootstrapWorkspace } from "../../lib/api/bootstrap";
import { safeSameOriginPath } from "../../lib/api/redirect";
import { createSupabaseAdminClient } from "../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../lib/supabase/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  let safeNext = safeSameOriginPath(url.searchParams.get("next"));
  if (code) {
    const supabase = await createSupabaseServerClient();
    const exchange = await supabase.auth.exchangeCodeForSession(code);
    if (exchange.error) {
      safeNext = "/?auth_error=confirmation_failed";
    } else {
      const { data: userData } = await supabase.auth.getUser();
      if (userData.user) {
        const admin = createSupabaseAdminClient();
        const installation = await admin.from("ia_installation_state")
          .select("workspace_id")
          .eq("singleton", true)
          .maybeSingle();
        if (!installation.error && installation.data && !installation.data.workspace_id) {
          try {
            await bootstrapWorkspace(admin, userData.user.id);
          } catch {
            await supabase.auth.signOut();
            safeNext = "/?auth_error=owner_setup_incomplete";
          }
        }
      }
    }
  }
  return NextResponse.redirect(new URL(safeNext, url.origin));
}
