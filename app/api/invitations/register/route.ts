import { createHash } from "node:crypto";
import { z } from "zod";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const schema = z.object({
  token: z.string().min(32).max(256),
  email: z.email().max(254),
  password: z.string().min(10).max(128),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const tokenHash = createHash("sha256").update(input.token).digest("hex");
    const admin = createSupabaseAdminClient();
    const { data: invitation } = await admin
      .from("ia_invitations")
      .select("id, email, expires_at, accepted_at, revoked_at")
      .eq("token_hash", `\\x${tokenHash}`)
      .maybeSingle();
    if (!invitation || invitation.accepted_at || invitation.revoked_at || Date.parse(invitation.expires_at) <= Date.now()) {
      throw new HttpError(400, "This invitation is invalid or has expired.", "invalid_invitation");
    }
    if (String(invitation.email).toLocaleLowerCase() !== input.email.toLocaleLowerCase()) {
      throw new HttpError(400, "Use the email address that received this invitation.", "invitation_email_mismatch");
    }

    const supabase = await createSupabaseServerClient();
    const baseUrl = process.env.APP_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const next = `/invite?token=${encodeURIComponent(input.token)}`;
    const { data, error } = await supabase.auth.signUp({
      email: input.email,
      password: input.password,
      options: { emailRedirectTo: `${baseUrl}/auth/callback?next=${encodeURIComponent(next)}` },
    });
    if (error || !data.user) throw new HttpError(400, error?.message || "The invited account could not be created.", "invite_signup_failed");
    if (data.session) {
      const { error: acceptError } = await supabase.rpc("ia_accept_invitation", { p_token: input.token });
      if (acceptError) throw new HttpError(400, "The invitation could not be accepted.", "invitation_accept_failed");
    }
    return jsonOk({
      accepted: Boolean(data.session),
      emailConfirmationRequired: !data.session,
      message: data.session ? "Invitation accepted." : "Confirm your email, then this invitation will finish automatically.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
