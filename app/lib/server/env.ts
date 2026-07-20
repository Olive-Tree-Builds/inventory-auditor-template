import { decodeEncryptionKey } from "./secret-crypto";

export type EnvironmentSource = Record<string, string | undefined>;
export type EnvironmentSection = "app" | "supabase" | "resend" | "ai" | "github";

export type EnvironmentSectionStatus = {
  status: "ready" | "incomplete";
  missing: string[];
  invalid: string[];
};

export type EnvironmentStatus = Record<EnvironmentSection, EnvironmentSectionStatus> & {
  readyForLiveOperations: boolean;
};

export type ServerEnvironment = {
  app: {
    url: string;
    encryptionKey: string;
    cronSecret: string;
    ownerSetupSecret: string;
  };
  supabase: { url: string; publishableKey: string; secretKey: string };
  resend: { apiKey: string; fromEmail: string };
  ai: {
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    webResearchRequired: true;
  };
  github: { owner: string; repository: string; branch: "trunk"; token: string };
};

export class EnvironmentValidationError extends Error {
  readonly status: EnvironmentStatus;

  constructor(status: EnvironmentStatus) {
    super("Server configuration is incomplete or invalid. Review the named environment variables.");
    this.name = "EnvironmentValidationError";
    this.status = status;
  }
}

function value(env: EnvironmentSource, key: string): string {
  return String(env[key] ?? "").trim();
}

function isHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

function sectionStatus(
  env: EnvironmentSource,
  required: string[],
  validators: Partial<Record<string, (candidate: string) => boolean>> = {},
): EnvironmentSectionStatus {
  const missing = required.filter((key) => !value(env, key));
  const invalid = required.filter((key) => {
    const candidate = value(env, key);
    return Boolean(candidate && validators[key] && !validators[key]?.(candidate));
  });
  return { status: missing.length || invalid.length ? "incomplete" : "ready", missing, invalid };
}

export function inspectEnvironment(env: EnvironmentSource = process.env): EnvironmentStatus {
  const app = sectionStatus(
    env,
    ["APP_URL", "APP_SECRET_ENCRYPTION_KEY", "CRON_SECRET", "OWNER_SETUP_SECRET"],
    {
      APP_URL: isHttpUrl,
      APP_SECRET_ENCRYPTION_KEY: (candidate) => {
        try {
          decodeEncryptionKey(candidate);
          return true;
        } catch {
          return false;
        }
      },
      CRON_SECRET: (candidate) => candidate.length >= 32,
      OWNER_SETUP_SECRET: (candidate) => candidate.length >= 32 && candidate.length <= 4_096,
    },
  );
  const supabase = sectionStatus(
    env,
    ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"],
    { NEXT_PUBLIC_SUPABASE_URL: isHttpUrl },
  );
  const resend = sectionStatus(env, ["RESEND_API_KEY", "RESEND_FROM_EMAIL"], {
    RESEND_FROM_EMAIL: isEmail,
  });
  const ai = sectionStatus(
    env,
    ["AI_PROVIDER", "AI_MODEL", "AI_BASE_URL", "AI_API_KEY", "AI_WEB_RESEARCH_REQUIRED"],
    {
      AI_BASE_URL: isHttpUrl,
      AI_WEB_RESEARCH_REQUIRED: (candidate) => candidate === "true",
    },
  );
  const github = sectionStatus(
    env,
    ["GITHUB_OWNER", "GITHUB_REPOSITORY", "GITHUB_BRANCH", "GITHUB_FINE_GRAINED_TOKEN"],
    {
      GITHUB_OWNER: (candidate) => /^[A-Za-z0-9_.-]+$/.test(candidate),
      GITHUB_REPOSITORY: (candidate) => /^[A-Za-z0-9_.-]+$/.test(candidate),
      GITHUB_BRANCH: (candidate) => candidate === "trunk",
    },
  );
  const sections = { app, supabase, resend, ai, github };
  return {
    ...sections,
    readyForLiveOperations: Object.values(sections).every((entry) => entry.status === "ready"),
  };
}

export function requireServerEnvironment(env: EnvironmentSource = process.env): ServerEnvironment {
  const status = inspectEnvironment(env);
  if (!status.readyForLiveOperations) throw new EnvironmentValidationError(status);

  return {
    app: {
      url: value(env, "APP_URL"),
      encryptionKey: value(env, "APP_SECRET_ENCRYPTION_KEY"),
      cronSecret: value(env, "CRON_SECRET"),
      ownerSetupSecret: value(env, "OWNER_SETUP_SECRET"),
    },
    supabase: {
      url: value(env, "NEXT_PUBLIC_SUPABASE_URL"),
      publishableKey: value(env, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"),
      secretKey: value(env, "SUPABASE_SECRET_KEY"),
    },
    resend: { apiKey: value(env, "RESEND_API_KEY"), fromEmail: value(env, "RESEND_FROM_EMAIL") },
    ai: {
      provider: value(env, "AI_PROVIDER"),
      model: value(env, "AI_MODEL"),
      baseUrl: value(env, "AI_BASE_URL"),
      apiKey: value(env, "AI_API_KEY"),
      webResearchRequired: true,
    },
    github: {
      owner: value(env, "GITHUB_OWNER"),
      repository: value(env, "GITHUB_REPOSITORY"),
      branch: "trunk",
      token: value(env, "GITHUB_FINE_GRAINED_TOKEN"),
    },
  };
}
