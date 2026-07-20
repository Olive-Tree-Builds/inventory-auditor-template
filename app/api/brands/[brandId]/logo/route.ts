import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireWorkspaceContext } from "../../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../../lib/supabase/admin";
import {
  BRAND_LOGO_BUCKET,
  BRAND_LOGO_REQUEST_MAX_BYTES,
  BrandLogoValidationError,
  parseBrandLogoDataUrl,
} from "../../../../lib/server/brand-logo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  dataUrl: z.string().min(1).max(BRAND_LOGO_REQUEST_MAX_BYTES - 32),
}).strict();

export async function PUT(
  request: Request,
  context: { params: Promise<{ brandId: string }> },
) {
  try {
    const { supabase, membership, user } = await requireWorkspaceContext(["super_admin", "admin"]);
    const { brandId } = await context.params;
    const parsedBrandId = z.uuid().safeParse(brandId);
    if (!parsedBrandId.success) throw new HttpError(400, "Choose a valid brand.", "invalid_brand");

    const { data: brand, error: brandError } = await supabase
      .from("ia_brands")
      .select("id")
      .eq("workspace_id", membership.workspace_id)
      .eq("id", parsedBrandId.data)
      .maybeSingle();
    if (brandError) throw new HttpError(500, "The brand could not be checked.", "brand_lookup_failed");
    if (!brand) throw new HttpError(404, "The brand was not found.", "brand_not_found");

    const input = schema.parse(await readJson(request, BRAND_LOGO_REQUEST_MAX_BYTES));
    let logo;
    try {
      logo = parseBrandLogoDataUrl(input.dataUrl);
    } catch (error) {
      if (error instanceof BrandLogoValidationError) {
        throw new HttpError(error.status, error.message, error.code);
      }
      throw error;
    }

    const admin = createSupabaseAdminClient();
    const objectPath = `${membership.workspace_id}/${parsedBrandId.data}/${randomUUID()}.${logo.extension}`;
    const { error: uploadError } = await admin.storage.from(BRAND_LOGO_BUCKET).upload(
      objectPath,
      logo.bytes,
      {
        cacheControl: "31536000",
        contentType: logo.contentType,
        upsert: false,
      },
    );
    if (uploadError) {
      throw new HttpError(502, "The logo could not be stored. Confirm the latest Supabase migration is installed.", "brand_logo_upload_failed");
    }

    const { data: oldObjectPath, error: saveError } = await admin.rpc("ia_server_set_brand_logo", {
      p_workspace_id: membership.workspace_id,
      p_actor_user_id: user.id,
      p_brand_id: parsedBrandId.data,
      p_new_object_path: objectPath,
    });
    if (saveError) {
      await admin.storage.from(BRAND_LOGO_BUCKET).remove([objectPath]);
      if (saveError.code === "P0002") throw new HttpError(404, "The brand was not found.", "brand_not_found");
      if (saveError.code === "42501") throw new HttpError(403, "You do not have permission to edit this brand.", "brand_logo_update_denied");
      throw new HttpError(500, "The logo could not be attached to the brand.", "brand_logo_update_failed");
    }

    let cleanupPending = false;
    if (typeof oldObjectPath === "string" && oldObjectPath && oldObjectPath !== objectPath) {
      const { error: cleanupError } = await admin.storage.from(BRAND_LOGO_BUCKET).remove([oldObjectPath]);
      cleanupPending = Boolean(cleanupError);
    }

    const logoUrl = admin.storage.from(BRAND_LOGO_BUCKET).getPublicUrl(objectPath).data.publicUrl;
    return jsonOk(
      { id: parsedBrandId.data, logoUrl, cleanupPending },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return jsonError(error);
  }
}
