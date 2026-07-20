import { requireWorkspaceContext, type RequestContext } from "./auth";
import { HttpError, jsonError } from "./http";
import { createSupabaseAdminClient } from "../supabase/admin";
import {
  CredentialResolutionError,
} from "../server/credential-resolver";
import {
  IntegrationConnectionError,
  IntegrationConnectionService,
  INTEGRATION_ADMIN_ROLES,
  SupabaseIntegrationConnectionRepository,
  authorizeBeforeServiceRole,
  type ProviderHostResolver,
} from "../server/integration-connections";
import { decodeEncryptionKey } from "../server/secret-crypto";
import { SupabaseCredentialStore } from "../server/supabase-credential-store";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type AdminIntegrationContext = RequestContext & {
  service: IntegrationConnectionService;
};

export type AdminIntegrationDependencies = {
  authorize?: (roles: readonly ["super_admin", "admin"]) => Promise<RequestContext>;
  createAdminClient?: () => AdminClient;
  environment?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  resolveHost?: ProviderHostResolver;
};

/**
 * Keep the authorization check and service-role client creation inseparable.
 * No admin client, secret RPC, or provider call can occur before this resolves.
 */
export async function requireAdminIntegrationService(
  dependencies: AdminIntegrationDependencies = {},
): Promise<AdminIntegrationContext> {
  const authorized = await authorizeBeforeServiceRole({
    authorize: () => (dependencies.authorize ?? requireWorkspaceContext)(INTEGRATION_ADMIN_ROLES),
    createService: () => {
      const environment = dependencies.environment ?? process.env;
      const encryptionKey = String(environment.APP_SECRET_ENCRYPTION_KEY ?? "").trim();
      try {
        decodeEncryptionKey(encryptionKey);
      } catch {
        throw new HttpError(
          503,
          "Provider credentials cannot be saved until the app encryption key is configured.",
          "encryption_key_unavailable",
        );
      }

      const admin = (dependencies.createAdminClient ?? createSupabaseAdminClient)();
      const credentialStore = new SupabaseCredentialStore(admin);
      return new IntegrationConnectionService({
        repository: new SupabaseIntegrationConnectionRepository(admin),
        credentialStore,
        encryptionKey,
        environment,
        fetch: dependencies.fetch,
        resolveHost: dependencies.resolveHost,
      });
    },
  });
  return { ...authorized.context, service: authorized.service };
}

export function asIntegrationHttpError(error: unknown): unknown {
  if (error instanceof IntegrationConnectionError) {
    return new HttpError(409, error.message, error.code);
  }
  if (error instanceof CredentialResolutionError) {
    if (error.code === "credential_missing") {
      return new HttpError(400, "Enter this provider's credential before saving the connection.", error.code);
    }
    if (error.code === "stored_credential_unreadable") {
      return new HttpError(409, "Replace the saved provider credential before continuing.", error.code);
    }
    return new HttpError(400, "The provider credential configuration is invalid.", error.code);
  }
  return error;
}

export function integrationJsonError(error: unknown) {
  const response = jsonError(asIntegrationHttpError(error));
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
