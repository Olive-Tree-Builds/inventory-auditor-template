"use client";

import { FormEvent, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Eye,
  EyeOff,
  LockKeyhole,
  Sparkles,
} from "lucide-react";
import { BrandLogo } from "./BrandLogo";

type AuthScreenProps = {
  onContinue: () => void;
  registrationOpen: boolean;
};

type ApiEnvelope = {
  ok: boolean;
  data?: { authenticated?: boolean; emailConfirmationRequired?: boolean; message?: string };
  error?: { message?: string };
};

export function AuthScreen({ onContinue, registrationOpen }: AuthScreenProps) {
  const [mode, setMode] = useState<"signin" | "setup">("signin");
  const [showPassword, setShowPassword] = useState(false);
  const [signInLogin, setSignInLogin] = useState("");
  const [setupTimeZone, setSetupTimeZone] = useState("Etc/UTC");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const callbackError = url.searchParams.get("auth_error");
    if (!callbackError) return;
    const timer = window.setTimeout(() => setError(callbackError === "owner_setup_incomplete"
      ? "Your email was confirmed, but first-time setup could not finish. Follow Create the first owner in Setup on the repository front page, or contact the person who shared the repository."
      : "That email link could not be confirmed. Request a new link or contact your workspace administrator."), 0);
    url.searchParams.delete("auth_error");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);

    try {
      const fields = new FormData(event.currentTarget);
      const endpoint = mode === "signin" ? "/api/auth/sign-in" : "/api/auth/sign-up";
      const payload = mode === "signin"
        ? { login: fields.get("login"), password: fields.get("password") }
        : {
            businessName: fields.get("businessName"),
            displayName: fields.get("displayName"),
            username: fields.get("username"),
            email: fields.get("email"),
            password: fields.get("password"),
            timezone: fields.get("timezone"),
            setupCode: fields.get("setupCode"),
          };
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as ApiEnvelope;
      if (!response.ok || !result.ok) throw new Error(result.error?.message || "Sign-in could not be completed.");

      if (result.data?.emailConfirmationRequired) {
        setMessage(result.data.message || "Confirm your email, then return here to sign in.");
      } else {
        onContinue();
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Sign-in could not be completed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function requestPasswordReset() {
    setMessage(null);
    if (!signInLogin.includes("@")) {
      setError("Enter your email address above before requesting a password reset.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: signInLogin }),
      });
      const result = (await response.json()) as ApiEnvelope;
      if (!response.ok || !result.ok) throw new Error(result.error?.message || "The reset email could not be sent.");
      setMessage(result.data?.message || "If that account exists, a reset link is on its way.");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The reset email could not be sent.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story" aria-labelledby="auth-story-title">
        <div className="brand-lockup brand-lockup-light">
          <BrandLogo size={46} priority />
          <span>Inventory Auditor</span>
        </div>

        <div className="auth-story-copy">
          <span className="eyebrow eyebrow-light">
            <Sparkles size={15} aria-hidden="true" />
            Production planning, made clear
          </span>
          <h1 id="auth-story-title">Know what to bake, where, and when.</h1>
          <p>
            Turn sales history and live local context into a practical daily
            production plan for every location.
          </p>

          <ul className="auth-benefits" aria-label="Inventory Auditor benefits">
            <li><Check size={17} aria-hidden="true" /> Location-specific recommendations</li>
            <li><Check size={17} aria-hidden="true" /> Your Analysis Skill controls the research</li>
            <li><Check size={17} aria-hidden="true" /> One clear email for each manager</li>
          </ul>
        </div>

        <div className="auth-forecast-card" aria-label="Example production recommendation">
          <div>
            <span className="tiny-label">Tomorrow&apos;s recommendation</span>
            <strong>487 units</strong>
          </div>
          <span className="confidence-pill">High confidence</span>
          <div className="mini-bars" aria-hidden="true">
            <span style={{ height: "48%" }} />
            <span style={{ height: "64%" }} />
            <span style={{ height: "56%" }} />
            <span style={{ height: "82%" }} />
            <span style={{ height: "72%" }} />
            <span style={{ height: "92%" }} />
            <span style={{ height: "77%" }} />
          </div>
        </div>

        <p className="auth-story-footer">White-label ready · Built for easy handoff</p>
      </section>

      <section className="auth-form-panel" aria-labelledby="auth-form-title">
        <div className="auth-form-wrap">
          <div className="mobile-brand">
            <BrandLogo size={40} />
            <span>Inventory Auditor</span>
          </div>

          <div className="prototype-badge">Secure workspace sign-in</div>

          <div className="auth-heading">
            <h2 id="auth-form-title">
              {mode === "signin" ? "Welcome back" : "Create your workspace"}
            </h2>
            <p>
              {mode === "signin"
                ? "Sign in to see today’s production plan."
                : "The first account becomes the super admin and invites the team next."}
            </p>
          </div>

          <div className="auth-mode-switch" role="group" aria-label="Account action">
            <button
              type="button"
              aria-pressed={mode === "signin"}
              className={mode === "signin" ? "is-active" : ""}
              onClick={() => { setMode("signin"); setError(null); setMessage(null); setShowPassword(false); }}
            >
              Sign in
            </button>
            {registrationOpen ? (
              <button
                type="button"
                aria-pressed={mode === "setup"}
                className={mode === "setup" ? "is-active" : ""}
                onClick={() => {
                  setMode("setup");
                  setSetupTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC");
                  setError(null);
                  setMessage(null);
                  setShowPassword(false);
                }}
              >
                First-time setup
              </button>
            ) : null}
          </div>

          <form className="auth-form" key={mode} onSubmit={submit}>
            {mode === "setup" ? (
              <>
                <label>
                  Business name
                  <input name="businessName" required minLength={2} autoComplete="organization" placeholder="Northstar Franchise Group" />
                </label>
                <div className="form-grid-two">
                  <label>
                    Your name
                    <input name="displayName" required minLength={2} autoComplete="name" placeholder="Maya Chen" />
                  </label>
                  <label>
                    Username
                    <input name="username" required minLength={3} pattern="[A-Za-z0-9._-]+" autoComplete="username" placeholder="maya.chen" />
                  </label>
                </div>
              </>
            ) : null}

            <label>
              {mode === "signin" ? "Username or email" : "Work email"}
              <input
                name={mode === "signin" ? "login" : "email"}
                type={mode === "signin" ? "text" : "email"}
                value={mode === "signin" ? signInLogin : undefined}
                onChange={mode === "signin" ? (event) => setSignInLogin(event.target.value) : undefined}
                required
                autoComplete={mode === "signin" ? "username" : "email"}
                placeholder={mode === "signin" ? "maya.chen or maya@example.com" : "maya@example.com"}
              />
            </label>

            <label>
              Password
              <span className="password-field">
                <LockKeyhole size={17} aria-hidden="true" />
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={mode === "setup" ? 10 : undefined}
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  onClick={() => setShowPassword((current) => !current)}
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </span>
            </label>

            {mode === "signin" ? (
              <div className="auth-form-options">
                <span className="field-help">Use Sign out when you finish on a shared device.</span>
                <button type="button" className="text-button" onClick={requestPasswordReset} disabled={submitting}>Forgot password?</button>
              </div>
            ) : (
              <>
                <label>
                  Default timezone
                  <input
                    name="timezone"
                    value={setupTimeZone}
                    onChange={(event) => setSetupTimeZone(event.target.value)}
                    required
                    autoComplete="off"
                  />
                </label>
                <label>
                  Owner setup code
                  <input name="setupCode" type="password" required minLength={32} autoComplete="off" aria-describedby="owner-setup-help" />
                  <small id="owner-setup-help">Copy <code>OWNER_SETUP_SECRET</code> from the organization password manager. It is not your login password.</small>
                </label>
                <p className="field-help">
                  After the first workspace is created, public registration closes. New users join through an administrator invitation.
                </p>
              </>
            )}

            {error ? <p className="form-message form-message-error" role="alert">{error}</p> : null}
            {message ? <p className="form-message form-message-success" role="status">{message}</p> : null}

            <button type="submit" className="button button-primary button-large" disabled={submitting}>
              {submitting ? "Please wait…" : mode === "signin" ? "Open dashboard" : "Create workspace"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>

          <div className="auth-help">
            <strong>{mode === "signin" ? "Need access?" : "What happens next?"}</strong>
            <span>
              {mode === "signin"
                ? "Ask your workspace administrator to send you an invitation."
                : "Add brands and locations, connect services, upload sales, then invite your team."}
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
