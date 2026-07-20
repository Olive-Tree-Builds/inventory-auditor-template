"use client";

import { createBrowserClient } from "@supabase/ssr";
import { requirePublicSupabaseConfig } from "./config";

export function createSupabaseBrowserClient() {
  const { url, publishableKey } = requirePublicSupabaseConfig();
  return createBrowserClient(url, publishableKey);
}
