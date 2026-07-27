"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  AlertTriangle,
  Bot,
  BookOpen,
  Building2,
  Check,
  ChevronDown,
  CircleCheck,
  CloudUpload,
  Code2,
  Database,
  Download,
  ExternalLink,
  FileCheck2,
  FileSpreadsheet,
  Github,
  ImagePlus,
  KeyRound,
  LifeBuoy,
  Mail,
  MapPin,
  Pencil,
  Plus,
  Rocket,
  Save,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Upload,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  addAnalysisVariable,
  parseAnalysisSkill,
  prepareAnalysisSkillActivation,
  removeAnalysisVariable,
} from "../lib/analysis-skill.mjs";
import type { AppBootstrapData, AppBrand, AppEmailRecipient, AppLocation, AppUser } from "../lib/app-data";
import { AI_PROVIDER_DEFAULTS, normalizeAiProviderFamily, type AiProviderFamily } from "../lib/server/ai-provider-config";
import { BrandLogo } from "./BrandLogo";

type NotifyProps = { notify: (message: string) => void };

type ConfigurationScreenProps = NotifyProps & {
  activeAnalysisSkill: string;
  analysisSkillDraft: string;
  onAnalysisSkillDraftChange: (markdown: string) => void;
  onActivateAnalysisSkill: (markdown: string) => void;
  appData: AppBootstrapData;
  onDataChanged: () => Promise<void>;
};

const tabs = [
  { id: "setup", label: "Start here", icon: BookOpen },
  { id: "users", label: "Users", icon: Users },
  { id: "keys", label: "Keys", icon: KeyRound },
  { id: "history", label: "Historical Data", icon: FileSpreadsheet },
  { id: "brands", label: "Brands & Locations", icon: Building2 },
  { id: "analysis", label: "Analysis Skill", icon: Bot },
  { id: "email", label: "Email Schedule", icon: Mail },
] as const;

type TabId = (typeof tabs)[number]["id"];
type ProviderId = "resend" | "ai" | "github";

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function apiRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const result = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !result.ok || result.data === undefined) {
    throw new Error(result.error?.message || "The request could not be completed.");
  }
  return result.data;
}

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join("") || "IA";
}

function roleLabel(role: AppUser["role"]) {
  return role.split("_").map((part) => `${part[0]?.toLocaleUpperCase()}${part.slice(1)}`).join(" ");
}

