import { z } from "zod";
import { createSupabaseServerClient } from "../../../lib/supabase/server";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";

const schema = z.object({ email: z.email().max(254) });

export async function POST(request: Request) {
  try {
    const { email } = schema.parse(await readJson(request));
    const supabase = await createSupabaseServerClient();
    const baseUrl = process.env.APP_URL?.replace(/\/$/, "") || new URL(request.url).origin;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${baseUrl}/auth/callback?next=/reset-password`,
    });
    if (error) throw new HttpError(400, "The reset email could not be sent.", "reset_failed");
    return jsonOk({ message: "If that email has access, a password-reset link is on its way." });
  } catch (error) {
    return jsonError(error);
  }
}
