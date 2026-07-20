"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  ChevronDown,
  CircleHelp,
  LayoutDashboard,
  LogOut,
  Save,
  Settings2,
  UserRound,
  X,
} from "lucide-react";
import type { AppView } from "./InventoryAuditorApp";
import type { AppUser } from "../lib/app-data";
import { BrandLogo } from "./BrandLogo";

type AppShellProps = {
  activeView: AppView;
  children: ReactNode;
  onNavigate: (view: AppView) => void;
  onProfileSaved: () => Promise<void>;
  onSignOut: () => Promise<void>;
  notify: (message: string) => void;
  currentUser: AppUser;
  dashboardBrands: Array<{ id: string; name: string; locations: Array<{ id: string; name: string }> }>;
  dashboardBrandId: string;
  dashboardLocationId: string;
  onDashboardBrandChange: (brandId: string) => void;
  onDashboardLocationChange: (locationId: string) => void;
};

const navItems: Array<{ id: AppView; label: string; icon: typeof LayoutDashboard }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "configuration", label: "Configuration", icon: Settings2 },
];

function initials(name: string) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join("") || "IA";
}

function roleLabel(role: AppUser["role"]) {
  return role.split("_").map((part) => `${part[0]?.toLocaleUpperCase()}${part.slice(1)}`).join(" ");
}

function apiMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const root = value as { error?: { message?: unknown }; message?: unknown };
  return typeof root.error?.message === "string"
    ? root.error.message
    : typeof root.message === "string" ? root.message : fallback;
}