function SetupTab({ appData, onOpenTab }: { appData: AppBootstrapData; onOpenTab: (tab: TabId) => void }) {
  const connectionReady = (provider: string) => appData.providerConnections.some((item) => item.provider === provider && item.status === "connected");
  const githubConnection = appData.providerConnections.find((item) => item.provider === "github");
  const repositoryOwner = typeof githubConnection?.configuration.repositoryOwner === "string" ? githubConnection.configuration.repositoryOwner : "";
  const repositoryName = typeof githubConnection?.configuration.repositoryName === "string" ? githubConnection.configuration.repositoryName : "";
  const fullGuideUrl = repositoryOwner && repositoryName
    ? `https://github.com/${encodeURIComponent(repositoryOwner)}/${encodeURIComponent(repositoryName)}#setup`
    : null;
  const steps = [
    {
      id: "github", number: "04", name: "GitHub", title: "Confirm the app's private home", icon: Github,
      ready: connectionReady("github"),
      purpose: "GitHub is the private file cabinet for this app and its editable forecast rulebook. It is not the AI service.",
      actions: [
        "Sign in to GitHub and open your organization's private inventory-auditor copy. Confirm the branch shown is trunk.",
        "Ask a GitHub organization owner for an access token limited to this repository with Contents: read and write. Do not give it access to every repository.",
        "Open Keys & connections, choose GitHub Sync, enter the details below, then choose Save securely and Test.",
      ],
      values: [
        "Organization name — the name before the slash in the GitHub repository address.",
        "Repository name — usually inventory-auditor.",
        "Branch — use trunk.",
        "GitHub access token — a secret limited to this app. Never email or screenshot it.",
      ],
      doneWhen: "GitHub Sync says Connected and the connection test succeeds.",
      note: "",
      links: [
        { label: "Open GitHub", href: "https://github.com/" },
        { label: "How to create the access token", href: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" },
      ],
      openTab: "keys" as TabId | null,
      openTabLabel: "Enter GitHub details",
    },
    {
      id: "supabase", number: "01", name: "Supabase", title: "Set up sign-in and secure data storage", icon: Database, ready: Boolean(appData.workspace.id),
      purpose: "Supabase handles user accounts and stores brands, locations, sales history, forecasts, and settings.",
      actions: [
        "If this card says Already working and you can sign in, leave Supabase alone—it is already connected.",
        "For a new installation, create one organization-owned project only when the displayed price is Free / $0. Never use an existing company database.",
        "Save the Project URL, publishable key, and secret key in the organization's password manager.",
        "Follow Setup on the repository front page to run the five database files once, in filename order. Put the three Supabase values in Railway only.",
      ],
      values: [
        "Project URL — the web address Supabase gives the project.",
        "Publishable key — the key the sign-in screen may use.",
        "Secret key — Railway only. Never place it in GitHub, chat, or a screenshot.",
        "Five database setup files — the files inside supabase/migrations in the private repository.",
      ],
      doneWhen: "You can sign in, this card says Already working, and the setup check says the database is ready.",
      note: "",
      links: [{ label: "Open Supabase", href: "https://supabase.com/dashboard" }],
      openTab: null as TabId | null,
      openTabLabel: "",
    },
    {
      id: "railway", number: "02", name: "Railway", title: "Put the test app online", icon: Rocket, ready: Boolean(appData.workspace.id),
      purpose: "Railway runs Inventory Auditor online and gives it a secure web address. This first copy is a safe test environment, also called staging.",
      actions: [
        "If this card says Already working and you opened Inventory Auditor at a Railway address, leave it alone—it is already connected.",
        "For a new installation, leave Railway's default production environment empty. Create an empty staging environment and connect only the private inventory-auditor repository's trunk branch there.",
        "Generate the web address, add the seven required values listed in Setup on the repository front page, then redeploy.",
        "Do not paste any password or secret key into GitHub.",
      ],
      values: [
        "Private GitHub repository — the inventory-auditor copy from Step 1.",
        "Staging web address — the HTTPS address Railway creates for the test app.",
        "Supabase values — the three values saved during Step 2.",
        "Three unique app secrets — generate these on the Setup required screen.",
        "Approved usage limit — the maximum amount the organization approved for testing.",
      ],
      doneWhen: "Railway says the deployment is Healthy and the app health check says OK.",
      note: "",
      links: [
        { label: "Open Railway", href: "https://railway.com/" },
        { label: "Railway deployment guide", href: "https://docs.railway.com/quick-start" },
      ],
      openTab: null as TabId | null,
      openTabLabel: "",
    },
    {
      id: "resend", number: "06", name: "Resend", title: "Connect email delivery", icon: Mail, ready: connectionReady("resend"),
      purpose: "Resend sends sign-in messages, invitations, and combined forecast emails.",
      actions: [
        "Create Resend with an organization-owned email. Add an organization-owned sending domain or subdomain and follow its instructions until the domain says Verified.",
        "Create two Sending access keys limited to that domain: one for Supabase sign-in email and one for Inventory Auditor. Save both in the password manager.",
        "Use the first key in Supabase email settings. In Keys & connections, enter the verified From email and the second key, then choose Save securely and Test.",
        "Keep automatic forecast email off. Later, send one test only to an internal address before enabling a schedule.",
      ],
      values: [
        "Verified sending domain — a domain or subdomain owned by the organization.",
        "From email address — the address managers will see as the sender.",
        "Two sending keys — secret keys that let Supabase and Inventory Auditor send email.",
        "Internal test inbox — an organization-controlled address used before any real recipient.",
      ],
      doneWhen: "Resend says Connected and one internal test email arrives correctly.",
      note: "",
      links: [
        { label: "Open Resend", href: "https://resend.com/" },
        { label: "How to verify a sending domain", href: "https://resend.com/docs/dashboard/domains/introduction" },
      ],
      openTab: "keys" as TabId | null,
      openTabLabel: "Enter Resend details",
    },
    {
      id: "ai", number: "05", name: "AI service", title: "Connect the forecast researcher", icon: Sparkles, ready: connectionReady("ai"),
      purpose: "The AI service follows the Analysis Skill—the editable rulebook that says what it may research—and returns quantity recommendations with source links.",
      actions: [
        "Do not choose a service or model by guessing. Ask the approved setup contact for the exact service, model, service address, and maximum budget.",
        "Create an organization-owned API account and set a firm spending limit before creating a secret key. A normal AI website login is not enough for this app.",
        "In Keys & connections, enter the exact approved values and a new key, then choose Save securely and Test.",
        "Run one forecast with invented data. That is the final proof that the approved model can research the rulebook's factors and return source links.",
      ],
      values: [
        "Approved AI service — the company supplying the forecast research.",
        "Exact model name — use the name supplied by the setup contact; do not guess.",
        "Service address — the approved API base URL supplied for that service.",
        "Secret API key — a password-like value that lets this app talk to the AI service.",
        "Written spending limit — the maximum approved usage before testing begins.",
      ],
      doneWhen: "AI Analysis says Connected and an invented-data forecast finishes with direct source links.",
      note: "No approved service, model, or budget yet? Leave this step unfinished. Historical dashboards still work; multivariate forecasts will wait.",
      links: [],
      openTab: "keys" as TabId | null,
      openTabLabel: "Enter approved AI details",
    },
    {
      id: "finish", number: "03", name: "Business data", title: "Create a brand and import test sales history", icon: CircleCheck,
      ready: appData.brands.some((brand) => brand.locations.length > 0) && Boolean(appData.latestImport),
      purpose: "Create the brand, then let one sales file discover its products and guide you through any new locations.",
      actions: [
        "Under Brands & Locations, add the brand and its logo. You do not need to enter every product or location first.",
        "Open Historical Data, choose that brand, download the template, and add invented rows. Keep the four headings unchanged.",
        "Validate the file. New products are created automatically; for each new location, enter its address and timezone or match it to an existing location.",
        "Review the new, unchanged, and corrected row counts, then import only when they are right.",
        "Open the Dashboard, select the imported location and date period, and confirm the totals match the file.",
      ],
      values: [
        "Brand details — its name, optional logo, and default timezone.",
        "Invented sales file — use sample quantities, not real customer or company data.",
        "Location details when requested — full address, unique import code, and timezone.",
        "Quick final check — the saved import and historical dashboard show the same totals.",
      ],
      doneWhen: "At least one location exists, the import is saved, and the Dashboard totals match the invented file.",
      note: "",
      links: [],
      openTab: null as TabId | null,
      openTabLabel: "",
    },
  ];
  const stepOrder = new Map([["supabase", 1], ["railway", 2], ["finish", 3], ["github", 4], ["ai", 5], ["resend", 6]]);
  const orderedSteps = [...steps].sort((left, right) => (stepOrder.get(left.id) ?? 99) - (stepOrder.get(right.id) ?? 99));
  const requiredStepIds = new Set(["supabase", "railway", "finish"]);
  const requiredSteps = orderedSteps.filter((step) => requiredStepIds.has(step.id));
  const readyCount = requiredSteps.filter((step) => step.ready).length;
  const progress = Math.round((readyCount / requiredSteps.length) * 100);
  const nextRequiredStep = requiredSteps.find((step) => !step.ready);
  const nextStep = nextRequiredStep ?? orderedSteps.find((step) => !step.ready) ?? orderedSteps[orderedSteps.length - 1];

  function stepStatus(step: (typeof steps)[number]) {
    if (!requiredStepIds.has(step.id) && !step.ready) return "Optional — not connected";
    if ((step.id === "supabase" || step.id === "railway") && step.ready) return "Already working";
    if (step.id === "finish" && step.ready) return "Basic setup ready";
    return step.ready ? "Connected" : "Not finished";
  }

  return (
    <div className="config-tab-stack setup-guide">
      <section className="setup-welcome">
        <div className="setup-welcome-copy">
          <span className="eyebrow eyebrow-light">Beginner setup guide</span>
          <h2>Set up Inventory Auditor one step at a time.</h2>
          <p>You do not need to understand AI or write code. Finish the three basic setup cards first. GitHub, AI, and Resend are optional connections for forecasting and email. If you can sign in and see this page, Supabase and Railway are already working.</p>
          <div className="setup-welcome-actions">
            <a className="button setup-welcome-button" href={`#setup-${nextStep.id}`}><CircleCheck size={16} /> {nextRequiredStep ? `Start with step ${Number(nextStep.number)}` : "Review optional connections"}</a>
            <button type="button" className="button setup-welcome-secondary" onClick={() => onOpenTab("keys")}><KeyRound size={16} /> Open Keys &amp; connections</button>
          </div>
          {fullGuideUrl ? <a className="setup-full-guide-link" href={fullGuideUrl} target="_blank" rel="noreferrer"><BookOpen size={15} /> Open Setup on the repository front page <ExternalLink size={13} /><span className="sr-only"> (opens in a new tab)</span></a> : <p className="setup-guide-location"><BookOpen size={15} /> Open your private GitHub repository. The complete <strong>Setup</strong> guide is on its front page.</p>}
        </div>
        <ol className="setup-welcome-flow" aria-label="What happens during setup">
          <li><span>First</span><strong>Use organization-owned accounts</strong><small>Save passwords and secret keys in the organization&apos;s password manager.</small></li>
          <li><span>You do</span><strong>Complete one card at a time</strong><small>Do not guess at technical values. Use the guide or ask your setup contact.</small></li>
          <li><span>After</span><strong>Run a safe test</strong><small>Use invented sales data and internal email addresses before real information.</small></li>
        </ol>
      </section>

      <section className="panel setup-preflight" aria-labelledby="setup-preflight-heading">
        <div><span className="setup-preflight-icon"><FileCheck2 size={21} /></span><div><span className="eyebrow">Before you begin</span><h3 id="setup-preflight-heading">Have these six things ready</h3></div></div>
        <ul>
          <li>An organization-owned email address</li>
          <li>Access to the private GitHub copy of this app</li>
          <li>The organization&apos;s password manager</li>
          <li>An internal test email address</li>
          <li>Invented sales data for testing</li>
          <li>The person who approves costs and AI settings</li>
        </ul>
      </section>

      <div className="setup-cost-note"><AlertTriangle size={21} /><div><strong>Stop before any charge</strong><span>Inventory Auditor has no added platform fee, but each outside service controls its own prices. If any screen asks for a card, paid plan, overage, or amount above $0, stop and get approval. Turn on usage alerts and the lowest approved spending limit before testing.</span></div></div>

      <div className="setup-guide-layout">
        <ol className="setup-step-list" aria-label="Setup steps">
          {orderedSteps.map((step) => {
            const Icon = step.icon;
            return (
              <li className="setup-step-list-item" key={step.id}>
                <article className="panel setup-step-card" id={`setup-${step.id}`}>
                  <div className="setup-step-rail" aria-hidden="true"><span>{step.number}</span><i /></div>
                  <div className="setup-step-body">
                    <div className="setup-step-heading">
                      <span className="setup-service-icon"><Icon size={21} /></span>
                      <div><span className="setup-step-count">Step {Number(step.number)} of {steps.length}</span><span className="setup-service-name">{step.name}</span><h3>{step.title}</h3><p>{step.purpose}</p></div>
                      <span className={`status-badge ${step.ready ? "status-active" : requiredStepIds.has(step.id) ? "status-warning" : "status-invited"}`} aria-label={`${step.name}: ${stepStatus(step)}`}><span className="status-dot" aria-hidden="true" />{stepStatus(step)}</span>
                    </div>
                    <div>
                      <h4 className="setup-section-label">Do this</h4>
                      <ol className="setup-actions">{step.actions.map((action) => <li key={action}>{action}</li>)}</ol>
                    </div>
                    <div className="setup-values"><strong>Have this ready</strong><ul>{step.values.map((value) => <li key={value}>{value}</li>)}</ul></div>
                    {step.note ? <div className="setup-step-note"><AlertTriangle size={16} /><span>{step.note}</span></div> : null}
                    <div className="setup-done-when"><CircleCheck size={19} /><div><strong>You&apos;re done when</strong><span>{step.doneWhen}</span></div></div>
                    {step.links.length || step.openTab ? <div className="setup-doc-links">
                      {step.links.map((link) => <a href={link.href} target="_blank" rel="noreferrer" key={link.href}>{link.label}<ExternalLink size={14} /><span className="sr-only"> (opens in a new tab)</span></a>)}
                      {step.openTab ? <button type="button" className="button button-secondary" onClick={() => onOpenTab(step.openTab!)}>{step.openTabLabel}</button> : null}
                    </div> : null}
                    {step.id === "finish" ? <div className="setup-finish-actions"><button type="button" className="button button-secondary" onClick={() => onOpenTab("brands")}>Add brands &amp; locations</button><button type="button" className="button button-primary" onClick={() => onOpenTab("history")}>Import test data</button></div> : null}
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
        <aside className="setup-side-stack">
          <section className="panel setup-checklist">
            <div className="panel-heading"><div><h3>Basic setup progress</h3><p>{appData.workspace.name}</p></div><span className="soft-badge">{readyCount} of {requiredSteps.length}</span></div>
            <div className="setup-checklist-progress" role="progressbar" aria-valuemin={0} aria-valuemax={requiredSteps.length} aria-valuenow={readyCount} aria-label={`${readyCount} of ${requiredSteps.length} basic setup sections complete`}><span style={{ width: `${progress}%` }} /></div>
            {orderedSteps.map((step) => <a href={`#setup-${step.id}`} className="setup-check-row" key={step.id}><span className={step.ready ? "setup-check-mark is-ready" : "setup-check-mark"}>{step.ready ? <Check size={13} aria-hidden="true" /> : step.number}</span><span><strong>{step.name}</strong><small>{stepStatus(step)}</small></span></a>)}
            <button type="button" className="button button-secondary button-full" onClick={() => onOpenTab("keys")}><KeyRound size={15} /> Open connection tests</button>
          </section>
          <section className="panel setup-help-card"><span className="setup-help-icon"><LifeBuoy size={20} /></span><div><h3>If you get stuck, stop on that step</h3><p>Contact the person or team that shared this repository. Share the step number, screen name, what you expected, what happened, the time, and the error with private details hidden. Never send passwords, API keys, tokens, customer data, or screenshots of secret-value screens. If a service asks for payment, stop and request approval.</p></div></section>
        </aside>
      </div>
    </div>
  );
}

function UsersTab({ notify, appData, onDataChanged }: NotifyProps & Pick<ConfigurationScreenProps, "appData" | "onDataChanged">) {
  const [showInvite, setShowInvite] = useState(false);
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [editing, setEditing] = useState<AppUser | null>(null);
  const [editLocations, setEditLocations] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const allLocations = appData.brands.flatMap((brand) => brand.locations.map((location) => ({ ...location, brandName: brand.name, brandActive: brand.active })));
  const locations = allLocations.filter((location) => location.active && location.brandActive);
  const activeLocationIds = new Set(locations.map((location) => location.id));
  const locationName = (id: string) => allLocations.find((location) => location.id === id)?.name || "Unavailable location";
  const canManage = (person: AppUser) => appData.currentUser.role === "super_admin" || person.role === "manager" || person.role === "viewer";

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedLocations.length) return notify("Assign at least one location before sending the invitation.");
    setSubmitting(true);
    setInviteLink(null);
    try {
      const fields = new FormData(event.currentTarget);
      const result = await apiRequest<{ emailSent: boolean; inviteUrl: string | null; message: string }>("/api/users/invite", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: fields.get("displayName"), username: fields.get("username"), email: fields.get("email"),
          role: fields.get("role"), emailEnabled: fields.get("emailEnabled") === "on", locationIds: selectedLocations,
        }),
      });
      setInviteLink(result.inviteUrl);
      setShowInvite(Boolean(result.inviteUrl));
      setSelectedLocations([]);
      notify(result.message);
      await onDataChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The invitation could not be created.");
    } finally { setSubmitting(false); }
  }

  async function updateMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      await apiRequest(`/api/users/${editing.membershipId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: fields.get("role"), status: fields.get("status"), emailEnabled: fields.get("emailEnabled") === "on", locationIds: editLocations }),
      });
      setEditing(null);
      notify("User access and email settings saved.");
      await onDataChanged();
    } catch (error) { notify(error instanceof Error ? error.message : "The user could not be updated."); }
    finally { setSubmitting(false); }
  }

  function toggleLocation(list: string[], setter: (next: string[]) => void, id: string) {
    setter(list.includes(id) ? list.filter((value) => value !== id) : [...list, id]);
  }

  return (
    <div className="config-tab-stack">
      <div className="tab-intro-row"><div><h2>Users</h2><p>Location assignments control every dashboard, export, forecast, and email.</p></div><button type="button" className="button button-primary" disabled={!locations.length} onClick={() => { setShowInvite(true); setInviteLink(null); }}><UserPlus size={17} /> Invite user</button></div>
      {!locations.length ? <div className="info-banner"><AlertTriangle size={19} /><div><strong>Add a location first.</strong><span>Every invited user must be assigned to at least one active location.</span></div></div> : <div className="info-banner"><ShieldCheck size={19} /><div><strong>Access is server-enforced.</strong><span>A user with no active location receives no operational data or forecast email.</span></div></div>}

      {showInvite ? <form className="drawer-card" onSubmit={invite}>
        <div className="drawer-heading"><div><span className="eyebrow">New invitation</span><h3>Invite a team member</h3></div><button type="button" className="icon-button" aria-label="Close invite form" onClick={() => setShowInvite(false)}><X size={18} /></button></div>
        {inviteLink ? <div className="secure-note"><KeyRound size={18} /><span><strong>Email was not sent.</strong> Copy this private one-time link and send it through an approved channel.<input readOnly value={inviteLink} onFocus={(event) => event.currentTarget.select()} /></span></div> : <>
          <div className="form-grid-two"><label>Full name<input name="displayName" required minLength={2} /></label><label>Username<input name="username" required minLength={3} pattern="[A-Za-z0-9._-]+" /></label><label>Work email<input name="email" required type="email" /></label><label>Role<select name="role" defaultValue="manager"><option value="admin">Admin</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select></label></div>
          <fieldset className="location-checks"><legend>Assign at least one location</legend>{locations.map((location) => <label key={location.id}><input type="checkbox" checked={selectedLocations.includes(location.id)} onChange={() => toggleLocation(selectedLocations, setSelectedLocations, location.id)} /> {location.name} <span>{location.brandName}</span></label>)}</fieldset>
          <label className="switch-row"><span><strong>Send forecast emails</strong><small>Off by default. Enable only after an internal delivery test.</small></span><input name="emailEnabled" type="checkbox" /></label>
          <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={() => setShowInvite(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting || !selectedLocations.length}><Send size={16} /> {submitting ? "Creating…" : "Create invitation"}</button></div>
        </>}
      </form> : null}

      {editing ? <form className="drawer-card" onSubmit={updateMember}>
        <div className="drawer-heading"><div><span className="eyebrow">User access</span><h3>{editing.displayName}</h3></div><button type="button" className="icon-button" aria-label="Close user form" onClick={() => setEditing(null)}><X size={18} /></button></div>
        <div className="form-grid-two"><label>Role<select name="role" defaultValue={editing.role}>{appData.currentUser.role === "super_admin" ? <option value="super_admin">Super admin</option> : null}<option value="admin">Admin</option><option value="manager">Manager</option><option value="viewer">Viewer</option></select></label><label>Status<select name="status" defaultValue={editing.status}><option value="active">Active</option><option value="suspended">Suspended</option></select></label></div>
        <fieldset className="location-checks"><legend>Active locations</legend>{locations.map((location) => <label key={location.id}><input type="checkbox" checked={editLocations.includes(location.id)} onChange={() => toggleLocation(editLocations, setEditLocations, location.id)} /> {location.name} <span>{location.brandName}</span></label>)}</fieldset>
        <label className="switch-row"><span><strong>Send forecast emails</strong><small>Delivery also requires an enabled schedule.</small></span><input name="emailEnabled" type="checkbox" defaultChecked={editing.emailEnabled} /></label>
        <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> Save access</button></div>
      </form> : null}

      <div className="panel table-panel">
        <div className="panel-heading table-panel-heading"><div><h3>People</h3><p>{appData.users.length} workspace {appData.users.length === 1 ? "user" : "users"}</p></div></div>
        <div className="people-table" role="table" aria-label="Workspace users">
          <div className="people-row people-head" role="row"><span role="columnheader">Person</span><span role="columnheader">Role</span><span role="columnheader">Locations</span><span role="columnheader">Forecast email</span><span role="columnheader">Status</span><span role="columnheader"><span className="sr-only">Actions</span></span></div>
          {appData.users.map((person) => <div className="people-row" role="row" key={person.membershipId}>
            <span role="cell" className="person-cell"><span className="avatar avatar-soft">{initials(person.displayName)}</span><span><strong>{person.displayName}</strong><small>@{person.username} · {person.email}</small></span></span>
            <span role="cell"><span className="role-badge">{roleLabel(person.role)}</span></span>
            <span role="cell" className="location-cell">{person.locationIds.length ? <><strong>{locationName(person.locationIds[0])}</strong>{person.locationIds.length > 1 ? <small>+{person.locationIds.length - 1} more</small> : null}</> : <span className="attention-text">Assignment required</span>}</span>
            <span role="cell"><span className={person.emailEnabled ? "toggle-status is-on" : "toggle-status"} aria-label={person.emailEnabled ? "Email on" : "Email off"}><i /></span></span>
            <span role="cell"><span className={person.status === "active" ? "status-badge status-active" : "status-badge status-warning"}>{person.status}</span></span>
            <span role="cell">{canManage(person) ? <button type="button" className="button button-ghost" onClick={() => { setEditing(person); setEditLocations(person.locationIds.filter((id) => activeLocationIds.has(id))); }}>Edit</button> : <span className="soft-badge">Super admin only</span>}</span>
          </div>)}
        </div>
      </div>
    </div>
  );
}

const providerMeta: Record<ProviderId, { name: string; detail: string; icon: typeof Mail }> = {
  resend: { name: "Resend", detail: "Invitation and forecast email delivery.", icon: Mail },
  ai: { name: "AI Analysis", detail: "Analysis Skill execution and live web research.", icon: Sparkles },
  github: { name: "GitHub Sync", detail: "Permanent ANALYSIS_SKILL.md version history.", icon: Github },
};

function providerFailureText(code: string | null | undefined): string | null {
  if (!code) return null;
  const messages: Record<string, string> = {
    configuration_incomplete: "Complete the provider settings before testing.",
    credential_missing: "Save the provider credential before testing.",
    credential_unreadable: "Replace the saved credential and test again.",
    unsafe_endpoint: "Use an approved public HTTPS provider URL.",
    model_unavailable: "The exact model is not available to this API key.",
    capability_unsupported: "The provider or model rejected its required live-search or JSON-output capability check.",
    web_search_unavailable: "The model did not perform the required live web search.",
    structured_output_unavailable: "The model did not return host-validatable JSON after web search.",
    unauthorized: "The provider rejected the saved credential.",
    forbidden: "The credential does not have permission for this operation or model.",
    not_found: "The provider endpoint or model was not found.",
    rate_limited: "The provider rate limit was reached.",
    provider_unavailable: "The provider was unavailable or rejected the test.",
    network_error: "The provider could not be reached.",
    invalid_response: "The provider returned an incompatible response.",
  };
  return messages[code] || "The last provider test failed. Test again for current details.";
}

function KeysTab({ notify, appData, onDataChanged }: NotifyProps & Pick<ConfigurationScreenProps, "appData" | "onDataChanged">) {
  const [editing, setEditing] = useState<ProviderId | null>(null);
  const [aiFamily, setAiFamily] = useState<AiProviderFamily>("openai");
  const [customAiBaseUrl, setCustomAiBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const connection = (provider: ProviderId) => appData.providerConnections.find((item) => item.provider === provider);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      const secret = String(fields.get("secret") || "").trim();
      const body = editing === "resend" ? { senderEmail: fields.get("senderEmail"), ...(secret ? { apiKey: secret } : {}) }
        : editing === "ai" ? { providerName: aiFamily, modelName: fields.get("modelName"), baseUrl: fields.get("baseUrl"), ...(secret ? { apiKey: secret } : {}) }
          : { repositoryOwner: fields.get("repositoryOwner"), repositoryName: fields.get("repositoryName"), repositoryBranch: "trunk", ...(secret ? { token: secret } : {}) };
      await apiRequest(`/api/integrations/${editing}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      setEditing(null);
      notify(`${providerMeta[editing].name} settings saved. Run the connection test next.`);
      await onDataChanged();
    } catch (error) { notify(error instanceof Error ? error.message : "The connection could not be saved."); }
    finally { setSubmitting(false); }
  }

  async function test(provider: ProviderId) {
    setSubmitting(true);
    try {
      const result = await apiRequest<{ passed: boolean; message: string; errorCode: string | null }>(`/api/integrations/${provider}/test`, { method: "POST" });
      notify(result.message || (result.passed ? `${providerMeta[provider].name} connected.` : `${providerMeta[provider].name} needs attention.`));
      await onDataChanged();
    } catch (error) { notify(error instanceof Error ? error.message : "The connection test failed."); }
    finally { setSubmitting(false); }
  }

  const editingConnection = editing ? connection(editing) : undefined;
  const config = editingConnection?.configuration ?? {};
  function beginEditing(provider: ProviderId) {
    if (provider === "ai") {
      const aiConfig = connection("ai")?.configuration as { providerName?: unknown; baseUrl?: unknown } | null | undefined;
      setAiFamily(normalizeAiProviderFamily(aiConfig?.providerName) ?? "openai");
      setCustomAiBaseUrl(typeof aiConfig?.baseUrl === "string" ? aiConfig.baseUrl : "");
    }
    setEditing(provider);
  }
  return <div className="config-tab-stack">
    <div className="tab-intro-row"><div><h2>Keys &amp; connections</h2><p>Supabase and Railway bootstrap the app; replaceable provider credentials can be managed here.</p></div></div>
    <div className="secure-note"><ShieldCheck size={18} /><span><strong>Write-only secrets.</strong> Saved values are encrypted on the server and are never displayed again. Only a short mask and test status are returned.</span></div>
    <div className="integration-grid">
      {[{ name: "Supabase", detail: "Sign-in and database · managed in Railway", icon: Database }, { name: "Railway", detail: "Hosting and bootstrap secrets · managed in Railway", icon: Rocket }].map((item) => { const Icon = item.icon; return <article className="integration-card" key={item.name}><div className="integration-card-top"><span className="integration-icon"><Icon size={21} /></span><span className="status-badge status-active">Ready</span></div><div><h3>{item.name}</h3><p>{item.detail}</p></div><div className="integration-meta"><span>Deployment-managed</span><small>Never shown in browser settings</small></div></article>; })}
      {(Object.keys(providerMeta) as ProviderId[]).map((provider) => {
        const meta = providerMeta[provider]; const item = connection(provider); const Icon = meta.icon; const connected = item?.status === "connected";
        const failureText = providerFailureText(item?.lastErrorCode);
        return <article className="integration-card" key={provider}><div className="integration-card-top"><span className="integration-icon"><Icon size={21} /></span><span className={`status-badge ${connected ? "status-active" : "status-warning"}`}>{connected ? "Connected" : item?.status || "Unconfigured"}</span></div><div><h3>{meta.name}</h3><p>{meta.detail}</p></div><div className="integration-meta"><span>{item?.maskedHint ? `Credential ${item.maskedHint}` : "Credential required"}</span><small>{failureText || (item?.lastTestedAt ? `Tested ${new Date(item.lastTestedAt).toLocaleString()}` : "Not tested")}</small></div>{provider === "ai" ? <p className="field-help">The capability test makes one small live web-search API call and may use provider credits.</p> : null}<div className="integration-actions"><button type="button" className="button button-secondary" disabled={submitting || !item} onClick={() => void test(provider)}>{provider === "ai" ? "Test capabilities" : "Test"}</button><button type="button" className="button button-ghost" onClick={() => beginEditing(provider)}>{item ? "Replace or edit" : "Connect"}</button></div></article>;
      })}
    </div>

    {editing ? <form className="drawer-card" onSubmit={save}>
      <div className="drawer-heading"><div><span className="eyebrow">Secure connection</span><h3>{providerMeta[editing].name}</h3></div><button type="button" className="icon-button" aria-label="Close connection form" onClick={() => setEditing(null)}><X size={18} /></button></div>
      {editing === "resend" ? <label>Verified From email<input name="senderEmail" required type="email" defaultValue={String(config.senderEmail || "")} placeholder="forecasts@example.com" /></label> : null}
      {editing === "ai" ? <div className="form-grid-two"><label>AI provider<select name="providerName" required value={aiFamily} onChange={(event) => setAiFamily(event.target.value as AiProviderFamily)}>{Object.entries(AI_PROVIDER_DEFAULTS).map(([value, item]) => <option value={value} key={value}>{item.label}</option>)}</select></label><label>Model<input name="modelName" required defaultValue={String(config.modelName || "")} placeholder={AI_PROVIDER_DEFAULTS[aiFamily].modelPlaceholder} /></label><label className="full-field">API base URL<input name="baseUrl" required type="url" value={aiFamily === "responses-compatible" ? customAiBaseUrl : AI_PROVIDER_DEFAULTS[aiFamily].baseUrl} onChange={(event) => setCustomAiBaseUrl(event.target.value)} readOnly={aiFamily !== "responses-compatible"} placeholder={aiFamily === "responses-compatible" ? "https://provider.example/v1" : undefined} /></label></div> : null}
      {editing === "github" ? <div className="form-grid-two"><label>Repository owner<input name="repositoryOwner" required defaultValue={String(config.repositoryOwner || "")} placeholder="Your GitHub organization" /></label><label>Repository name<input name="repositoryName" required defaultValue={String(config.repositoryName || "")} placeholder="Your cloned repository" /></label><label>Branch<input name="repositoryBranch" readOnly value="trunk" /></label></div> : null}
      <label>{editingConnection && editing === "resend" ? "New API key (leave blank to keep the current value)" : editingConnection ? "Re-enter the credential to save these settings" : "Secret"}<input name="secret" required={!editingConnection || editing === "ai" || editing === "github"} type="password" autoComplete="off" placeholder={editing === "github" ? "Fine-grained token" : "API key"} /></label>
      {editing === "ai" ? <p className="field-help">The base URL and API key are treated as one security binding. Changing the URL requires a new key in the same save. Testing creates one small live web-search response and may use provider credits.</p> : <p className="field-help">The old value is never returned and is replaced only by a new write-only credential.</p>}
      <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><ShieldCheck size={16} /> {submitting ? "Saving…" : "Save securely"}</button></div>
    </form> : null}
  </div>;
}

