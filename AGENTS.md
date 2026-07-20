# Inventory Auditor agent instructions

Read `skills/inventory-auditor-maintainer/SKILL.md` before changing this repository. Follow its linked security and analysis-policy references whenever they apply.

## Repository rules

- This repository intentionally has one shared branch: `trunk`. Do not create `main` or `dev`, rewrite shared history, or force-push.
- Pull or fetch `trunk` before editing and again before pushing. Preserve unrelated work.
- Keep the app portable. Account IDs, URLs, domains, model names, and secrets belong in configuration, never in source.
- Never commit credentials or customer sales data. Treat saved keys as write-only, encrypted server secrets.
- Preserve the invisible workspace boundary and location-based access rules. UI filtering is not authorization.
- Root `ANALYSIS_SKILL.md` is the runtime forecasting policy. The maintainer skill is for agents editing the repository; do not combine or rename them.
- Run relevant lint, tests, build, and browser checks. Report what changed and anything that remains unverified.

## Current phase

The repository contains the setup-ready application, database migrations, validated imports, forecasting, GitHub policy sync, Resend delivery, scheduled jobs, and manual handoff materials. Preserve the setup-required state when bootstrap credentials or migrations are absent; never substitute demo data or simulated success for a missing service.
