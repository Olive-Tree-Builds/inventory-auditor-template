import { z } from "zod";
import { requireWorkspaceContext } from "../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../lib/api/http";
import { isValidIanaTimeZone } from "../../lib/server/time-zone";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(24).regex(/^[A-Za-z0-9_-]+$/),
  defaultTimeZone: z.string().trim().min(3).max(100).refine(isValidIanaTimeZone, "Choose a valid IANA timezone."),
}).strict();

export async function POST(request: Request) {
  try {
    const { supabase } = await requireWorkspaceContext(["super_admin", "admin"]);
    const input = schema.parse(await readJson(request));
    const { data, error } = await supabase.rpc("ia_create_brand", {
      p_name: input.name,
      p_code: input.code.toLowerCase(),
      p_default_time_zone: input.defaultTimeZone,
    });
    if (error) {
      if (error.code === "23505") throw new HttpError(409, "That brand name or code is already in use.", "brand_exists");
      throw new HttpError(400, "The brand could not be added.", "brand_create_failed");
    }
    return jsonOk(data, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
