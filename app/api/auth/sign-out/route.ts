import { HttpError, jsonError, jsonOk } from "../../../lib/api/http";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export async function POST() {
  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.signOut();
    if (error) throw new HttpError(502, "You could not be signed out. Try again.", "sign_out_failed");
    return jsonOk({ signedOut: true });
  } catch (error) {
    return jsonError(error);
  }
}
