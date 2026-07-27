# Architecture

Inventory Auditor is a standard Next.js application deployed from a private GitHub repository to Railway. The design keeps every outside service behind replaceable configuration so the app can move to accounts owned by a new organization without code changes.

## System flow

```text
Browser
  → Railway / Next.js server
      → Supabase: authentication, workspace data, imports, schedules, audit history
      → AI provider: live external-variable research only
      → Resend: one combined forecast email per recipient and cadence
      → GitHub: versioned ANALYSIS_SKILL.md reads and approved updates
```

## Ownership boundaries

| Area | Source of truth | Replace by changing |
| --- | --- | --- |
| Application code | Private GitHub repository, `trunk` | Repository remote |
| App hosting | Railway | Deployment connection and variables |
| Users and business data | Supabase | Project URL and keys, then migrate data |
| Outbound email | Resend | API key and verified sender |
| Forecast reasoning | Interchangeable AI provider | Provider, model, base URL, and API key |
| Forecast rules | Root `ANALYSIS_SKILL.md` | File content through audited GitHub sync |

## Access model

Each cloned deployment bootstraps one owner-controlled workspace. `workspace_id` remains the invisible tenant boundary on every brand, location, product, historical record, forecast, schedule, user profile, and secret so scope is explicit on browser, server, and background paths.

A user must be assigned to at least one location to see its data or receive its forecast. Users assigned to two locations see only those two. Administrators can manage the workspace, but row-level policies still enforce workspace and location boundaries. Only the email-confirmed user carrying a short-lived authorization minted after the server verifies `OWNER_SETUP_SECRET` can create the first workspace and become super admin; all later users join by invitation.

## Forecast flow

1. Read the current, complete `ANALYSIS_SKILL.md` and require it to match the explicitly reviewed active revision before any analysis or email.
2. Load historical quantities only for the requested workspace, brand, locations, products, and period.
3. Calculate the baseline, comparisons, trend, seasonality profiles, coverage, volatility, outliers, and a small representative series on the server. Checksum this compact evidence; do not send the raw historical table to the AI.
4. Ask the configured AI provider to research exactly the active variables declared by the skill and return one sourced assessment for every location × product × active variable. The AI does not calculate baselines or final quantities.
5. Reject incomplete, out-of-scope, uncited, or over-limit research. Web content is untrusted research material, never app instructions.
6. Apply validated percentages, deterministic caps, and whole-unit rounding on the server, then validate the complete product-level forecast again.
7. Store the result, input audit, evidence checksum, skill version, provider/model, evidence links, and run status for review.
8. Build one combined email containing only the recipient's assigned locations.

If the provider cannot perform live web research with citations, the app returns the policy's transparent historical-baseline fallback or a clear failure. Historical views remain available, and an unresearched result is never labeled as a completed multivariate forecast.

## Time and email rules

- Historical imports store a local calendar `date`, not a timestamp.
- Every location stores an IANA timezone such as `America/Toronto`.
- The default forecast email time is 5:00 a.m. using the earliest applicable assigned-location timezone; an administrator can change the schedule.
- A recipient with multiple locations receives one combined email, not one email per location.

## Provider ports

Backend code uses small internal interfaces instead of spreading provider-specific behavior throughout the app:

- `DatabaseProvider` for workspace records and authorization-aware queries
- `EmailProvider` for sends and delivery results
- `ForecastProvider` for web-capable, cited variable research; server modules own historical evidence and final arithmetic
- `SkillRepository` for reading and compare-before-write updates to the analysis file
- `SecretStore` for encrypted, masked connection settings

This keeps account handoff and provider replacement localized to configuration and one adapter.

## Current implementation status

The repository includes the Next.js interface and server routes, Supabase migrations and row-level policies, encrypted workspace provider credentials, validated imports, GitHub Analysis Skill synchronization, cited forecast execution, Resend delivery, and the protected scheduled job. A deployment remains in setup mode until its owner manually supplies the bootstrap values, applies all committed database migrations in order, creates the first workspace account, and connects the replaceable providers. Production use still requires the repository's staging acceptance test with invented data and internal email.
