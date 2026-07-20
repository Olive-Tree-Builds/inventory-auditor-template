"use client";

import { FormEvent, useState } from "react";
import { ArrowRight, LockKeyhole } from "lucide-react";
import { BrandLogo } from "../components/BrandLogo";
import { createSupabaseBrowserClient } from "../lib/supabase/client";

export default function ResetPasswordPage() {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") || "");
    const confirmPassword = String(form.get("confirmPassword") || "");
    if (password.length < 10) {
      setError("Use at least 10 characters.");
      setSubmitting(false);
      return;
    }
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      setSubmitting(false);
      return;
    }

    try {
      const supabase = createSupabaseBrowserClient();
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        throw updateError;
      }
      window.location.assign("/");
    } catch {
      setError("The reset link may have expired or the request could not be completed. Request a new link from the sign-in screen and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="auth-page reset-password-page">
      <section className="auth-form-panel" aria-labelledby="reset-title">
        <div className="auth-form-wrap">
          <div className="mobile-brand">
            <BrandLogo size={40} priority />
            <span>Inventory Auditor</span>
          </div>
          <div className="auth-heading">
            <h1 id="reset-title">Choose a new password</h1>
            <p>Use a unique password you do not use for another service.</p>
          </div>
          <form className="auth-form" onSubmit={submit}>
            <label>
              New password
              <span className="password-field">
                <LockKeyhole size={17} aria-hidden="true" />
                <input type="password" name="password" minLength={10} required autoComplete="new-password" />
              </span>
            </label>
            <label>
              Confirm new password
              <span className="password-field">
                <LockKeyhole size={17} aria-hidden="true" />
                <input type="password" name="confirmPassword" minLength={10} required autoComplete="new-password" />
              </span>
            </label>
            {error ? <p className="form-message form-message-error" role="alert">{error}</p> : null}
            <button type="submit" className="button button-primary button-large" disabled={submitting}>
              {submitting ? "Saving…" : "Save password"}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