type ImportLocationOption = { id: string; name: string; importCode: string; timeZone: string };
type ImportProductOption = { id: string; name: string; importCode: string };
type ImportOutcomeCounts = { insertedCount: number; correctedCount: number; unchangedCount: number; productsCreatedCount: number };
type ImportPreview = {
  selectedBrand: { id: string; name: string };
  availableLocations: ImportLocationOption[];
  availableProducts: ImportProductOption[];
  checksum: string;
  filename: string;
  rowCount: number;
  dateFrom: string;
  dateTo: string;
  errors: string[];
  unresolvedLocations: Array<{ sourceLocation: string; rowNumbers: number[]; rowCount: number }>;
  productDecisions: Array<{ sourceProduct: string; productId: string | null; productName: string; decision: "existing" | "mapped" | "new"; rowNumbers: number[]; rowCount: number }>;
  outcomes: ImportOutcomeCounts;
  committed: boolean;
  alreadyImported?: boolean;
  result?: ImportOutcomeCounts & { importBatchId: string };
};

type ImportLocationDraft = {
  choice: "new" | "existing";
  existingLocationId: string;
  name: string;
  code: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  timezone: string;
};

function suggestedImportCode(value: string) {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return normalized.length >= 2 ? normalized : `loc_${normalized || "new"}`.slice(0, 24);
}

