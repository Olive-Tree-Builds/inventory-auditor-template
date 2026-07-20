import { integrationJsonError, requireAdminIntegrationService } from "../../../lib/api/integrations";
import { HttpError, jsonOk, readJson } from "../../../lib/api/http";
import { integrationProviderSchema } from "../../../lib/server/integration-connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ provider: string }> };

async function providerFrom(context: RouteContext) {
  const result = integrationProviderSchema.safeParse((await context.params).provider);
  if (!result.success) throw new HttpError(404, "That provider connection does not exist.", "provider_not_found");
  return result.data;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const provider = await providerFrom(context);
    const { membership, service } = await requireAdminIntegrationService();
    const connections = await service.list(membership.workspace_id);
    const connection = connections.find((candidate) => candidate.provider === provider);
    if (!connection) throw new HttpError(404, "That provider connection does not exist.", "provider_not_found");
    return jsonOk(connection, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return integrationJsonError(error);
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const provider = await providerFrom(context);
    const { membership, user, service } = await requireAdminIntegrationService();
    const connection = await service.save({
      workspaceId: membership.workspace_id,
      actorUserId: user.id,
      provider,
      body: await readJson(request),
    });
    return jsonOk(connection, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return integrationJsonError(error);
  }
}
