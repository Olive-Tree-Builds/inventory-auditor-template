"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";

export type SetupServiceId = "supabase" | "railway" | "resend" | "ai" | "github";

export type SetupServiceStatus =
  | boolean
  | "configured"
  | "missing"
  | "checking"
  | "error";

export type SetupRequiredScreenProps = {
  configuredServices: Partial<Record<SetupServiceId, SetupServiceStatus>>;
  onRetry: () => Promise<void>;
  error?: string | null;
};

type SetupSecretName =
  | "APP_SECRET_ENCRYPTION_KEY"
  | "CRON_SECRET"
  | "OWNER_SETUP_SECRET";

type GeneratedSetupSecrets = Record<SetupSecretName, string>;

const setupSecretLabels: Array<{ name: SetupSecretName; description: string }> = [
  { name: "APP_SECRET_ENCRYPTION_KEY", description: "Encrypts provider keys saved in the app" },
  { name: "CRON_SECRET", description: "Protects the scheduled forecast job" },
  { name: "OWNER_SETUP_SECRET", description: "Protects creation of the first owner" },
];

function randomHex(bytes = 32): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

const services = [
  {
    id: "supabase",
    number: "01",
    name: "Supabase",
    purpose: "Provides secure sign-in and stores workspace data.",
    stage: "Bootstrap environment",
    icon: Database,
    actions: [
      "Create one dedicated project only if Supabase shows an approved Free / $0 quote. If no Free quota is available or any charge appears, stop and ask for approval.",
      "Add the Project URL, publishable key, and server-only secret key to the exact Railway variables listed under Setup on the repository front page.",
    ],
    values: ["Project URL", "Publishable key", "Secret key — server only"],
    href: "https://supabase.com/dashboard",
    linkLabel: "Open Supabase",
  },
  {
    id: "railway",
    number: "02",
    name: "Railway",
    purpose: "Builds and hosts this private GitHub repository.",
    stage: "Bootstrap environment",
    icon: Rocket,
    actions: [
      "Leave Railway's default production environment empty. Create an empty environment named staging, then add this repository's trunk branch there.",
      "Generate the public app URL, enter the seven required values from Setup on the repository front page, and redeploy.",
      "Set a Compute usage alert and hard limit no higher than the approved amount. Railway's Free allowance does not guarantee that the app will remain at $0.",
    ],
    values: ["APP_URL", "Encryption key", "Cron secret", "Owner setup code", "Supabase values"],
    href: "https://docs.railway.com/quick-start",
    linkLabel: "Railway quick start",
  },
] as const;

function presentStatus(status: SetupServiceStatus | undefined) {
  if (status === true || status === "configured") {
    return { label: "Configured", className: "status-active" };
  }

  if (status === "checking") {
    return { label: "Checking", className: "status-invited" };
  }

  if (status === "error") {
    return { label: "Check failed", className: "status-warning" };
  }

  return { label: "Needs setup", className: "status-warning" };
}

