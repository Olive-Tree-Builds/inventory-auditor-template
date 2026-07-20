import { z } from "zod";
import { jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

const schema = z.object({ token: z.string().min(32).max(256) });

export async function POST(request: Request) {
  try {
    const { token } = schema.parse(await readJson(request));
    const supabase = await createSupabaseServerClient();
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return jsonOk({ accepted: false, authenticated: false });
    const { error } = await supabase.rpc("ia_accept_invitation", { p_token: token });
    if (error) return jsonOk({ accepted: false, authenticated: true, message: "This invitation is invalid, expired, already used, or belongs to another email." });
    return jsonOk({ accepted: true, authenticated: true });
  } catch (error) {
    return jsonError(error);
  }
}