export function AppShell({
  activeView,
  children,
  onNavigate,
  onProfileSaved,
  onSignOut,
  notify,
  currentUser,
  dashboardBrands,
  dashboardBrandId,
  dashboardLocationId,
  onDashboardBrandChange,
  onDashboardLocationChange,
}: AppShellProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const dialogRef = useRef<HTMLElement | null>(null);
  const dialogOpenerRef = useRef<HTMLElement | null>(null);
  const profileSavingRef = useRef(false);
  const userInitials = initials(currentUser.displayName);
  const isAdmin = currentUser.role === "super_admin" || currentUser.role === "admin";
  const visibleNavItems = isAdmin ? navItems : navItems.filter((item) => item.id === "dashboard");
  const dashboardLocations = dashboardBrandId === "all"
    ? dashboardBrands.flatMap((brand) => brand.locations)
    : dashboardBrands.find((brand) => brand.id === dashboardBrandId)?.locations ?? [];
  const allBrandsLabel = dashboardBrands.length ? "All brands" : "No brands assigned";
  const allLocationsLabel = dashboardLocations.length ? "All locations" : "No locations assigned";
  const selectedLocationName = dashboardLocationId === "all"
    ? allLocationsLabel
    : dashboardLocations.find((location) => location.id === dashboardLocationId)?.name ?? allLocationsLabel;

  useEffect(() => {
    profileSavingRef.current = profileSaving;
  }, [profileSaving]);

  useEffect(() => {
    if (!profileOpen && !helpOpen) return;
    const dialog = dialogRef.current;
    const opener = dialogOpenerRef.current;
    if (!dialog) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableSelector = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";
    const focusables = () => [...dialog.querySelectorAll<HTMLElement>(focusableSelector)].filter((element) => element.offsetParent !== null);
    const focusFrame = window.requestAnimationFrame(() => {
      (dialog.querySelector<HTMLElement>("[data-dialog-initial]") || focusables()[0] || dialog).focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (profileOpen && profileSavingRef.current) return;
        event.preventDefault();
        setProfileOpen(false);
        setHelpOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const candidates = focusables();
      if (!candidates.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = candidates[0];
      const last = candidates[candidates.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      opener?.focus();
    };
  }, [helpOpen, profileOpen]);

  function openProfile(event?: { currentTarget?: HTMLElement }) {
    dialogOpenerRef.current = event?.currentTarget || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setProfileError(null);
    setHelpOpen(false);
    setProfileOpen(true);
  }

  function openHelp(event: { currentTarget: HTMLElement }) {
    dialogOpenerRef.current = event.currentTarget;
    setProfileOpen(false);
    setHelpOpen(true);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    try {
      const fields = new FormData(event.currentTarget);
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          displayName: fields.get("displayName"),
          username: fields.get("username"),
          positionTitle: fields.get("positionTitle"),
        }),
      });
      const payload: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(apiMessage(payload, "Your profile could not be updated."));
      await onProfileSaved();
      setProfileOpen(false);
      notify("Your profile was updated.");
    } catch (error) {
      setProfileError(error instanceof Error ? error.message : "Your profile could not be updated.");
    } finally {
      setProfileSaving(false);
    }
  }

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await onSignOut();
    } catch {
      // The parent keeps the session visible and shows the actionable error.
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-top">
          <div className="brand-lockup">
            <BrandLogo size={45} priority />
            <div className="shell-brand-copy">
              <strong>Inventory Auditor</strong>
              <label className="shell-scope-select shell-brand-select" htmlFor="desktop-brand-scope">
                <span className="sr-only">Brand</span>
                <select
                  id="desktop-brand-scope"
                  aria-label="Brand"
                  value={dashboardBrandId}
                  onChange={(event) => onDashboardBrandChange(event.target.value)}
                  disabled={!dashboardBrands.length}
                >
                  {dashboardBrands.length !== 1 ? <option value="all">{allBrandsLabel}</option> : null}
                  {dashboardBrands.map((brand) => (
                    <option value={brand.id} key={brand.id}>{brand.name}</option>
                  ))}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </label>
            </div>
          </div>

          <nav className="main-nav" aria-label="Primary navigation">
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const active = activeView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={active ? "nav-item is-active" : "nav-item"}
                  aria-current={active ? "page" : undefined}
                  onClick={() => onNavigate(item.id)}
                >
                  <Icon size={19} aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}
          </nav>
        </div>

        <div className="sidebar-bottom">
          <button type="button" className="help-card" onClick={openHelp}>
            <span className="help-icon"><CircleHelp size={18} aria-hidden="true" /></span>
            <span>
              <strong>Need a hand?</strong>
              <small>See what to do next</small>
            </span>
          </button>

          <div className="user-menu">
            <button type="button" className="user-profile-button" onClick={openProfile} aria-label="Edit my profile">
              <span className="avatar">{userInitials}</span>
              <span className="user-menu-copy">
                <strong>{currentUser.displayName}</strong>
                <small>{currentUser.positionTitle || roleLabel(currentUser.role)}</small>
              </span>
            </button>
            <button type="button" className="icon-button" aria-label="Sign out" onClick={() => void signOut()} disabled={signingOut}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>

      <header className="mobile-header">
        <div className="brand-lockup compact-brand">
          <BrandLogo size={38} />
          <strong>Inventory Auditor</strong>
        </div>
        <div className="mobile-header-actions">
          <button type="button" className="icon-button" aria-label="Open help" onClick={openHelp}><CircleHelp size={18} /></button>
          <button type="button" className="avatar avatar-button" aria-label="Edit my profile" onClick={openProfile}>{userInitials}</button>
        </div>
      </header>

      <section className="mobile-scope-controls" aria-label="Dashboard brand and location">
        <label htmlFor="mobile-brand-scope">
          <span>Brand</span>
          <span className="shell-scope-select">
            <select id="mobile-brand-scope" value={dashboardBrandId} onChange={(event) => onDashboardBrandChange(event.target.value)} disabled={!dashboardBrands.length}>
              {dashboardBrands.length !== 1 ? <option value="all">{allBrandsLabel}</option> : null}
              {dashboardBrands.map((brand) => <option value={brand.id} key={brand.id}>{brand.name}</option>)}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
        <label htmlFor="mobile-location-scope">
          <span>Location</span>
          <span className="shell-scope-select">
            <select id="mobile-location-scope" value={dashboardLocationId} onChange={(event) => onDashboardLocationChange(event.target.value)} disabled={!dashboardLocations.length}>
              <option value="all">{allLocationsLabel}</option>
              {dashboardLocations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
            </select>
            <ChevronDown size={14} aria-hidden="true" />
          </span>
        </label>
      </section>

      <div className="app-content">
        <header className="topbar">
          <div className="workspace-switcher shell-location-switcher">
            <span className="workspace-initial">{selectedLocationName.trim().charAt(0).toLocaleUpperCase() || "L"}</span>
            <label htmlFor="desktop-location-scope">
              <small>Location</small>
              <span className="shell-scope-select shell-location-select">
                <select id="desktop-location-scope" value={dashboardLocationId} onChange={(event) => onDashboardLocationChange(event.target.value)} disabled={!dashboardLocations.length}>
                  <option value="all">{allLocationsLabel}</option>
                  {dashboardLocations.map((location) => <option value={location.id} key={location.id}>{location.name}</option>)}
                </select>
                <ChevronDown size={14} aria-hidden="true" />
              </span>
            </label>
          </div>

          <div className="topbar-actions">
            <span className="demo-chip">Live workspace</span>
            <button type="button" className="profile-topbar-button" onClick={openProfile}>
              <span className="avatar">{userInitials}</span>
              <span><strong>{currentUser.displayName}</strong><small>My profile</small></span>
            </button>
          </div>
        </header>

        <main className="main-content">{children}</main>
      </div>

      <nav className="mobile-nav" aria-label="Mobile navigation" style={{ gridTemplateColumns: `repeat(${visibleNavItems.length}, minmax(0, 1fr))` }}>
        {visibleNavItems.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className={active ? "is-active" : ""}
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={20} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {profileOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!profileSaving) setProfileOpen(false); }}>
          <form ref={(node) => { dialogRef.current = node; }} className="modal-card profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-modal-title" tabIndex={-1} onSubmit={saveProfile} onMouseDown={(event) => event.stopPropagation()}>
            <div className="drawer-heading">
              <div><span className="eyebrow"><UserRound size={15} /> My profile</span><h2 id="profile-modal-title">Edit your information</h2></div>
              <button type="button" className="icon-button" aria-label="Close profile editor" onClick={() => setProfileOpen(false)} disabled={profileSaving}><X size={18} /></button>
            </div>
            <p className="modal-intro">Update the name and position people see in this workspace. Your role, email, and location access stay protected.</p>
            {profileError ? <div className="form-error" role="alert">{profileError}</div> : null}
            <div className="form-grid-two">
              <label>Full name<input name="displayName" defaultValue={currentUser.displayName} required minLength={1} maxLength={120} data-dialog-initial /></label>
              <label>Username<input name="username" defaultValue={currentUser.username} required minLength={3} maxLength={40} pattern="[a-z0-9][a-z0-9._-]{2,39}" autoCapitalize="none" /></label>
              <label className="full-field">Position or job title<input name="positionTitle" defaultValue={currentUser.positionTitle || ""} maxLength={120} placeholder="e.g. General Manager" /></label>
              <label>Email<input value={currentUser.email} readOnly aria-readonly="true" /></label>
              <label>Workspace role<input value={roleLabel(currentUser.role)} readOnly aria-readonly="true" /></label>
            </div>
            <p className="field-help">To change your sign-in email, role, or assigned locations, contact a workspace administrator.</p>
            <div className="profile-modal-actions"><button type="button" className="button button-ghost profile-sign-out" onClick={() => void signOut()} disabled={profileSaving || signingOut}><LogOut size={16} /> {signingOut ? "Signing out…" : "Sign out"}</button><div className="drawer-actions"><button type="button" className="button button-secondary" onClick={() => setProfileOpen(false)} disabled={profileSaving}>Cancel</button><button type="submit" className="button button-primary" disabled={profileSaving || signingOut}><Save size={16} /> {profileSaving ? "Saving…" : "Save profile"}</button></div></div>
          </form>
        </div>
      ) : null}

      {helpOpen ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setHelpOpen(false)}>
          <section ref={(node) => { dialogRef.current = node; }} className="modal-card help-modal" role="dialog" aria-modal="true" aria-labelledby="help-modal-title" tabIndex={-1} onMouseDown={(event) => event.stopPropagation()}>
            <div className="drawer-heading">
              <div><span className="eyebrow"><CircleHelp size={15} /> Help</span><h2 id="help-modal-title">What should I do?</h2></div>
              <button type="button" className="icon-button" aria-label="Close help" data-dialog-initial onClick={() => setHelpOpen(false)}><X size={18} /></button>
            </div>
            <ol className="help-steps">
              <li><strong>First:</strong> choose a brand in the sidebar and a location in the top bar.</li>
              <li><strong>Next:</strong> select the exact period and review historical sales or a saved forecast.</li>
              <li><strong>After that:</strong> ask your workspace administrator if data, access, or a connection is missing.</li>
            </ol>
            <div className="drawer-actions">
              <button type="button" className="button button-secondary" onClick={() => setHelpOpen(false)}>Close</button>
              {isAdmin ? <button type="button" className="button button-primary" onClick={() => { setHelpOpen(false); onNavigate("configuration"); }}>Open configuration</button> : null}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
