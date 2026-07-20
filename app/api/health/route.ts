import { NextResponse } from "next/server";
import { getPublicSupabaseConfig, hasSupabaseSecretKey } from "../../lib/supabase/config";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabaseConfigured = Boolean(getPublicSupabaseConfig() && hasSupabaseSecretKey());
  return NextResponse.json(
    {
      status: supabaseConfigured ? "ok" : "setup_required",
      service: "inventory-auditor",
      version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || process.env.npm_package_version || "development",
      timestamp: new Date().toISOString(),
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
