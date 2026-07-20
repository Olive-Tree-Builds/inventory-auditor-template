"use client";

import { FormEvent, useEffect, useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";

type InvitationDetails = {
  valid: boolean;
  email?: string;
  displayName?: string;
  workspaceName?: string;
  expiresAt?: string;
};

export default function InvitePage() {
  const [token, setToken] = useState("");
  const [details, setDetails] = useState<InvitationDetails | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => void (async () => {
      try {
        const invitationToken = new URLSearchParams(window.location.search).get("token") || "";
        setToken(invitationToken);
        if (!invitationToken) {
          setDetails({ valid: false });
          return;
        }
        const acceptResponse = await fetch("/api/invitations/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invitationToken }),
        });
        const acceptResult = await acceptResponse.json().catch(() => ({}));
        if (acceptResult.ok && acceptResult.data?.accepted) {
          window.location.assign("/");
          return;
        }
        const response = await fetch(`/api/invitations/details?token=${encodeURIComponent(invitationToken)}`, { cache: "no-store" });
        const result = await response.json().catch(() => ({}));
        setDetails(response.ok && result.ok ? result.data : { valid: false });
        if (!response.ok) setError("The invitation could not be checked. Try opening the private link again.");
      } catch {
        setDetails({ valid: false });
        setError("The invitation could not be checked. Confirm your connection and try opening the private link again.");
      }
    })(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirm = String(form.get("confirmPassword") || "");
    if (password !== confirm) {
      setError("The passwords do not match.");
      setSubmitting(false);
      return;
    }
    try {
      const response = await fetch("/api/invitations/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, email: details?.email, password }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) {
        setError(result.error?.message || "The invitation could not be accepted.");
      } else if (result.data?.accepted) {
        window.location.assign("/");
      } else {
        setMessage(result.data?.message || "Confirm your email, then return to this link.");
      }
    } catch {
      setError("The invitation could not be accepted. Confirm your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page reset-password-page">
      <section className="auth-form-panel" aria-labelledby="invite-title">
        <div className="auth-form-wrap">
          <div className="mobile-brand"><BrandLogo size={40} priority /><span>Inventory Auditor</span></div>
          <div className="auth-heading">
            <h1 id="invite-title">Join {details?.workspaceName || "Inventory Auditor"}</h1>
            <p>{details === null ? "Checking your private invitation…" : details.valid ? `Welcome ${details.displayName}. Create a password for ${details.email}.` : "This invitation is invalid, expired, or already used."}</p>
          </div>
          {error && !details?.valid ? <p className="form-message form-message-error" role="alert">{error}</p> : null}
          {details?.valid ? (
            <form className="auth-form" onSubmit={submit}>
              <label>New password<span className="password-field"><LockKeyhole size={17} aria-hidden="true" /><input type="password" name="password" minLength={10} required autoComplete="new-password" /></span></label>
              <label>Confirm password<span className="password-field"><LockKeyhole size={17} aria-hidden="true" /><input type="password" name="confirmPassword" minLength={10} required autoComplete="new-password" /></span></label>
              {error ? <p className="form-message form-message-error" role="alert">{error}</p> : null}
              {message ? <p className="form-message form-message-success" role="status">{message}</p> : null}
              <button type="submit" className="button button-primary button-large" disabled={submitting}>{submitting ? "Creating account…" : "Accept invitation"}<ArrowRight size={18} aria-hidden="true" /></button>
            </form>
          ) : null}
        </div>
      </section>
    </main>
  );
}