function HistoryTab({ notify, appData, onDataChanged, onOpenBrands }: NotifyProps & Pick<ConfigurationScreenProps, "appData" | "onDataChanged"> & { onOpenBrands: () => void }) {
  const activeBrands = useMemo(() => appData.brands.filter((brand) => brand.active), [appData.brands]);
  const [requestedBrandId, setRequestedBrandId] = useState("");
  const brandId = activeBrands.some((brand) => brand.id === requestedBrandId)
    ? requestedBrandId
    : activeBrands[0]?.id || "";
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [locationMappings, setLocationMappings] = useState<Record<string, string>>({});
  const [productMappings, setProductMappings] = useState<Record<string, string>>({});
  const [locationDrafts, setLocationDrafts] = useState<Record<string, ImportLocationDraft>>({});
  const [productChoicesDirty, setProductChoicesDirty] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const selectedBrand = activeBrands.find((brand) => brand.id === brandId) || null;
  const timeZones = useMemo(() => Array.from(new Set([
    selectedBrand?.defaultTimeZone,
    appData.workspace.defaultTimeZone,
    ...appData.brands.flatMap((brand) => [brand.defaultTimeZone, ...brand.locations.map((location) => location.timezone)]),
    ...FALLBACK_TIME_ZONES,
    ...SUPPORTED_TIME_ZONES,
  ].filter((value): value is string => Boolean(value)))).sort((left, right) => left.localeCompare(right)), [appData.brands, appData.workspace.defaultTimeZone, selectedBrand?.defaultTimeZone]);

  function resetReview() {
    setPreview(null);
    setLocationMappings({});
    setProductMappings({});
    setLocationDrafts({});
    setProductChoicesDirty(false);
  }

  function selectBrand(nextBrandId: string) {
    setRequestedBrandId(nextBrandId);
    setFile(null);
    resetReview();
  }

  function selectFile(next: File | null) {
    setFile(next);
    resetReview();
  }

  function draftFor(sourceLocation: string): ImportLocationDraft {
    return {
      choice: "new",
      existingLocationId: "",
      name: sourceLocation,
      code: suggestedImportCode(sourceLocation),
      addressLine1: "",
      city: "",
      region: "",
      postalCode: "",
      countryCode: "CA",
      timezone: selectedBrand?.defaultTimeZone || appData.workspace.defaultTimeZone,
    };
  }

  function mergeLocationDrafts(result: ImportPreview) {
    setLocationDrafts((current) => {
      const next = { ...current };
      for (const location of result.unresolvedLocations) next[location.sourceLocation] ||= draftFor(location.sourceLocation);
      for (const sourceLocation of Object.keys(next)) {
        if (!result.unresolvedLocations.some((location) => location.sourceLocation === sourceLocation)) delete next[sourceLocation];
      }
      return next;
    });
  }

  async function send(mode: "preview" | "commit", nextLocationMappings = locationMappings, nextProductMappings = productMappings) {
    if (!selectedBrand) return notify("Create and select a brand before uploading historical data.");
    if (!file) return notify("Choose an Excel or CSV file first.");
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mode", mode);
      form.set("brandId", selectedBrand.id);
      form.set("locationMappings", JSON.stringify(nextLocationMappings));
      form.set("productMappings", JSON.stringify(nextProductMappings));
      const result = await apiRequest<ImportPreview>("/api/history/import", { method: "POST", body: form });
      setPreview(result);
      mergeLocationDrafts(result);
      setProductChoicesDirty(false);
      if (result.alreadyImported) {
        notify("This exact file was already imported. Nothing changed.");
      } else if (!result.committed) {
        if (result.errors.length) notify("Validation found issues. Nothing was saved.");
        else if (result.unresolvedLocations.length) notify(`Finish ${result.unresolvedLocations.length} new or unmatched ${result.unresolvedLocations.length === 1 ? "location" : "locations"}, then re-check the file.`);
        else notify("Preview ready. Review the products and row changes before importing.");
      } else {
        const counts = result.result || result.outcomes;
        notify(`Import complete: ${counts.insertedCount} new, ${counts.unchangedCount} unchanged, ${counts.correctedCount} corrected.`);
        await onDataChanged();
      }
      return result;
    } catch (error) {
      notify(error instanceof Error ? error.message : "The file could not be processed.");
      return null;
    } finally { setSubmitting(false); }
  }

  function updateLocationDraft(sourceLocation: string, patch: Partial<ImportLocationDraft>) {
    setLocationDrafts((current) => ({ ...current, [sourceLocation]: { ...(current[sourceLocation] || draftFor(sourceLocation)), ...patch } }));
  }

  async function resolveLocations() {
    if (!preview?.unresolvedLocations.length || !selectedBrand) return;
    setSubmitting(true);
    const nextMappings = { ...locationMappings };
    try {
      for (const unresolved of preview.unresolvedLocations) {
        const draft = locationDrafts[unresolved.sourceLocation] || draftFor(unresolved.sourceLocation);
        if (draft.choice === "existing") {
          if (!draft.existingLocationId) throw new Error(`Choose the existing location for “${unresolved.sourceLocation}”.`);
          nextMappings[unresolved.sourceLocation] = draft.existingLocationId;
          continue;
        }
        const created = await apiRequest<{ id?: string } | string>("/api/locations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId: selectedBrand.id,
            name: draft.name,
            code: draft.code,
            addressLine1: draft.addressLine1,
            city: draft.city,
            region: draft.region,
            postalCode: draft.postalCode,
            countryCode: draft.countryCode,
            timezone: draft.timezone,
          }),
        });
        const createdId = typeof created === "string" ? created : created.id;
        if (!createdId) throw new Error(`“${unresolved.sourceLocation}” was created but could not be linked. Refresh and validate the file again.`);
        nextMappings[unresolved.sourceLocation] = createdId;
      }
      setLocationMappings(nextMappings);
      try { await onDataChanged(); } catch { /* The import route reads the new locations directly. */ }
    } catch (error) {
      notify(error instanceof Error ? error.message : "The locations could not be finished.");
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    await send("preview", nextMappings, productMappings);
  }

  function chooseProduct(sourceProduct: string, productId: string) {
    setProductMappings((current) => {
      const next = { ...current };
      if (productId) next[sourceProduct] = productId;
      else delete next[sourceProduct];
      return next;
    });
    setProductChoicesDirty(true);
  }

  const unresolvedCount = preview?.unresolvedLocations.length || 0;
  const hasBlockingReview = Boolean(preview?.errors.length || unresolvedCount || productChoicesDirty);
  const outcomes = preview?.result || preview?.outcomes;

  return <div className="config-tab-stack">
    <div className="tab-intro-row"><div><h2>Historical data</h2><p>Select one brand, upload complete daily totals, and let the app organize its locations and products.</p></div><a className="button button-secondary" href="/inventory-history-template.xlsx" download><Download size={17} /> Download Excel template</a></div>

    {!activeBrands.length ? <section className="panel history-brand-empty"><Building2 size={24} /><div><h3>Create the brand first</h3><p>A brand owns the products and locations discovered in each upload. You do not need to create them all manually.</p></div><button type="button" className="button button-primary" onClick={onOpenBrands}><Plus size={16} /> Add a brand</button></section> : <section className="panel history-brand-selector"><span className="history-step-number">1</span><div><span className="eyebrow">First, choose the owner of this file</span><h3>Which brand does this sales history belong to?</h3><p>The spreadsheet does not need a brand column. Every product and location will stay inside the brand selected here.</p></div><label>Brand<select value={brandId} onChange={(event) => selectBrand(event.target.value)}>{activeBrands.map((brand) => <option value={brand.id} key={brand.id}>{brand.name}</option>)}</select></label></section>}

    <div className="import-steps" aria-label="Import progress"><span className={selectedBrand ? "is-active" : ""}><i>1</i>Choose brand</span><span className={file ? "is-active" : ""}><i>2</i>Upload file</span><span className={preview ? "is-active" : ""}><i>3</i>Resolve &amp; review</span><span className={preview?.committed || preview?.alreadyImported ? "is-active" : ""}><i>4</i>Import</span></div>

    <div className="import-layout">
      <section className="panel import-panel"><div className="panel-heading"><div><h3>Upload {selectedBrand ? `${selectedBrand.name} history` : "sales history"}</h3><p>Excel or CSV · maximum 5 MB and 20,000 rows</p></div></div>
        <label className={`upload-zone ${!selectedBrand ? "is-disabled" : ""}`} onDragOver={(event) => { if (!selectedBrand) return; event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onDrop={(event) => { if (!selectedBrand) return; event.preventDefault(); selectFile(event.dataTransfer.files?.[0] || null); }}><input type="file" accept=".xlsx,.csv" disabled={!selectedBrand} onChange={(event) => selectFile(event.target.files?.[0] || null)} /><span className="upload-icon"><CloudUpload size={25} /></span><strong>{file?.name || (selectedBrand ? "Choose a file or drag it here" : "Choose a brand first")}</strong><span>{file ? "Ready for validation" : ".xlsx or .csv up to 5 MB"}</span><span className="button button-secondary"><Upload size={16} /> Browse files</span></label>
        <div className="drawer-actions"><button type="button" className="button button-secondary" disabled={!selectedBrand || !file || submitting} onClick={() => void send("preview")}>Validate and preview</button><button type="button" className="button button-primary" disabled={!preview || hasBlockingReview || preview.committed || preview.alreadyImported || submitting} onClick={() => void send("commit")}><Save size={16} /> Import reviewed file</button></div>
      </section>
      <aside className="panel template-guide"><div className="panel-heading"><div><h3>Four simple columns</h3><p>Keep these headings exactly as shown.</p></div></div><div className="column-list"><span><code>date</code><small>YYYY-MM-DD · no timestamp</small></span><span><code>product</code><small>Automatically created or matched</small></span><span><code>location</code><small>Set up or matched during review</small></span><span><code>quantity</code><small>Complete daily total · whole number</small></span></div><div className="guide-note"><MapPin size={16} /><span>The brand comes from the selector above. A later file adds new dates and never removes history that is not in that file.</span></div></aside>
    </div>

    {preview?.errors.length ? <section className="panel import-review-panel"><div className="panel-heading"><div><h3>Fix these validation issues</h3><p>Nothing from this file has been saved.</p></div><span className="status-badge status-warning">{preview.errors.length} issues</span></div><div className="analysis-validation" role="alert"><AlertTriangle size={17} /><div><strong>Check the spreadsheet and upload it again</strong>{preview.errors.slice(0, 20).map((error) => <span key={error}>{error}</span>)}</div></div></section> : null}

    {preview?.unresolvedLocations.length ? <section className="panel import-review-panel"><div className="panel-heading"><div><span className="eyebrow">Location setup</span><h3>Finish the locations found in this file</h3><p>Choose an existing location or provide the address and timezone once. The source label will be remembered for later uploads.</p></div><span className="status-badge status-warning">{unresolvedCount} to finish</span></div><div className="import-resolution-list">{preview.unresolvedLocations.map((unresolved) => { const draft = locationDrafts[unresolved.sourceLocation] || draftFor(unresolved.sourceLocation); return <article className="import-resolution-card" key={unresolved.sourceLocation}><div className="resolution-card-heading"><span className="location-pin"><MapPin size={17} /></span><div><strong>{unresolved.sourceLocation}</strong><small>{unresolved.rowCount} {unresolved.rowCount === 1 ? "row" : "rows"} in the file</small></div></div><div className="resolution-choice" role="group" aria-label={`How to handle ${unresolved.sourceLocation}`}><label><input type="radio" checked={draft.choice === "new"} onChange={() => updateLocationDraft(unresolved.sourceLocation, { choice: "new" })} /> Add as a new location</label><label><input type="radio" checked={draft.choice === "existing"} onChange={() => updateLocationDraft(unresolved.sourceLocation, { choice: "existing" })} /> Match an existing location</label></div>{draft.choice === "existing" ? <label className="resolution-existing-select">Existing {selectedBrand?.name} location<select value={draft.existingLocationId} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { existingLocationId: event.target.value })}><option value="">Choose a location…</option>{preview.availableLocations.map((location) => <option value={location.id} key={location.id}>{location.name} · {location.importCode}</option>)}</select></label> : <div className="form-grid-two resolution-location-fields"><label>Location name<input required minLength={2} maxLength={120} value={draft.name} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { name: event.target.value })} /></label><label>Unique import code<input required minLength={2} maxLength={24} pattern="[A-Za-z0-9_-]+" value={draft.code} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { code: event.target.value })} /></label><label className="full-field">Street address<input required minLength={2} maxLength={160} value={draft.addressLine1} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { addressLine1: event.target.value })} /></label><label>City<input required minLength={2} maxLength={100} value={draft.city} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { city: event.target.value })} /></label><label>State / province / region<input required minLength={2} maxLength={100} value={draft.region} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { region: event.target.value })} /></label><label>Postal code<input required minLength={2} maxLength={20} value={draft.postalCode} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { postalCode: event.target.value })} /></label><label>Country code<input required minLength={2} maxLength={2} value={draft.countryCode} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { countryCode: event.target.value.toLocaleUpperCase() })} /></label><label>Timezone<select required value={draft.timezone} onChange={(event) => updateLocationDraft(unresolved.sourceLocation, { timezone: event.target.value })}>{timeZones.map((timeZone) => <option value={timeZone} key={timeZone}>{timeZone.replaceAll("_", " ")}</option>)}</select></label></div>}</article>; })}</div><div className="drawer-actions"><button type="button" className="button button-primary" disabled={submitting} onClick={() => void resolveLocations()}><CircleCheck size={16} /> {submitting ? "Finishing locations…" : "Save locations and re-check file"}</button></div></section> : null}

    {preview && !preview.errors.length && !preview.unresolvedLocations.length ? <section className="panel import-review-panel"><div className="panel-heading"><div><span className="eyebrow">Product review</span><h3>Products discovered for {preview.selectedBrand.name}</h3><p>Known names are matched automatically. For a new or misspelled label, create it or map it to the correct existing product.</p></div><span className="status-badge status-active">{preview.productDecisions.length} products</span></div><div className="product-decision-list">{preview.productDecisions.map((decision) => <div className="product-decision-row" key={decision.sourceProduct}><span><strong>{decision.sourceProduct}</strong><small>{decision.rowCount} {decision.rowCount === 1 ? "row" : "rows"}</small></span>{decision.decision === "existing" ? <span className="status-badge status-active">Matched to {decision.productName}</span> : <label><span className="sr-only">Decision for {decision.sourceProduct}</span><select value={productMappings[decision.sourceProduct] || decision.productId || ""} onChange={(event) => chooseProduct(decision.sourceProduct, event.target.value)}><option value="">Create new product</option>{preview.availableProducts.map((product) => <option value={product.id} key={product.id}>Match {product.name}</option>)}</select></label>}</div>)}</div>{productChoicesDirty ? <div className="import-choice-reminder"><AlertTriangle size={17} /><span>Apply the changed product choices before importing.</span><button type="button" className="button button-secondary" disabled={submitting} onClick={() => void send("preview")}>Re-check product choices</button></div> : null}</section> : null}

    {preview && !preview.errors.length && !preview.unresolvedLocations.length && outcomes ? <section className="panel import-review-panel"><div className="panel-heading"><div><span className="eyebrow">Final review</span><h3>{preview.alreadyImported ? "This exact file was already imported" : preview.committed ? "Import complete" : "Exactly what this file will change"}</h3><p>{preview.filename} · {preview.rowCount.toLocaleString()} rows · {preview.dateFrom || "No date"} to {preview.dateTo || "No date"}</p></div><span className={`status-badge ${preview.committed || preview.alreadyImported ? "status-active" : ""}`}>{preview.alreadyImported ? "Already imported" : preview.committed ? "Saved" : "Not saved yet"}</span></div><div className="import-outcome-grid"><article><strong>{outcomes.insertedCount.toLocaleString()}</strong><span>New rows</span><small>New dates or product/location combinations</small></article><article><strong>{outcomes.unchangedCount.toLocaleString()}</strong><span>Unchanged rows</span><small>Already stored with the same daily total</small></article><article className={outcomes.correctedCount ? "has-corrections" : ""}><strong>{outcomes.correctedCount.toLocaleString()}</strong><span>Corrections</span><small>Existing daily totals that will be replaced</small></article><article><strong>{outcomes.productsCreatedCount.toLocaleString()}</strong><span>New products</span><small>Automatically created under {preview.selectedBrand.name}</small></article></div><div className="import-preservation-note"><ShieldCheck size={18} /><span><strong>No other history will be removed.</strong> Dates and products missing from this file stay exactly as they are.</span></div></section> : null}

    {appData.latestImport ? <section className="panel import-history-panel"><div className="panel-heading"><div><h3>Most recent saved import</h3><p>Every committed file is checksummed and audited.</p></div></div><div className="import-history-row"><span className="file-icon"><FileCheck2 size={19} /></span><span><strong>{appData.latestImport.filename}</strong><small>{appData.latestImport.dateFrom}–{appData.latestImport.dateTo} · {appData.latestImport.rowCount.toLocaleString()} rows</small></span><span className="status-badge status-active">Imported</span><time>{appData.latestImport.committedAt ? new Date(appData.latestImport.committedAt).toLocaleDateString() : ""}</time></div></section> : null}
  </div>;
}

