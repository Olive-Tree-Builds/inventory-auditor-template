import { integrationJsonError, requireAdminIntegrationService } from "../../lib/api/integrations";
import { jsonOk } from "../../lib/api/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { membership, service } = await requireAdminIntegrationService();
    const connections = await service.list(membership.workspace_id);
    return jsonOk(connections, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return integrationJsonError(error);
  }
}
