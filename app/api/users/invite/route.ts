import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { requireWorkspaceContext } from "../../../lib/api/auth";
import { HttpError, jsonError, jsonOk, readJson } from "../../../lib/api/http";
import { createSupabaseAdminClient } from "../../../lib/supabase/admin";
import { escapeEmailHtml } from "../../../lib/server/email-delivery";
import { ResendEmailClient } from "../../../lib/server/resend-email";
import { resolveResendDelivery } from "../../../lib/server/supabase-email-delivery";

const schema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(2).max(120),
  username: z.string().trim().min(3).max(40).regex(/^[A-Za-z0-9._-]+$/),
  role: z.enum(["admin", "manager", "viewer"]),
  emailEnabled: z.boolean().default(true),
  locationIds: z.array(z.uuid()).min(1).max(100),
});

export async function POST(request: Request) {
  try {
    const input = schema.parse(await readJson(request));
    const { supabase, user, membership } = await requireWorkspaceContext(["super_admin", "admin"]);
    const uniqueLocationIds = [...new Set(input.locationIds)];
    if (uniqueLocationIds.length !== input.locationIds.length) throw new HttpError(400, "Choose each location once.", "duplicate_location");
    const { data: locations, error: locationError } = await supabase
      .from("ia_locations")
      .select("id")
      .eq("workspace_id", membership.workspace_id)
      .eq("is_active", true)
      .in("id", uniqueLocationIds);
    if (locationError || locations?.length !== uniqueLocationIds.length) {
      throw new HttpError(403, "One or more selected locations are not available in this workspace.", "invalid_locations");
    }

    const appUrl = process.env.APP_URL?.replace(/\/$/, "");
    if (!appUrl) throw new HttpError(503, "APP_URL is required before invitations can be created.", "app_url_missing");

    const normalizedEmail = input.email.trim().toLocaleLowerCase();
    const admin = createSupabaseAdminClient();
    const { data: contactConflict, error: contactConflictError } = await admin
      .from("ia_email_contacts")
      .select("id")
      .eq("workspace_id", membership.workspace_id)
      .eq("email", normalizedEmail)
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    if (contactConflictError) {
      throw new HttpError(500, "Email recipient conflicts could not be checked.", "recipient_conflict_check_failed");
    }
    if (contactConflict) {
      throw new HttpError(
        409,
        "That email is already an additional forecast recipient. Remove it there before inviting this person to sign in.",
        "recipient_email_conflict",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const now = new Date().toISOString();
    const { error: expiryCleanupError } = await admin
      .from("ia_invitations")
      .update({ revoked_at: now, revoked_by: user.id })
      .eq("workspace_id", membership.workspace_id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .lte("expires_at", now);
    if (expiryCleanupError) {
      throw new HttpError(500, "Expired invitations could not be cleared safely.", "invitation_cleanup_failed");
    }
    const { data: invitation, error: invitationError } = await admin
      .from("ia_invitations")
      .insert({
        workspace_id: membership.workspace_id,
        email: normalizedEmail,
        username: input.username.toLowerCase(),
        display_name: input.displayName,
        role: input.role,
        email_enabled: input.emailEnabled,
        token_hash: `\\x${tokenHash}`,
        expires_at: expiresAt,
        created_by: user.id,
      })
      .select("id")
      .single();
    if (invitationError || !invitation) {
      if (invitationError?.code === "23505") {
        if (/additional email recipient|email contact/i.test(invitationError.message)) {
          throw new HttpError(
            409,
            "That email became an additional forecast recipient before the invitation was saved. Remove it there and try again.",
            "recipient_email_conflict",
          );
        }
        throw new HttpError(409, "That email or username already has an open invitation.", "invitation_exists");
      }
      throw new HttpError(400, "The invitation could not be created.", "invitation_create_failed");
    }

    const { error: assignmentError } = await admin.from("ia_invitation_locations").insert(
      uniqueLocationIds.map((locationId) => ({
        workspace_id: membership.workspace_id,
        invitation_id: invitation.id,
        location_id: locationId,
      })),
    );
    if (assignmentError) {
      await admin.from("ia_invitations").delete().eq("id", invitation.id).eq("workspace_id", membership.workspace_id);
      throw new HttpError(400, "The invitation locations could not be saved.", "invitation_locations_failed");
    }

    const inviteUrl = `${appUrl}/invite?token=${encodeURIComponent(token)}`;
    let emailSent = false;
    try {
      const delivery = await resolveResendDelivery({
        admin,
        workspaceId: membership.workspace_id,
        requireVerifiedConnection: false,
      });
      const email = new ResendEmailClient({ apiKey: delivery.apiKey, from: delivery.sender });
      await email.send({
        recipient: normalizedEmail,
        subject: "You are invited to Inventory Auditor",
        idempotencyKey: `inventory-auditor:invite:${invitation.id}`,
        html: `<p>Hello ${escapeEmailHtml(input.displayName)},</p><p>You have been invited to Inventory Auditor. This private link expires in seven days:</p><p><a href="${escapeEmailHtml(inviteUrl)}">Accept invitation</a></p><p>If you were not expecting this invitation, you can ignore it.</p>`,
        text: `Hello ${input.displayName},\n\nAccept your Inventory Auditor invitation within seven days:\n${inviteUrl}\n`,
      });
      emailSent = true;
    } catch {
      // The private copy link remains available when email is not configured or fails.
      emailSent = false;
    }

    return jsonOk({
      invitationId: invitation.id,
      expiresAt,
      emailSent,
      inviteUrl: emailSent ? null : inviteUrl,
      message: emailSent
        ? "Invitation emailed successfully."
        : "The invitation is ready. Copy the private link and send it through an approved channel.",
    }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return jsonError(error);
  }
}
