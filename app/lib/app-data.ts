import type { WorkspaceRole } from "./api/auth";

export type AppLocation = {
  id: string;
  updatedAt: string;
  brandId: string;
  name: string;
  code: string;
  addressLine1: string;
  city: string;
  region: string;
  countryCode: string;
  postalCode: string;
  timezone: string;
  researchArea: string;
  active: boolean;
};

export type AppBrand = {
  id: string;
  updatedAt: string;
  name: string;
  code: string;
  active: boolean;
  defaultTimeZone: string;
  logoUrl: string | null;
  locations: AppLocation[];
};

export type AppUser = {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  username: string;
  positionTitle: string;
  role: WorkspaceRole;
  status: string;
  emailEnabled: boolean;
  locationIds: string[];
};

export type AppEmailRecipient = {
  id: string;
  scheduleId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  locationIds: string[];
};

export type ProviderConnectionSummary = {
  provider: string;
  status: string;
  maskedHint: string | null;
  lastTestedAt: string | null;
  lastTestResult: "passed" | "failed" | null;
  lastErrorCode: string | null;
  configuration: Record<string, unknown>;
};

export type EmailSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  cadence: string;
  weekdayMask: number;
  localSendTime: string;
  timezoneRule: string;
  workspaceTimeZone: string;
  forecastHorizon: string;
};

export type AppBootstrapData = {
  workspace: { id: string; name: string; slug: string; defaultTimeZone: string };
  emailDeliveryReady: boolean;
  currentUser: AppUser;
  brands: AppBrand[];
  users: AppUser[];
  assignedLocationIds: string[];
  providerConnections: ProviderConnectionSummary[];
  emailSchedule: EmailSchedule | null;
  emailRecipients: AppEmailRecipient[];
  analysisSkill: {
    markdown: string | null;
    policyVersion: string;
    activeVariableRevision: number;
    variables: Array<{ id: string; name: string }>;
    sha256: string;
  } | null;
  latestImport: {
    filename: string;
    rowCount: number;
    dateFrom: string | null;
    dateTo: string | null;
    committedAt: string | null;
  } | null;
};
