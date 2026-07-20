# Repository map

Inspect the live tree before relying on this map; move or add landmarks here when architecture changes.

## Current landmarks

- `app/`: Next.js application routes, authenticated UI components, styles, and server integration code.
- `app/components/AuthScreen.tsx`: login and first-workspace bootstrap experience.
- `app/components/DashboardScreen.tsx`: historical and multivariate dashboard UI.
- `app/components/ConfigurationScreen.tsx`: configuration tabs and handoff setup experience.
- `app/components/InventoryAuditorApp.tsx`: top-level client application state and navigation.
- `app/lib/app-data.ts`: typed bootstrap payload for authorized workspace data; no fallback sample business data is allowed.
- `ANALYSIS_SKILL.md`: runtime forecasting policy, versioned with the app and read on every analysis run.
- `skills/inventory-auditor-maintainer/`: agent instructions for safely changing this repository.
- `public/inventory-history-template.xlsx`: downloadable historical import template when present.
- `.env.example`: portable configuration names and placeholders; never add real values.
- `docs/`: beginner setup, manual acceptance, architecture, security, import, and handoff documentation.

## Architectural boundaries to preserve

- UI: presents authorized data and configuration but does not enforce authorization by itself.
- Application/server: authenticates, authorizes, validates imports, scopes jobs, and calls provider adapters.
- Supabase: stores tenant data with row-level security and server-side ownership checks.
- Secret storage: encrypts provider credentials and exposes only status and masked hints.
- Forecasting: loads the root analysis policy, validates scope, calculates a baseline, invokes a web-capable AI provider, validates structured output, and stores an audit trail.
- Providers: Supabase, Resend, Railway, GitHub, and AI accounts are configured through replaceable environment values or adapters.

## Core data relationships

Treat `workspace` as the internal tenant boundary even when the UI emphasizes only brands and locations.

```text
workspace
  -> brands
      -> locations
          -> historical sales
          -> forecasts
  -> memberships
      -> user-location assignments
  -> invitations
  -> email schedules
  -> encrypted provider connections
  -> analysis-policy revisions and run audits
```

Every business row must belong to a workspace. Every location-scoped read, email, import, and forecast must intersect the requesting user's active assignments unless the authorized role is explicitly allowed to administer the workspace.

## Provider portability

- Keep public and server-only credentials distinct.
- Read connection values at runtime; do not bake them into source or client bundles.
- Keep AI provider/model/base URL configurable, but require the selected model to support live web research and citations for multivariate mode.
- Treat GitHub-backed policy editing as compare-and-swap: read current revision, update `trunk`, verify the resulting file/checksum, and retain an audit record.
- Fail safely when a provider is missing or incompatible; explain the setup action without exposing credentials.
