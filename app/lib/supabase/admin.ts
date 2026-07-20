import { createClient } from "@supabase/supabase-js";
import { requirePublicSupabaseConfig } from "./config";

export function createSupabaseAdminClient() {
  const { url } = requirePublicSupabaseConfig();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secretKey) {
    throw new Error("SUPABASE_SECRET_KEY is not configured.");
  }

  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
