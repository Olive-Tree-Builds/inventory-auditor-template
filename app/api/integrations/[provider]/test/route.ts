import { integrationJsonError, requireAdminIntegrationService } from "../../../../lib/api/integrations";
import { HttpError, jsonOk } from "../../../../lib/api/http";
import { integrationProviderSchema } from "../../../../lib/server/integration-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ provider: string }> };

export async function POST(_request: Request, context: RouteContext) {
  try {
    const parsed = integrationProviderSchema.safeParse((await context.params).provider);
    if (!parsed.success) throw new HttpError(404, "That provider connection does not exist.", "provider_not_found");
    const { membership, user, service } = await requireAdminIntegrationService();
    const result = await service.test({
      workspaceId: membership.workspace_id,
      actorUserId: user.id,
      provider: parsed.data,
    });
    return jsonOk(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return integrationJsonError(error);
  }
}