export function SetupRequiredScreen({
  configuredServices,
  onRetry,
  error,
}: SetupRequiredScreenProps) {
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [generatedSecrets, setGeneratedSecrets] = useState<GeneratedSetupSecrets | null>(null);
  const [copiedSecret, setCopiedSecret] = useState<SetupSecretName | null>(null);
  const [secretToolError, setSecretToolError] = useState<string | null>(null);

  function generateSetupSecrets() {
    if (generatedSecrets && !window.confirm("Replace the three values currently shown? Copy them to the password manager before generating replacements.")) return;

    setSecretToolError(null);
    setCopiedSecret(null);

    try {
      setGeneratedSecrets({
        APP_SECRET_ENCRYPTION_KEY: randomHex(),
        CRON_SECRET: randomHex(),
        OWNER_SETUP_SECRET: randomHex(),
      });
    } catch {
      setSecretToolError(
        "This browser could not create secure values. Update the browser or contact the person or team who shared this repository before continuing.",
      );
    }
  }

  async function copySetupSecret(name: SetupSecretName) {
    const value = generatedSecrets?.[name];
    if (!value) return;

    setSecretToolError(null);
    try {
      await navigator.clipboard.writeText(value);
      setCopiedSecret(name);
    } catch {
      setCopiedSecret(null);
      setSecretToolError("Automatic copy was blocked. Select the displayed value and copy it manually, then store it in the password manager.");
    }
  }

  async function retrySetupCheck() {
    setIsRetrying(true);
    setRetryError(null);

    try {
      await onRetry();
    } catch {
      setRetryError(
        "The setup check could not be completed. Review the connections below and try again.",
      );
    } finally {
      setIsRetrying(false);
    }
  }

  const visibleError = error || retryError;

  return (
    <main className="auth-page" aria-labelledby="setup-required-title">
      <section className="auth-story" aria-label="Inventory Auditor setup overview">
        <div className="brand-lockup brand-lockup-light">
          <BrandLogo size={46} priority />
          <span>Inventory Auditor</span>
        </div>

        <div className="auth-story-copy">
          <span className="eyebrow eyebrow-light">
            <ShieldCheck size={15} aria-hidden="true" />
            Owner-controlled setup
          </span>
          <h1>Set up Supabase and Railway first.</h1>
          <p>
            This repository supplies the application, not provider accounts or
            credentials. That keeps every account replaceable and owned by the
            organization receiving the app.
          </p>

          <ul className="auth-benefits" aria-label="Setup stages">
            <li><Check size={17} aria-hidden="true" /> First: create Supabase and add the Railway safety values.</li>
            <li><Check size={17} aria-hidden="true" /> Next: create the first owner account.</li>
            <li><Check size={17} aria-hidden="true" /> After sign-in: add Resend, AI, and GitHub only for the features you want.</li>
          </ul>
        </div>

        <p className="auth-story-footer">
          No paid upgrade or provider charge should be approved without the owner&apos;s permission.
        </p>
      </section>

      <section className="auth-form-panel" aria-describedby="setup-required-summary">
        <div className="auth-form-wrap">
          <div className="mobile-brand">
            <BrandLogo size={40} />
            <span>Inventory Auditor</span>
          </div>

          <div className="prototype-badge">Setup required</div>

          <div className="auth-heading">
            <h2 id="setup-required-title">Connect the two services needed to sign in</h2>
            <p id="setup-required-summary">
              Follow Setup on your private repository&apos;s front page. Resend, AI,
              and GitHub are added later inside the app.
            </p>
          </div>

          <div className="setup-cost-note">
            <AlertTriangle size={21} aria-hidden="true" />
            <div>
              <strong>Stop before an unexpected charge</strong>
              <span>
                Continue only with an approved Free / $0 Supabase quote. Another
                organization does not add Free-project quota. Railway $0 hosting
                is not guaranteed. Do not upgrade a provider without approval.
              </span>
            </div>
          </div>

          <section className="setup-secret-generator" aria-labelledby="setup-secret-generator-title">
            <div className="setup-secret-generator-heading">
              <span className="setup-secret-generator-icon"><KeyRound size={21} aria-hidden="true" /></span>
              <div>
                <h3 id="setup-secret-generator-title">Generate Railway security values</h3>
                <p>Use a trusted private device and open the organization password manager first. Copy places one value on this device&apos;s clipboard. Nothing is uploaded or saved by the app.</p>
              </div>
              <button type="button" className="button button-secondary" onClick={generateSetupSecrets}>
                <Sparkles size={16} aria-hidden="true" />
                {generatedSecrets ? "Generate replacements" : "Generate safe values"}
              </button>
            </div>

            {secretToolError ? <p className="setup-secret-generator-error" role="alert">{secretToolError}</p> : null}

            {generatedSecrets ? (
              <div className="setup-secret-values" aria-describedby="setup-secret-generator-warning">
                {setupSecretLabels.map((secret) => (
                  <div className="setup-secret-value" key={secret.name}>
                    <label htmlFor={`generated-${secret.name}`}>
                      <strong>{secret.name}</strong>
                      <span>{secret.description}</span>
                    </label>
                    <div>
                      <input
                        id={`generated-${secret.name}`}
                        value={generatedSecrets[secret.name]}
                        readOnly
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={`${secret.name} generated value`}
                      />
                      <button
                        type="button"
                        className="icon-button"
                        aria-label={`Copy ${secret.name}`}
                        onClick={() => void copySetupSecret(secret.name)}
                      >
                        {copiedSecret === secret.name ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                      </button>
                    </div>
                  </div>
                ))}
                <p id="setup-secret-generator-warning">
                  Copy all three into the organization password manager now. Closing or refreshing this page erases them. After saving the last one, copy a harmless word to replace it on the clipboard. Never put them in GitHub, chat, or a screenshot.
                </p>
              </div>
            ) : null}
          </section>

          {visibleError ? (
            <div className="analysis-validation" role="alert" aria-live="assertive">
              <AlertTriangle size={17} aria-hidden="true" />
              <div>
                <strong>Setup check needs attention</strong>
                <span>{visibleError}</span>
              </div>
            </div>
          ) : null}

          <div className="config-tab-stack setup-guide">
            <div className="setup-step-list" role="list" aria-label="Services required before sign-in">
              {services.map((service) => {
                const Icon = service.icon;
                const status = presentStatus(configuredServices[service.id]);

                return (
                  <article className="panel setup-step-card" role="listitem" key={service.id}>
                    <div className="setup-step-rail" aria-hidden="true">
                      <span>{service.number}</span>
                      <i />
                    </div>
                    <div className="setup-step-body">
                      <div className="setup-step-heading">
                        <span className="setup-service-icon"><Icon size={21} aria-hidden="true" /></span>
                        <div>
                          <h3>{service.name}</h3>
                          <p>{service.purpose}</p>
                        </div>
                        <span
                          className={`status-badge ${status.className}`}
                          aria-label={`${service.name}: ${status.label}`}
                        >
                          <span className="status-dot" aria-hidden="true" />
                          {status.label}
                        </span>
                      </div>

                      <div className="setup-values">
                        <strong>When this is configured</strong>
                        <div><code>{service.stage}</code></div>
                      </div>

                      <ol className="setup-actions">
                        {service.actions.map((action) => <li key={action}>{action}</li>)}
                      </ol>

                      <div className="setup-values">
                        <strong>What you will need</strong>
                        <div>{service.values.map((value) => <code key={value}>{value}</code>)}</div>
                      </div>

                      {"href" in service ? (
                        <div className="setup-doc-links">
                          <a href={service.href} target="_blank" rel="noreferrer">
                            {service.linkLabel}
                            <ExternalLink size={14} aria-hidden="true" />
                            <span className="sr-only"> (opens in a new tab)</span>
                          </a>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <div className="setup-finish-actions">
            <p className="field-help">Open your private GitHub repository and follow <strong>Setup</strong> on its front page.</p>
            <button
              type="button"
              className="button button-primary"
              disabled={isRetrying}
              aria-busy={isRetrying}
              onClick={() => void retrySetupCheck()}
            >
              <RefreshCw size={16} aria-hidden="true" />
              {isRetrying ? "Checking setup…" : "Retry setup check"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
