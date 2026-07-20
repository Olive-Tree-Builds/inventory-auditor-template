"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "./AppShell";
import { AuthScreen } from "./AuthScreen";
import { ConfigurationScreen } from "./ConfigurationScreen";
import { DashboardScreen } from "./DashboardScreen";
import { BrandLogo } from "./BrandLogo";
import { SetupRequiredScreen, type SetupServiceId } from "./SetupRequiredScreen";
import type { AppBootstrapData } from "../lib/app-data";

export type AppView = "dashboard" | "configuration";

export function InventoryAuditorApp() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isCheckingSetup, setIsCheckingSetup] = useState(true);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupStatus, setSetupStatus] = useState<{
    services: Partial<Record<SetupServiceId, boolean>>;
    readyForSignIn: boolean;
    workspaceInitialized: boolean;
  } | null>(null);
  const [activeView, setActiveView] = useState<AppView>("dashboard");
  const [toast, setToast] = useState<string | null>(null);
  const [activeAnalysisSkill, setActiveAnalysisSkill] = useState("");
  const [analysisSkillDraft, setAnalysisSkillDraft] = useState("");
  const [appData, setAppData] = useState<AppBootstrapData | null>(null);
  const [appDataError, setAppDataError] = useState<string | null>(null);
  const [isLoadingApp, setIsLoadingApp] = useState(false);
  const [dashboardBrandId, setDashboardBrandId] = useState("all");
  const [dashboardLocationId, setDashboardLocationId] = useState("all");
  const [dashboardHistoryProductId, setDashboardHistoryProductId] = useState("all");

  const checkSetup = useCallback(async () => {
    setIsCheckingSetup(true);
    setSetupError(null);
    try {
      const response = await fetch("/api/setup/status", { cache: "no-store" });
      const result = await response.json() as {
        ok: boolean;
        data?: {
          services: Partial<Record<SetupServiceId, boolean>>;
          readyForSignIn: boolean;
          workspaceInitialized: boolean;
        };
        error?: { message?: string };
      };
      if (!response.ok || !result.ok || !result.data) throw new Error(result.error?.message || "The setup check failed.");
      setSetupStatus(result.data);

      if (result.data.readyForSignIn) {
        const sessionResponse = await fetch("/api/auth/me", { cache: "no-store" });
        const sessionResult = await sessionResponse.json() as { ok: boolean; data?: { authenticated?: boolean } };
        setIsAuthenticated(Boolean(sessionResult.ok && sessionResult.data?.authenticated));
      } else {
        setIsAuthenticated(false);
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : "The setup check failed.");
    } finally {
      setIsCheckingSetup(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkSetup(), 0);
    return () => window.clearTimeout(timer);
  }, [checkSetup]);

  const loadAppData = useCallback(async () => {
    setIsLoadingApp(true);
    setAppDataError(null);
    try {
      const response = await fetch("/api/app", { cache: "no-store" });
      const result = await response.json() as { ok: boolean; data?: AppBootstrapData; error?: { message?: string } };
      if (!response.ok || !result.ok || !result.data) throw new Error(result.error?.message || "Workspace data could not be loaded.");
      setAppData(result.data);
    } catch (error) {
      setAppData(null);
      setActiveView("dashboard");
      setActiveAnalysisSkill("");
      setAnalysisSkillDraft("");
      setDashboardBrandId("all");
      setDashboardLocationId("all");
      setDashboardHistoryProductId("all");
      setAppDataError(error instanceof Error ? error.message : "Workspace data could not be loaded.");
    } finally {
      setIsLoadingApp(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (isAuthenticated) void loadAppData();
      else setAppData(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, loadAppData]);

  useEffect(() => {
    if (!appData) return;
    const isAdmin = appData.currentUser.role === "super_admin" || appData.currentUser.role === "admin";
    const persisted = appData.analysisSkill?.markdown || "";
    if (isAdmin && (!persisted || persisted === activeAnalysisSkill)) return;
    const timer = window.setTimeout(() => {
      if (!isAdmin) {
        setActiveView("dashboard");
        setActiveAnalysisSkill("");
        setAnalysisSkillDraft("");
      } else {
        setActiveAnalysisSkill(persisted);
        setAnalysisSkillDraft(persisted);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeAnalysisSkill, appData]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (isCheckingSetup && !setupStatus) {
    return (
      <main className="loading-screen" aria-busy="true">
        <BrandLogo size={52} priority />
        <strong>Checking setup…</strong>
      </main>
    );
  }

  if (!setupStatus?.readyForSignIn) {
    return (
      <SetupRequiredScreen
        configuredServices={setupStatus?.services || {}}
        onRetry={checkSetup}
        error={setupError}
      />
    );
  }

  if (!isAuthenticated) {
    return (
      <AuthScreen
        registrationOpen={!setupStatus.workspaceInitialized}
        onContinue={() => setIsAuthenticated(true)}
      />
    );
  }

  if (isLoadingApp && !appData) {
    return <main className="loading-screen" aria-busy="true"><BrandLogo size={52} priority /><strong>Loading your workspace…</strong></main>;
  }

  if (!appData) {
    return (
      <main className="loading-screen">
        <BrandLogo size={52} priority />
        <strong>{appDataError || "Workspace data is unavailable."}</strong>
        <button type="button" className="button button-primary" onClick={() => void loadAppData()}>Try again</button>
      </main>
    );
  }

  const isAdmin = appData.currentUser.role === "super_admin" || appData.currentUser.role === "admin";
  const safeActiveView: AppView = isAdmin ? activeView : "dashboard";
  const assignedLocationIds = new Set(appData.assignedLocationIds);
  const dashboardBrands = appData.brands
    .filter((brand) => brand.active)
    .map((brand) => ({ ...brand, locations: brand.locations.filter((location) => location.active && assignedLocationIds.has(location.id)) }))
    .filter((brand) => brand.locations.length > 0);
  const effectiveDashboardBrandId = dashboardBrandId === "all" && dashboardBrands.length === 1
    ? dashboardBrands[0].id
    : dashboardBrandId === "all" || dashboardBrands.some((brand) => brand.id === dashboardBrandId)
      ? dashboardBrandId
      : "all";
  const dashboardLocations = effectiveDashboardBrandId === "all"
    ? dashboardBrands.flatMap((brand) => brand.locations)
    : dashboardBrands.find((brand) => brand.id === effectiveDashboardBrandId)?.locations ?? [];
  const effectiveDashboardLocationId = dashboardLocationId === "all" || dashboardLocations.some((location) => location.id === dashboardLocationId)
    ? dashboardLocationId
    : "all";

  return (
    <AppShell
      activeView={safeActiveView}
      onNavigate={setActiveView}
      onProfileSaved={loadAppData}
      notify={setToast}
      onSignOut={async () => {
        try {
          const response = await fetch("/api/auth/sign-out", { method: "POST" });
          if (!response.ok) throw new Error("Sign out failed.");
          setDashboardBrandId("all");
          setDashboardLocationId("all");
          setDashboardHistoryProductId("all");
          setIsAuthenticated(false);
        } catch {
          setToast("You are still signed in. Check your connection and try again.");
          throw new Error("Sign out failed.");
        }
      }}
      currentUser={appData.currentUser}
      dashboardBrands={dashboardBrands}
      dashboardBrandId={effectiveDashboardBrandId}
      dashboardLocationId={effectiveDashboardLocationId}
      onDashboardBrandChange={(brandId) => { setDashboardBrandId(brandId); setDashboardLocationId("all"); setDashboardHistoryProductId("all"); }}
      onDashboardLocationChange={(locationId) => { setDashboardLocationId(locationId); setDashboardHistoryProductId("all"); }}
    >
      {safeActiveView === "dashboard" ? (
        <DashboardScreen
          notify={setToast}
          appData={appData}
          onDataChanged={loadAppData}
          brandId={effectiveDashboardBrandId}
          locationId={effectiveDashboardLocationId}
          historyProductId={dashboardHistoryProductId}
          onHistoryProductChange={setDashboardHistoryProductId}
        />
      ) : (
        <ConfigurationScreen
          notify={setToast}
          activeAnalysisSkill={activeAnalysisSkill}
          analysisSkillDraft={analysisSkillDraft}
          onAnalysisSkillDraftChange={setAnalysisSkillDraft}
          onActivateAnalysisSkill={setActiveAnalysisSkill}
          appData={appData}
          onDataChanged={loadAppData}
        />
      )}
      {toast ? (
        <div className="toast" role="status" aria-live="polite">
          <span className="toast-dot" aria-hidden="true" />
          {toast}
        </div>
      ) : null}
    </AppShell>
  );
}
