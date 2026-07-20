---
name: inventory-auditor-maintainer
description: Safely maintain the Inventory Auditor repository, including UI, imports, authentication, location-scoped access, Supabase, Resend, Railway, provider configuration, forecasting, and ANALYSIS_SKILL.md multivariate variables. Use when an agent must inspect, change, test, or explain this app, especially when editing forecast variables or preparing a handoff without exposing secrets or weakening tenant isolation.
---

# Inventory Auditor Maintainer

Maintain the app as a portable, white-label product. Preserve its access boundaries, provider portability, auditability, and single-branch workflow.

## Start every task

1. Read the user request and inspect the current tree, branch, status, remotes, and applicable repository instructions.
2. Work only on `trunk`. Fetch the remote and compare it before editing and again before pushing. Never force-push, create `main` or `dev`, or overwrite unrelated work.
3. Identify which invariants apply. Read [security-invariants.md](references/security-invariants.md) for auth, database, secrets, email, uploads, jobs, or external integrations.
4. Read [repository-map.md](references/repository-map.md) when locating an unfamiliar feature or changing architecture/provider boundaries.
5. Keep the change scoped. Preserve user changes and avoid destructive Git operations.

## Distinguish the two instruction files

- Root `ANALYSIS_SKILL.md` is versioned runtime policy read by the forecasting engine on every run. It governs data validation, research, calculations, evidence, and output.
- This `skills/inventory-auditor-maintainer/SKILL.md` is an agent-maintenance skill. It governs how an AI coding agent safely edits the repository.

Never merge their content or rename one to the other. Read [analysis-policy-contract.md](references/analysis-policy-contract.md) before changing forecasting logic, AI prompts, output schemas, or the root analysis policy.

## Make application changes

1. Trace the complete path affected: user action, server boundary, authorization, storage, scheduled job or provider call, and visible result.
2. Keep vendor-specific behavior behind configuration or adapters. Do not hard-code account IDs, project URLs, domains, repository coordinates, models, or credentials.
3. Preserve the invisible workspace tenant boundary: brands belong to one workspace, locations belong to one brand and workspace, and users see or receive data only for assigned locations.
4. Enforce access on the server and in database policies. UI filtering is never authorization.
5. Treat keys as write-only secrets: encrypt at rest, mask after save, never return them to the browser, logs, tests, commits, or AI research.
6. Update setup guidance and `.env.example` when configuration requirements change, using placeholders only.
7. Add or update focused tests for access, input validation, failure handling, and user-visible behavior.

## Edit multivariate variables

1. Read the entire root `ANALYSIS_SKILL.md`, including metadata, core rules, active-variable markers, output contract, and change control.
2. Edit external research variables only inside the block between `ACTIVE_VARIABLES_START` and `ACTIVE_VARIABLES_END`. Change core policy only when the requested behavior requires it.
3. Define each variable with a precise trigger, location/product scope, evidence requirement, expected effect, fallback, and confidence rule. Require historical support for non-zero demand adjustments.
4. Do not add instructions that bypass live research, citations, prompt-injection defenses, access controls, or conservative fallbacks.
5. Keep every stable variable ID unique, lowercase, and unchanged across display-name refinements so historical runs remain interpretable.
6. Increment the active-variable revision for variable-set changes. Update the policy semantic version and `Last updated` date as directed by the root change-control section.
7. Confirm the structured output remains valid, every adjustment uses an active `variable_id`, and every adjustment can cite direct source URLs.
8. Run policy/forecast contract tests and inspect the final diff. Report the policy version change explicitly.

## Verify and hand off

- Run the smallest relevant checks first, then the full available lint, test, typecheck, and build suite in proportion to risk.
- For UI changes, verify desktop and narrow layouts plus login, dashboard, and configuration paths.
- For imports, test valid rows and rejection of timestamps, unknown locations, negative quantities, and malformed dates.
- For auth, database, email, uploads, scheduled jobs, and provider integrations, test failure and cross-location denial paths.
- Inspect the final diff for secrets, unrelated files, generated clutter, and accidental policy weakening.
- Before any authorized push, fetch and reconcile `trunk` without discarding others' work; push normally.
- Report what changed, checks run, remaining limitations, and the client path: what happens first, what they must do, what happens next, and where to get help.
