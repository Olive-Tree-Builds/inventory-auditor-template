# Analysis policy contract

Use this reference for any change to forecasting, AI calls, analysis prompts, research, or root `ANALYSIS_SKILL.md`.

## Required run sequence

1. Authorize the workspace and requested locations.
2. Read the complete root policy from the authoritative repository revision.
3. Record its version and host-computed checksum.
4. Validate date-only historical inputs and requested scope.
5. Calculate and retain the historical baseline and compact checksummed evidence on the host.
6. Send the AI only the authorized location/product scope, active variables, and compact evidence—never the raw history table.
7. Ask a compatible AI provider to perform live research for the approved location and dates and return research assessments only.
8. Reject incomplete, out-of-scope, uncited, or over-limit research; apply validated adjustments and final arithmetic on the host.
9. Validate the host-assembled forecast against the storage schema.
10. Store recommendations, direct source URLs, warnings, provider/model metadata, and audit identifiers.
11. Scope dashboard display and combined email output to each user's active location assignments.

Do not let an AI response authorize itself, choose a broader scope, read secrets, or bypass server validation.

## Safe active-variable design

A useful active variable answers all of these:

- What observable condition triggers it?
- Which brands, locations, products, and dates can it affect?
- Which current public evidence is required?
- Which historical comparison supports a non-zero adjustment?
- How are direction, magnitude, and confidence decided?
- What happens when evidence is absent, stale, or contradictory?

Example pattern:

```markdown
- Name: `University move-in weekend`
  - ID: `university-move-in`
  - Applies when: An assigned location is within the configured university trade area and an official move-in date overlaps the forecast period.
  - Evidence required: Official university housing calendar plus comparable historical dates for the location.
  - Expected effect: Derive direction and magnitude from comparable history.
  - Products affected: Only products with a demonstrated location-level relationship.
  - Fallback: Use zero adjustment and low confidence when current evidence or comparable history is unavailable.
  - Notes: Do not generalize one campus's dates to another location.
```

Avoid vague rules such as “events increase demand by 20%.” They lack location scope, historical evidence, and a conservative fallback.

## Policy edit procedure

- Preserve `ACTIVE_VARIABLES_START` and `ACTIVE_VARIABLES_END` exactly.
- Give every active variable a stable, unique ID and preserve that ID when only its display name changes.
- Increment `Active-variable revision` for any active-block edit.
- Apply semantic versioning from the policy change-control section and update `Last updated`.
- Keep output changes backward compatible unless the user explicitly authorizes a breaking version.
- Review for prompt injection, invented data, duplicate effects, source quality, and direct URL coverage.
- Ensure the UI/editor derives its checklist from the active block and the stored audit record identifies the new version.
- Test an evidence-rich case, a no-evidence case, unavailable web research, malformed AI output, and insufficient history.

## Failure behavior

- Missing/unreadable policy: stop with `policy_unavailable`.
- No web-capable provider: store the host baseline with an explicit warning; do not claim multivariate completion.
- Weak or conflicting evidence: zero adjustment, reduced confidence, warning.
- Malformed or unsupported AI output: reject it; never email an unvalidated recommendation.
- Access mismatch: deny before any research or analysis and do not reveal whether unauthorized data exists.
