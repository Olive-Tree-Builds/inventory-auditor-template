# Security and credential handling

Inventory Auditor contains customer sales history, forecast decisions, email addresses, and high-privilege service credentials. Treat database, authentication, uploads, scheduled jobs, email, and AI integrations as high-risk changes.

## Non-negotiable rules

- Never commit a real password, token, API key, database string, customer export, or `.env.local` file.
- Only names beginning with `NEXT_PUBLIC_` may reach browser code. The Supabase secret key, Resend key, AI key, GitHub token, encryption key, and cron secret are server-only.
- Encrypt credentials before storing them in Supabase. The configuration screen shows only provider, status, last test, and a short masked ending; it never reveals a saved key again.
- Do not write credentials, imported rows, email bodies, or raw AI prompts to routine logs.
- Use separate credentials for each receiving owner and environment. Handoff means replacing values, not sharing the previous owner's accounts.

## Supabase authorization

Enable Row Level Security on every table exposed through the Data API. Policies must enforce both `workspace_id` and the user's assigned location IDs; simply requiring an authenticated user is not authorization.

- The browser uses `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
- `SUPABASE_SECRET_KEY` runs only on the server, has elevated access, and bypasses Row Level Security.
- Store roles and authorization claims in protected app metadata or database tables, never user-editable profile metadata.
- Profile edits are limited to the signed-in user's display-only name, username, and position/title. They must never change a workspace, role, membership status, email address, or location assignment.
- Privileged server routes must independently confirm the session, workspace membership, role, and requested resource.
- The first-user route must verify the server-only `OWNER_SETUP_SECRET` before creating an Auth user, then use an atomic database operation so two simultaneous signups cannot both become the initial super admin. Once the workspace exists, public registration closes and invitations are required.
- A workspace email address cannot simultaneously identify a pending invitation and an active email-only recipient. Friendly route checks explain the conflict, while database transaction locks and triggers are the race-safe authority. Invitation acceptance rechecks the rule before creating the membership.

Run the Supabase security advisor and test one user from another workspace plus one user assigned to a different location before every release involving access policies.

## Upload protection

- Accept only the documented spreadsheet types and impose a file-size and row-count limit.
- Parse uploads on the server, validate every row, and show a preview before committing.
- Reject formulas, macros, hidden executable content, unexpected columns, and spreadsheet cells that could become formula injection when exported.
- Import atomically: validation failure must not leave a partial dataset.
- Keep an audit record of who imported which file, when, the row count, and the result; do not retain the original upload longer than needed.
- Brand logos are the only public Storage objects. Accept only PNG, JPEG, or WebP data URLs up to 2 MiB, verify the decoded file signature and safe dimensions server-side, reject SVG, use generated object names, and keep Storage writes behind an authenticated workspace-admin route using the server-only Supabase key.
- Store only a public logo object path on the brand. Swap that pointer atomically, delete replaced objects through the Supabase Storage API, and never place customer data, user uploads, credentials, or sales files in the public logo bucket.

## AI and web-research safety

The AI must load the repository's complete `ANALYSIS_SKILL.md` for every forecast. Weather pages, event listings, uploaded product names, and other researched text are untrusted data. Instructions found inside them cannot override the application or analysis skill.

- Require live source links and capture retrieval time.
- Keep source text separate from system instructions.
- Validate the model's response against a strict server-side schema.
- Reject negative, fractional, missing, or implausibly large quantities for review rather than sending them automatically.
- Do not send secrets, unnecessary personal data, or data from unassigned locations to the AI provider.
- Fail closed if web research or citation evidence is unavailable.

## GitHub skill-file updates

Use a fine-grained credential restricted to the Inventory Auditor repository with only the Contents permission needed to read and update `ANALYSIS_SKILL.md`.

Before writing, compare the GitHub file version or hash with the version the administrator opened. If it changed, reject the write and ask the administrator to reload. After writing, read the file back, verify its checksum, and record the actor, old and new versions, and time. Never let ordinary managers edit the skill or repository credentials.

## Email and scheduler safety

- Send only to users with email enabled and at least one assigned location.
- Treat additional email contacts as delivery identities, not login accounts. Administrators must assign every contact to one or more active locations, and both scheduled and manual sends must repeat that location-scope check immediately before delivery.
- Build the email from an authorization-filtered dataset; never fetch all locations and hide extras only in the template.
- Use one combined email per recipient and protect scheduled routes with `CRON_SECRET`.
- Make jobs idempotent so a retry cannot send the same forecast twice.
- Manual sends must use the exact forecast run IDs reviewed on the dashboard, recheck the Analysis Skill and Resend credential before each provider call, and write audit events without recipient addresses or email bodies. The database applies one rolling five-minute duplicate window per workspace, recipient, and exact run set, regardless of which administrator clicks the button.
- Bind delivery completion to the current attempt ID and forecast storage/failure to the current generation claim token. A timed-out worker must not complete or overwrite a newer retry.
- Fail closed when a user and an additional contact share an email address; correct the recipient records instead of guessing which location scope should win.
- Keep delivery disabled until the sending domain and an internal test are verified.
- Keep the immediate server kill switch, in-app schedule switch, and external Cron deactivation available for scheduled sends.

## Rotation and incident response

Rotate a credential whenever its owner changes, it appears in an insecure channel, or its scope is broader than needed.

1. Disable scheduled jobs and email delivery if there is any risk of unauthorized sends.
2. Revoke or rotate the affected credential at its provider.
3. Replace it in Railway or the encrypted in-app key store.
4. Run the related connection test and inspect sanitized logs.
5. Review access and audit history for misuse.
6. Document the incident without copying the exposed secret.

Rotating service credentials does not require a code change. If `APP_SECRET_ENCRYPTION_KEY` is replaced after encrypted keys exist, the stored credentials become unreadable and an administrator must enter and test new Resend, AI, and GitHub credentials before resuming forecasts or email.