const FALLBACK_TIME_ZONES = [
  "UTC",
  "America/St_Johns",
  "America/Halifax",
  "America/Toronto",
  "America/Winnipeg",
  "America/Edmonton",
  "America/Vancouver",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const SUPPORTED_TIME_ZONES = (() => {
  try {
    const supportedValuesOf = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf;
    return supportedValuesOf ? supportedValuesOf("timeZone") : FALLBACK_TIME_ZONES;
  } catch {
    return FALLBACK_TIME_ZONES;
  }
})();

const BRAND_LOGO_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BRAND_LOGO_BYTES = 2 * 1024 * 1024;

type BrandLogoSelection = { dataUrl: string; filename: string };

async function readLogoFile(file: File): Promise<BrandLogoSelection> {
  if (!BRAND_LOGO_TYPES.has(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP logo.");
  }
  if (file.size > MAX_BRAND_LOGO_BYTES) {
    throw new Error("The brand logo must be 2 MiB or smaller.");
  }
  return new Promise<BrandLogoSelection>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The brand logo could not be read."));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl.startsWith(`data:${file.type};base64,`)) {
        reject(new Error("The selected logo is not a valid image."));
        return;
      }
      resolve({ dataUrl, filename: file.name });
    };
    reader.readAsDataURL(file);
  });
}

function BrandArtwork({ name, src, size = 48 }: { name: string; src?: string | null; size?: number }) {
  return <span className={`brand-artwork${src ? " has-image" : ""}`} style={{ width: size, height: size }}>{src ? <Image src={src} alt={`${name} logo`} width={size} height={size} unoptimized /> : name.charAt(0).toLocaleUpperCase()}</span>;
}

function BrandLogoPicker({ id, name, currentUrl, selected, disabled, onSelected, notify }: {
  id: string;
  name: string;
  currentUrl?: string | null;
  selected: BrandLogoSelection | null;
  disabled: boolean;
  onSelected: (selection: BrandLogoSelection | null) => void;
  notify: NotifyProps["notify"];
}) {
  function choose(file?: File) {
    if (!file) return;
    void readLogoFile(file)
      .then((selection) => {
        onSelected(selection);
        notify(`${selection.filename} is ready. Save the brand to upload it.`);
      })
      .catch((error: unknown) => notify(error instanceof Error ? error.message : "The brand logo could not be selected."));
  }

  return <div className="brand-logo-upload">
    <BrandArtwork name={name || "Brand"} src={selected?.dataUrl || currentUrl} size={68} />
    <div className="brand-logo-upload-copy"><strong>Brand logo</strong><span>PNG, JPEG, or WebP · maximum 2 MiB. A square image works best and is shown in a circle.</span>{selected ? <small>{selected.filename} selected</small> : currentUrl ? <small>Current saved logo</small> : <small>No logo uploaded yet</small>}</div>
    <div className="brand-logo-upload-actions">
      <label className="brand-logo-picker"><input id={id} hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled} onChange={(event) => { choose(event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} /><span className="button button-secondary"><ImagePlus size={16} /> {currentUrl || selected ? "Choose another" : "Choose logo"}</span></label>
      {selected ? <button type="button" className="button button-ghost" disabled={disabled} onClick={() => onSelected(null)}><X size={15} /> Clear selection</button> : null}
    </div>
  </div>;
}

function BrandsTab({ notify, appData, onDataChanged }: NotifyProps & Pick<ConfigurationScreenProps, "appData" | "onDataChanged">) {
  const [addingBrand, setAddingBrand] = useState(false);
  const [locationBrand, setLocationBrand] = useState<string | null>(null);
  const [editingBrand, setEditingBrand] = useState<AppBrand | null>(null);
  const [editingLocation, setEditingLocation] = useState<AppLocation | null>(null);
  const [newBrandLogo, setNewBrandLogo] = useState<BrandLogoSelection | null>(null);
  const [editedBrandLogo, setEditedBrandLogo] = useState<BrandLogoSelection | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const locations = appData.brands.flatMap((brand) => brand.locations);
  const selectedLocationBrand = appData.brands.find((brand) => brand.id === locationBrand) || null;
  const timeZones = Array.from(new Set([
    appData.workspace.defaultTimeZone,
    ...appData.brands.map((brand) => brand.defaultTimeZone),
    ...locations.map((location) => location.timezone),
    ...FALLBACK_TIME_ZONES,
    ...SUPPORTED_TIME_ZONES,
  ].filter(Boolean))).sort((left, right) => left.localeCompare(right));

  function closeEditors() {
    setAddingBrand(false);
    setLocationBrand(null);
    setEditingBrand(null);
    setEditingLocation(null);
    setNewBrandLogo(null);
    setEditedBrandLogo(null);
  }

  function openBrandCreator() {
    closeEditors();
    setAddingBrand(true);
  }

  function openBrandEditor(brand: AppBrand) {
    closeEditors();
    setEditingBrand(brand);
  }

  function openLocationCreator(brandId: string) {
    closeEditors();
    setLocationBrand(brandId);
  }

  function openLocationEditor(location: AppLocation) {
    closeEditors();
    setEditingLocation(location);
  }

  async function uploadBrandLogo(brandId: string, logo: BrandLogoSelection | null) {
    if (!logo) return { cleanupPending: false };
    return apiRequest<{ cleanupPending: boolean }>(`/api/brands/${encodeURIComponent(brandId)}/logo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: logo.dataUrl }),
    });
  }

  async function addBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      const result = await apiRequest<{ id?: string } | string>("/api/brands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: fields.get("name"), code: fields.get("code"), defaultTimeZone: fields.get("defaultTimeZone") }),
      });
      const brandId = typeof result === "string" ? result : result.id;
      let message = newBrandLogo ? "Brand and logo added." : "Brand added.";
      if (newBrandLogo) {
        if (!brandId) {
          message = "Brand added, but its logo could not be linked. Open Edit brand and upload it again.";
        } else {
          try {
            const upload = await uploadBrandLogo(brandId, newBrandLogo);
            if (upload.cleanupPending) message = "Brand and logo added. An older logo is queued for cleanup.";
          }
          catch { message = "Brand added, but its logo could not be uploaded. Open Edit brand to try again."; }
        }
      }
      closeEditors();
      notify(message);
      try { await onDataChanged(); }
      catch { notify("Brand saved. Refresh the page if the updated details do not appear yet."); }
    } catch (error) {
      notify(error instanceof Error ? error.message : "The brand could not be added.");
    } finally { setSubmitting(false); }
  }

  async function updateBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingBrand) return;
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      await apiRequest(`/api/brands/${encodeURIComponent(editingBrand.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.get("name"),
          code: fields.get("code"),
          defaultTimeZone: fields.get("defaultTimeZone"),
          active: fields.get("active") === "on",
          expectedUpdatedAt: editingBrand.updatedAt,
        }),
      });
      let message = editedBrandLogo ? "Brand details and logo saved." : "Brand details saved.";
      if (editedBrandLogo) {
        try {
          const upload = await uploadBrandLogo(editingBrand.id, editedBrandLogo);
          if (upload.cleanupPending) message = "Brand details and logo saved. The previous logo still needs automatic cleanup.";
        }
        catch { message = "Brand details saved, but the new logo could not be uploaded. Open Edit brand to try the logo again."; }
      }
      closeEditors();
      notify(message);
      try { await onDataChanged(); }
      catch { notify("Brand saved. Refresh the page if the updated details do not appear yet."); }
    } catch (error) {
      notify(error instanceof Error ? error.message : "The brand could not be updated.");
    } finally { setSubmitting(false); }
  }

  async function addLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!locationBrand) return;
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      await apiRequest("/api/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brandId: locationBrand,
          name: fields.get("name"),
          code: fields.get("code"),
          addressLine1: fields.get("addressLine1"),
          city: fields.get("city"),
          region: fields.get("region"),
          postalCode: fields.get("postalCode"),
          countryCode: fields.get("countryCode"),
          timezone: fields.get("timezone"),
        }),
      });
      closeEditors();
      notify("Location added and assigned to you.");
      try { await onDataChanged(); }
      catch { notify("Location saved. Refresh the page if the new location does not appear yet."); }
    } catch (error) { notify(error instanceof Error ? error.message : "The location could not be added."); }
    finally { setSubmitting(false); }
  }

  async function updateLocation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingLocation) return;
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      await apiRequest(`/api/locations/${encodeURIComponent(editingLocation.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: fields.get("name"),
          code: fields.get("code"),
          addressLine1: fields.get("addressLine1"),
          city: fields.get("city"),
          region: fields.get("region"),
          postalCode: fields.get("postalCode"),
          countryCode: fields.get("countryCode"),
          timezone: fields.get("timezone"),
          active: fields.get("active") === "on",
          expectedUpdatedAt: editingLocation.updatedAt,
        }),
      });
      closeEditors();
      notify("Location details saved.");
      try { await onDataChanged(); }
      catch { notify("Location saved. Refresh the page if the updated details do not appear yet."); }
    } catch (error) { notify(error instanceof Error ? error.message : "The location could not be updated."); }
    finally { setSubmitting(false); }
  }

  return <div className="config-tab-stack">
    <div className="tab-intro-row"><div><h2>Brands &amp; locations</h2><p>Each location has its own access boundary, timezone, import code, and research address.</p></div><button type="button" className="button button-primary" onClick={openBrandCreator}><Plus size={17} /> Add brand</button></div>
    <div className="brand-summary-grid"><article><strong>{appData.brands.filter((brand) => brand.active).length}</strong><span>Active brands</span></article><article><strong>{locations.filter((location) => location.active).length}</strong><span>Active locations</span></article><article><strong>{appData.users.filter((user) => user.locationIds.length).length}</strong><span>Assigned users</span></article></div>

    {addingBrand ? <form className="drawer-card" onSubmit={addBrand}>
      <div className="drawer-heading"><div><span className="eyebrow">New brand</span><h3>Add a brand</h3></div><button type="button" className="icon-button" onClick={closeEditors} aria-label="Close brand form"><X size={18} /></button></div>
      <div className="form-grid-two"><label>Brand name<input name="name" required minLength={2} maxLength={120} /></label><label>Short code<input name="code" required minLength={2} maxLength={24} pattern="[A-Za-z0-9_-]+" placeholder="BAKERY" /></label><label className="full-field">Default timezone<select name="defaultTimeZone" required defaultValue={appData.workspace.defaultTimeZone}>{timeZones.map((timeZone) => <option value={timeZone} key={timeZone}>{timeZone.replaceAll("_", " ")}</option>)}</select></label></div>
      <BrandLogoPicker id="new-brand-logo" name="New brand" selected={newBrandLogo} disabled={submitting} onSelected={setNewBrandLogo} notify={notify} />
      <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={closeEditors}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> {submitting ? "Adding…" : "Add brand"}</button></div>
    </form> : null}

    {editingBrand ? <form className="drawer-card" key={editingBrand.id} onSubmit={updateBrand}>
      <div className="drawer-heading"><div><span className="eyebrow">Brand settings</span><h3>Edit {editingBrand.name}</h3></div><button type="button" className="icon-button" onClick={closeEditors} aria-label="Close brand editor"><X size={18} /></button></div>
      <div className="form-grid-two"><label>Brand name<input name="name" required minLength={2} maxLength={120} defaultValue={editingBrand.name} /></label><label>Short code<input name="code" required minLength={2} maxLength={24} pattern="[A-Za-z0-9_-]+" defaultValue={editingBrand.code} /></label><label className="full-field">Default timezone<select name="defaultTimeZone" required defaultValue={editingBrand.defaultTimeZone}>{timeZones.map((timeZone) => <option value={timeZone} key={timeZone}>{timeZone.replaceAll("_", " ")}</option>)}</select></label></div>
      <BrandLogoPicker id={`brand-logo-${editingBrand.id}`} name={editingBrand.name} currentUrl={editingBrand.logoUrl} selected={editedBrandLogo} disabled={submitting} onSelected={setEditedBrandLogo} notify={notify} />
      <label className="switch-row"><span><strong>Brand is active</strong><small>Archived brands stay in past records but cannot accept new locations.</small></span><input name="active" type="checkbox" defaultChecked={editingBrand.active} /></label>
      <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={closeEditors}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> {submitting ? "Saving…" : "Save brand"}</button></div>
    </form> : null}

    {locationBrand && selectedLocationBrand ? <form className="drawer-card" key={locationBrand} onSubmit={addLocation}>
      <div className="drawer-heading"><div><span className="eyebrow">{selectedLocationBrand.name}</span><h3>Add a location</h3></div><button type="button" className="icon-button" onClick={closeEditors} aria-label="Close location form"><X size={18} /></button></div>
      <div className="form-grid-two"><label>Location name<input name="name" required minLength={2} maxLength={120} /></label><label>Unique import code<input name="code" required minLength={2} maxLength={24} pattern="[A-Za-z0-9_-]+" /></label><label className="full-field">Street address<input name="addressLine1" required minLength={2} maxLength={160} /></label><label>City<input name="city" required minLength={2} maxLength={100} /></label><label>State / province / region<input name="region" required minLength={2} maxLength={100} /></label><label>Postal code<input name="postalCode" required minLength={2} maxLength={20} /></label><label>Country code<input name="countryCode" required defaultValue="CA" minLength={2} maxLength={2} /></label><label>Timezone<select name="timezone" required defaultValue={selectedLocationBrand.defaultTimeZone || appData.workspace.defaultTimeZone}>{timeZones.map((timeZone) => <option value={timeZone} key={timeZone}>{timeZone.replaceAll("_", " ")}</option>)}</select></label></div>
      <p className="field-help">The full address is sent to the approved AI provider only when a forecast needs location-specific research.</p>
      <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={closeEditors}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> {submitting ? "Adding…" : "Add location"}</button></div>
    </form> : null}

    {editingLocation ? <form className="drawer-card" key={editingLocation.id} onSubmit={updateLocation}>
      <div className="drawer-heading"><div><span className="eyebrow">Location settings</span><h3>Edit {editingLocation.name}</h3></div><button type="button" className="icon-button" onClick={closeEditors} aria-label="Close location editor"><X size={18} /></button></div>
      <div className="form-grid-two"><label>Location name<input name="name" required minLength={2} maxLength={120} defaultValue={editingLocation.name} /></label><label>Unique import code<input name="code" required minLength={2} maxLength={24} pattern="[A-Za-z0-9_-]+" defaultValue={editingLocation.code} /></label><label className="full-field">Street address<input name="addressLine1" required minLength={2} maxLength={160} defaultValue={editingLocation.addressLine1} /></label><label>City<input name="city" required minLength={2} maxLength={100} defaultValue={editingLocation.city} /></label><label>State / province / region<input name="region" required minLength={2} maxLength={100} defaultValue={editingLocation.region} /></label><label>Postal code<input name="postalCode" required minLength={2} maxLength={20} defaultValue={editingLocation.postalCode} /></label><label>Country code<input name="countryCode" required minLength={2} maxLength={2} defaultValue={editingLocation.countryCode} /></label><label>Timezone<select name="timezone" required defaultValue={editingLocation.timezone}>{timeZones.map((timeZone) => <option value={timeZone} key={timeZone}>{timeZone.replaceAll("_", " ")}</option>)}</select></label></div>
      <label className="switch-row"><span><strong>Location is active</strong><small>Archived locations stay in historical records but stop receiving new imports, forecasts, and email.</small></span><input name="active" type="checkbox" defaultChecked={editingLocation.active} /></label>
      <p className="field-help">Address and timezone changes affect future location-specific research. Existing forecasts keep their original audit context.</p>
      <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={closeEditors}>Cancel</button><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> {submitting ? "Saving…" : "Save location"}</button></div>
    </form> : null}

    <div className="brand-list">{appData.brands.length ? appData.brands.map((brand) => <article className="panel brand-card" key={brand.id}>
      <div className="brand-card-heading"><div className="brand-title"><BrandArtwork name={brand.name} src={brand.logoUrl} size={46} /><div><h3>{brand.name}</h3><p>Code {brand.code} · Default timezone {brand.defaultTimeZone} · {brand.locations.length} {brand.locations.length === 1 ? "location" : "locations"}</p></div></div><div className="brand-actions"><button type="button" className="button button-ghost" aria-label={`Edit ${brand.name}`} onClick={() => openBrandEditor(brand)}><Pencil size={15} /> Edit brand</button>{brand.active ? <button type="button" className="button button-secondary" onClick={() => openLocationCreator(brand.id)}><Plus size={15} /> Add location</button> : <span className="status-badge status-warning">Archived brand</span>}</div></div>
      <div className="location-list">{brand.locations.length ? brand.locations.map((location) => <div className="location-row" key={location.id}><span className="location-pin"><MapPin size={17} /></span><span><strong>{location.name}</strong><small>{location.city}, {location.region} · {location.code}</small></span><span><small>Timezone</small><strong>{location.timezone}</strong></span><span><small>Assigned users</small><strong>{appData.users.filter((user) => user.locationIds.includes(location.id)).length}</strong></span><span className={`status-badge ${location.active ? "status-active" : "status-warning"}`}>{location.active ? "Active" : "Archived"}</span><button type="button" className="icon-button" aria-label={`Edit ${location.name}`} onClick={() => openLocationEditor(location)}><Pencil size={15} /></button></div>) : <div className="brand-location-empty"><MapPin size={18} /><span>No locations yet. Add the first location to begin assigning users and importing sales.</span></div>}</div>
    </article>) : <div className="panel empty-state"><Building2 size={24} /><h3>Add your first brand</h3><p>Then add at least one physical location before inviting users or importing data.</p></div>}</div>
  </div>;
}

function AnalysisTab({ notify, activeAnalysisSkill, analysisSkillDraft, onAnalysisSkillDraftChange, onActivateAnalysisSkill, onDataChanged }: Omit<ConfigurationScreenProps, "appData">) {
  const [newVariableName, setNewVariableName] = useState("");
  const [githubSha, setGithubSha] = useState<string | null>(null);
  const [githubUrl, setGithubUrl] = useState<string | null>(null);
  const [repositoryPolicyActive, setRepositoryPolicyActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(analysisSkillDraft);
  const activeRef = useRef(activeAnalysisSkill);
  const draftPolicy = useMemo(() => parseAnalysisSkill(analysisSkillDraft), [analysisSkillDraft]);
  const activePolicy = useMemo(() => parseAnalysisSkill(activeAnalysisSkill), [activeAnalysisSkill]);
  const hasUnsavedChanges = analysisSkillDraft !== activeAnalysisSkill;

  useEffect(() => {
    draftRef.current = analysisSkillDraft;
    activeRef.current = activeAnalysisSkill;
  }, [activeAnalysisSkill, analysisSkillDraft]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiRequest<{ markdown: string; sha: string; htmlUrl: string | null; isActive: boolean }>("/api/analysis-skill");
        if (cancelled) return;
        const hasDirtyDraft = draftRef.current !== activeRef.current;
        setGithubSha(result.sha);
        setGithubUrl(result.htmlUrl);
        setRepositoryPolicyActive(result.isActive);
        if (!hasDirtyDraft) onAnalysisSkillDraftChange(result.markdown);
        if (result.isActive) onActivateAnalysisSkill(result.markdown);
      } catch {
        // Keys screen explains missing GitHub setup. Keep any local draft intact.
      }
    })();
    return () => { cancelled = true; };
  }, [onActivateAnalysisSkill, onAnalysisSkillDraftChange]);

  async function activateDraft() { const prepared = prepareAnalysisSkillActivation(analysisSkillDraft, activeAnalysisSkill); if (prepared.error) return notify(prepared.error); if (!githubSha) return notify("Connect and test GitHub before activating an Analysis Skill change."); setLoading(true); try { const result = await apiRequest<{ markdown: string; sha: string; htmlUrl: string | null; commitSha: string | null }>("/api/analysis-skill", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ markdown: prepared.markdown, expectedSha: githubSha, commitMessage: "Update Inventory Auditor Analysis Skill" }) }); setGithubSha(result.sha); setGithubUrl(result.htmlUrl); setRepositoryPolicyActive(true); onAnalysisSkillDraftChange(result.markdown); onActivateAnalysisSkill(result.markdown); await onDataChanged(); notify(result.commitSha ? "Analysis Skill validated, committed to GitHub trunk, read back, and activated." : "Analysis Skill reviewed, verified against GitHub trunk, and activated."); } catch (error) { notify(error instanceof Error ? error.message : "The Analysis Skill could not be activated."); } finally { setLoading(false); } }
  function addVariable(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const result = addAnalysisVariable(analysisSkillDraft, newVariableName); if (result.error) return notify(result.error); onAnalysisSkillDraftChange(result.markdown); setNewVariableName(""); notify("Variable added to the draft. Review its rules before activating it."); }
  function removeVariable(id: string, name: string) { const result = removeAnalysisVariable(analysisSkillDraft, id); if (result.error) return notify(result.error); onAnalysisSkillDraftChange(result.markdown); notify(`${name} removed from the draft.`); }
  async function upload(file?: File) { if (!file) return; try { const markdown = await file.text(); onAnalysisSkillDraftChange(markdown); notify(`${file.name} loaded as an unsaved draft.`); } catch { notify("That Markdown file could not be read."); } }
  return <div className="config-tab-stack"><div className="tab-intro-row"><div><h2>Analysis Skill</h2><p>This complete file—not hardcoded UI labels—controls which live variables the AI may research.</p></div><span className={hasUnsavedChanges || !repositoryPolicyActive ? "sync-status" : "sync-status is-synced"}><span className="status-dot status-dot-success" />{hasUnsavedChanges ? repositoryPolicyActive ? "Unsaved draft" : "Review and activate" : !repositoryPolicyActive && githubSha ? "Review and activate" : githubSha ? "Synced to GitHub" : "GitHub setup required"}</span></div>
    <div className="analysis-rule-banner"><Bot size={20} /><div><strong>Loaded before every AI analysis</strong><span>Every activation is validated, committed to root <code>ANALYSIS_SKILL.md</code> on <code>trunk</code>, read back, and recorded with its exact hash.</span></div>{githubUrl ? <a className="button button-secondary" href={githubUrl} target="_blank" rel="noreferrer">Open in GitHub <ExternalLink size={14} /></a> : null}</div>
    <div className="analysis-layout"><section className="panel analysis-editor-panel"><div className="editor-toolbar"><span><Code2 size={16} /> ANALYSIS_SKILL.md</span><div><input ref={uploadRef} hidden type="file" accept=".md,text/markdown,text/plain" onChange={(event) => { void upload(event.target.files?.[0]); event.target.value = ""; }} /><button type="button" className="button button-ghost" onClick={() => uploadRef.current?.click()}><Upload size={15} /> Load draft</button><button type="button" className="button button-primary" disabled={(!hasUnsavedChanges && repositoryPolicyActive) || draftPolicy.errors.length > 0 || loading || !githubSha} onClick={() => void activateDraft()}><Save size={15} /> {loading ? "Saving…" : "Save and activate"}</button></div></div><label className="sr-only" htmlFor="analysis-skill-editor">Analysis Skill Markdown</label><textarea id="analysis-skill-editor" className="skill-editor" value={analysisSkillDraft} spellCheck={false} onChange={(event) => onAnalysisSkillDraftChange(event.target.value)} /><div className="editor-footer"><span>{analysisSkillDraft.split(/\s+/).filter(Boolean).length} words</span><span>Permanent source: <code>trunk/ANALYSIS_SKILL.md</code></span></div></section>
      <aside className="analysis-side-stack"><section className="panel variable-panel"><div className="panel-heading"><div><h3>{hasUnsavedChanges || !repositoryPolicyActive ? "Draft variables" : "Active variables"}</h3><p>Read from the marked active-variable block.</p></div></div>{draftPolicy.errors.length ? <div className="analysis-validation" role="alert"><AlertTriangle size={17} /><div><strong>Fix before activation</strong>{draftPolicy.errors.slice(0, 6).map((error) => <span key={error}>{error}</span>)}</div></div> : null}{draftPolicy.variables.length ? draftPolicy.variables.map((variable) => <span className="variable-row" key={variable.id}><span><CircleCheck size={16} />{variable.name}</span><button type="button" className="icon-button" aria-label={`Remove ${variable.name}`} onClick={() => removeVariable(variable.id, variable.name)}><X size={14} /></button></span>) : <div className="variable-empty"><strong>Historical baseline only</strong><span>No external research variables are active.</span></div>}<form className="add-variable-form" onSubmit={addVariable}><label htmlFor="new-analysis-variable">Add a business-specific variable</label><div><input id="new-analysis-variable" value={newVariableName} maxLength={80} placeholder="e.g. University move-in" onChange={(event) => setNewVariableName(event.target.value)} /><button type="submit" className="button button-secondary" disabled={!newVariableName.trim()}><Plus size={15} /> Add</button></div></form></section><section className="panel version-panel"><div className="panel-heading"><div><h3>Active policy</h3><p>Recorded with each stored forecast.</p></div></div><div className="version-row"><span className="version-dot" /><span><strong>Policy {activePolicy.policyVersion || "unavailable"}</strong><small>Variable revision {activePolicy.activeVariableRevision || "unavailable"} · {activePolicy.variables.length} active</small></span><span className={`status-badge ${repositoryPolicyActive ? "status-active" : "status-warning"}`}>{repositoryPolicyActive ? "Active" : "Review"}</span></div></section></aside>
    </div>
  </div>;
}

function EmailTab({ notify, appData, onDataChanged }: NotifyProps & Pick<ConfigurationScreenProps, "appData" | "onDataChanged">) {
  const schedule = appData.emailSchedule;
  const [submitting, setSubmitting] = useState(false);
  const [recipientSubmitting, setRecipientSubmitting] = useState(false);
  const [cadence, setCadence] = useState(schedule?.cadence || "daily");
  const [weekdayMask, setWeekdayMask] = useState(schedule?.weekdayMask ?? 127);
  const [recipientEditorOpen, setRecipientEditorOpen] = useState(false);
  const [editingRecipient, setEditingRecipient] = useState<AppEmailRecipient | null>(null);
  const [recipientLocations, setRecipientLocations] = useState<string[]>([]);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const locations = appData.brands.flatMap((brand) => brand.active
    ? brand.locations.filter((location) => location.active).map((location) => ({ ...location, brandName: brand.name }))
    : []);
  const locationNames = new Map(locations.map((location) => [location.id, `${location.brandName} · ${location.name}`]));

  function openNewRecipient() {
    if (!schedule) {
      notify("Save the email schedule first, then add individual recipients.");
      return;
    }
    setEditingRecipient(null);
    setRecipientLocations([]);
    setRecipientEditorOpen(true);
  }

  function openRecipient(recipient: AppEmailRecipient) {
    setEditingRecipient(recipient);
    setRecipientLocations(recipient.locationIds.filter((id) => locationNames.has(id)));
    setRecipientEditorOpen(true);
  }

  function toggleRecipientLocation(locationId: string) {
    setRecipientLocations((current) => current.includes(locationId)
      ? current.filter((id) => id !== locationId)
      : [...current, locationId]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      const normalizedMask = cadence === "daily" ? 127 : cadence === "weekdays" ? 62 : weekdayMask;
      if ((cadence === "weekly" || cadence === "custom") && normalizedMask === 0) {
        throw new Error("Choose at least one delivery day.");
      }
      await apiRequest("/api/email/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheduleId: schedule?.id || null,
          name: "Default forecast schedule",
          enabled: fields.get("enabled") === "on",
          cadence,
          weekdayMask: normalizedMask,
          localSendTime: fields.get("localSendTime"),
          timezoneRule: fields.get("timezoneRule"),
          workspaceTimeZone: appData.workspace.defaultTimeZone,
          forecastHorizon: fields.get("forecastHorizon"),
        }),
      });
      notify("Email schedule saved.");
      await onDataChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The schedule could not be saved.");
    } finally { setSubmitting(false); }
  }
  async function testEmail() { setSubmitting(true); try { const result = await apiRequest<{ message: string }>("/api/email/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ recipientUserId: appData.currentUser.userId }) }); notify(result.message); await onDataChanged(); } catch (error) { notify(error instanceof Error ? error.message : "The test email could not be sent."); } finally { setSubmitting(false); } }

  async function saveRecipient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!schedule) return notify("Save the email schedule before adding a recipient.");
    if (!recipientLocations.length) return notify("Choose at least one location for this recipient.");
    setRecipientSubmitting(true);
    try {
      const fields = new FormData(event.currentTarget);
      await apiRequest("/api/email/recipients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipientId: editingRecipient?.id || null,
          scheduleId: schedule.id,
          displayName: fields.get("displayName"),
          email: fields.get("email"),
          enabled: fields.get("enabled") === "on",
          locationIds: recipientLocations,
        }),
      });
      setRecipientEditorOpen(false);
      setEditingRecipient(null);
      setRecipientLocations([]);
      notify(editingRecipient ? "Email recipient updated." : "Email recipient added.");
      await onDataChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The email recipient could not be saved.");
    } finally {
      setRecipientSubmitting(false);
    }
  }

  async function removeRecipient(recipient: AppEmailRecipient) {
    if (!window.confirm(`Remove ${recipient.displayName} from additional forecast emails?`)) return;
    setRecipientSubmitting(true);
    try {
      await apiRequest(`/api/email/recipients/${recipient.id}`, { method: "DELETE" });
      if (editingRecipient?.id === recipient.id) {
        setRecipientEditorOpen(false);
        setEditingRecipient(null);
        setRecipientLocations([]);
      }
      notify("Email recipient removed.");
      await onDataChanged();
    } catch (error) {
      notify(error instanceof Error ? error.message : "The email recipient could not be removed.");
    } finally {
      setRecipientSubmitting(false);
    }
  }

  const assigned = appData.currentUser.locationIds.map((id) => appData.brands.flatMap((brand) => brand.locations).find((location) => location.id === id)?.name).filter(Boolean);
  return <div className="config-tab-stack"><div className="tab-intro-row"><div><h2>Email schedule</h2><p>Each enabled person receives one message containing only their currently assigned locations.</p></div><button type="button" className="button button-secondary" disabled={submitting || !assigned.length} onClick={() => void testEmail()}><Send size={16} /> Send test to me</button></div>
    <div className="info-banner"><ShieldCheck size={19} /><div><strong>Safe default: off.</strong><span>A successful internal test verifies delivery. Automatic scheduling still remains off until an administrator explicitly enables it.</span></div></div>
    <div className="schedule-layout"><form className="panel schedule-form" onSubmit={save}><label className="switch-row schedule-switch"><span><strong>Forecast emails enabled</strong><small>Recipient toggles and current assignments are rechecked at send time.</small></span><input name="enabled" type="checkbox" defaultChecked={schedule?.enabled || false} /></label><div className="form-section"><h3>Default delivery</h3><div className="form-grid-two"><label>Cadence<select name="cadence" value={cadence} onChange={(event) => { const next = event.target.value; setCadence(next); if (next === "daily") setWeekdayMask(127); if (next === "weekdays") setWeekdayMask(62); if (next === "weekly" && (weekdayMask === 0 || (weekdayMask & (weekdayMask - 1)) !== 0)) setWeekdayMask(2); }}><option value="daily">Every day</option><option value="weekdays">Monday through Friday</option><option value="weekly">Once a week</option><option value="custom">Choose days</option></select></label><label>Delivery time<input name="localSendTime" type="time" defaultValue={schedule?.localSendTime?.slice(0, 5) || "05:00"} /></label><label>Timezone rule<select name="timezoneRule" defaultValue={schedule?.timezoneRule || "earliest_assigned_location"}><option value="earliest_assigned_location">Earliest assigned location</option><option value="workspace">Workspace timezone</option></select></label><label>Forecast period<select name="forecastHorizon" defaultValue={schedule?.forecastHorizon || "today"}><option value="today">Today</option><option value="tomorrow">Tomorrow</option><option value="next_7_days">Next 7 days</option></select></label></div>{cadence === "weekly" ? <label>Delivery day<select value={Math.max(0, days.findIndex((_, index) => (weekdayMask & (1 << index)) !== 0))} onChange={(event) => setWeekdayMask(1 << Number(event.target.value))}>{days.map((day, index) => <option value={index} key={day}>{day}</option>)}</select></label> : null}{cadence === "custom" ? <fieldset className="location-checks"><legend>Delivery days</legend>{days.map((day, index) => <label key={day}><input type="checkbox" checked={(weekdayMask & (1 << index)) !== 0} onChange={() => setWeekdayMask((current) => current ^ (1 << index))} /> {day}</label>)}</fieldset> : null}</div><button type="submit" className="button button-primary" disabled={submitting}><Save size={16} /> {submitting ? "Saving…" : "Save schedule"}</button></form>
      <aside className="email-preview"><div className="email-preview-top"><span><Mail size={17} /> Test email scope</span><span className="soft-badge">{assigned.length} {assigned.length === 1 ? "location" : "locations"}</span></div><div className="email-paper"><div className="email-brand"><BrandLogo size={34} /><span><strong>Inventory Auditor</strong><small>{appData.workspace.name}</small></span></div><h3>Sent only to {appData.currentUser.displayName}</h3><p>The test uses the latest stored forecast for each assigned location. It never invents quantities and will stop with a clear message if a forecast is missing.</p>{assigned.map((name) => <div className="email-location" key={name}><span><strong>{name}</strong></span><span>Latest reviewed recommendations and citations</span></div>)}</div></aside>
    </div>

    <section className="panel email-recipient-section">
      <div className="recipient-section-heading">
        <div><h3>Individual email recipients</h3><p>Add people who need forecast emails but do not need an Inventory Auditor account. Every address must be tied to one or more locations.</p></div>
        <button type="button" className="button button-primary" disabled={!schedule || !locations.length || recipientSubmitting} aria-describedby={!schedule ? "recipient-schedule-required" : undefined} onClick={openNewRecipient}><Plus size={16} /> Add email</button>
      </div>
      {!schedule ? <div className="info-banner" id="recipient-schedule-required"><AlertTriangle size={19} /><div><strong>Save the schedule first.</strong><span>Individual addresses are attached to the saved schedule.</span></div></div> : null}
      <div className="recipient-user-note"><Users size={18} /><span><strong>App users stay in the Users tab.</strong> Their location assignments and “Send forecast emails” setting control their delivery. Addresses below receive email only and cannot sign in.</span></div>

      {recipientEditorOpen ? <form className="drawer-card recipient-editor" key={editingRecipient?.id || "new-recipient"} onSubmit={saveRecipient}>
        <div className="drawer-heading"><div><span className="eyebrow">{editingRecipient ? "Edit recipient" : "New recipient"}</span><h3>{editingRecipient ? editingRecipient.displayName : "Add an email address"}</h3></div><button type="button" className="icon-button" aria-label="Close email recipient form" onClick={() => setRecipientEditorOpen(false)}><X size={18} /></button></div>
        <div className="form-grid-two"><label>Name<input name="displayName" required minLength={1} maxLength={120} defaultValue={editingRecipient?.displayName || ""} placeholder="e.g. Downtown operations" /></label><label>Email address<input name="email" type="email" required maxLength={320} defaultValue={editingRecipient?.email || ""} placeholder="operations@example.com" /></label></div>
        <fieldset className="location-checks"><legend>Locations included in this person&apos;s email</legend>{locations.map((location) => <label key={location.id}><input type="checkbox" checked={recipientLocations.includes(location.id)} onChange={() => toggleRecipientLocation(location.id)} /><span><strong>{location.name}</strong><small>{location.brandName} · {location.city || location.region || location.countryCode}</small></span></label>)}</fieldset>
        <label className="switch-row"><span><strong>Receive forecast emails</strong><small>Turn this off to pause delivery without removing the address.</small></span><input name="enabled" type="checkbox" defaultChecked={editingRecipient?.enabled ?? true} /></label>
        <div className="drawer-actions"><button type="button" className="button button-secondary" onClick={() => setRecipientEditorOpen(false)}>Cancel</button><button type="submit" className="button button-primary" disabled={recipientSubmitting || !recipientLocations.length}><Save size={16} /> {recipientSubmitting ? "Saving…" : "Save recipient"}</button></div>
      </form> : null}

      {appData.emailRecipients.length ? <div className="recipient-list" role="list" aria-label="Additional email recipients">{appData.emailRecipients.map((recipient) => <article className="recipient-row" role="listitem" key={recipient.id}><span className="avatar avatar-soft">{initials(recipient.displayName)}</span><div className="recipient-identity"><strong>{recipient.displayName}</strong><small>{recipient.email}</small></div><div className="recipient-location-list">{recipient.locationIds.map((id) => <span className="soft-badge" key={id}>{locationNames.get(id) || "Unavailable location"}</span>)}</div><span className={`status-badge ${recipient.enabled ? "status-active" : "status-warning"}`}>{recipient.enabled ? "Email on" : "Paused"}</span><div className="recipient-actions"><button type="button" className="icon-button" aria-label={`Edit ${recipient.displayName}`} disabled={recipientSubmitting} onClick={() => openRecipient(recipient)}><Pencil size={15} /></button><button type="button" className="icon-button danger-icon-button" aria-label={`Remove ${recipient.displayName}`} disabled={recipientSubmitting} onClick={() => void removeRecipient(recipient)}><Trash2 size={15} /></button></div></article>)}</div> : <div className="recipient-empty"><Mail size={22} /><div><strong>No additional addresses yet</strong><span>App users with email enabled can still receive their location-specific forecast.</span></div></div>}
    </section>
  </div>;
}

export function ConfigurationScreen({ notify, activeAnalysisSkill, analysisSkillDraft, onAnalysisSkillDraftChange, onActivateAnalysisSkill, appData, onDataChanged }: ConfigurationScreenProps) {
  const [activeTab, setActiveTab] = useState<TabId>("setup");
  const ActiveIcon = tabs.find((tab) => tab.id === activeTab)?.icon ?? Settings2;
  const connectionCount = appData.providerConnections.filter((item) => item.status === "connected").length;
  const readyCount = 2 + connectionCount;
  return <div className="page-stack configuration-page"><header className="page-header"><div><span className="eyebrow">Workspace setup</span><h1>Configuration</h1><p>Manage people, data, connections, delivery, and the versioned instructions behind every forecast.</p></div><div className="setup-progress"><span><Check size={14} /> {readyCount} core services ready</span><i><b style={{ width: `${Math.min(100, Math.round((readyCount / 5) * 100))}%` }} /></i></div></header>
    <div className="mobile-tab-select"><ActiveIcon size={17} /><label><span className="sr-only">Configuration section</span><select value={activeTab} onChange={(event) => setActiveTab(event.target.value as TabId)}>{tabs.map((tab) => <option value={tab.id} key={tab.id}>{tab.label}</option>)}</select></label><ChevronDown size={16} /></div>
    <nav className="config-tabs" aria-label="Configuration sections">{tabs.map((tab) => { const Icon = tab.icon; const active = activeTab === tab.id; return <button type="button" key={tab.id} className={active ? "is-active" : ""} aria-current={active ? "page" : undefined} onClick={() => setActiveTab(tab.id)}><Icon size={17} />{tab.label}</button>; })}</nav>
    <section className="config-content" aria-live="polite">
      {activeTab === "setup" ? <SetupTab appData={appData} onOpenTab={setActiveTab} /> : null}
      {activeTab === "users" ? <UsersTab notify={notify} appData={appData} onDataChanged={onDataChanged} /> : null}
      {activeTab === "keys" ? <KeysTab notify={notify} appData={appData} onDataChanged={onDataChanged} /> : null}
      {activeTab === "history" ? <HistoryTab notify={notify} appData={appData} onDataChanged={onDataChanged} onOpenBrands={() => setActiveTab("brands")} /> : null}
      {activeTab === "brands" ? <BrandsTab notify={notify} appData={appData} onDataChanged={onDataChanged} /> : null}
      {activeTab === "analysis" ? <AnalysisTab notify={notify} activeAnalysisSkill={activeAnalysisSkill} analysisSkillDraft={analysisSkillDraft} onAnalysisSkillDraftChange={onAnalysisSkillDraftChange} onActivateAnalysisSkill={onActivateAnalysisSkill} onDataChanged={onDataChanged} /> : null}
      {activeTab === "email" ? <EmailTab notify={notify} appData={appData} onDataChanged={onDataChanged} /> : null}
    </section>
  </div>;
}
