# Technical setup reference

New and nontechnical owners should follow [**Setup** on the repository front page](../README.md#setup). It is the only owner setup guide. This page is a compact reference for developers and support staff.

No paid Supabase project, Railway plan, Resend plan, domain, or AI usage is created by this repository. If Supabase quotes a non-zero price, stop: the Free-project limit applies across organizations where the account is Owner/Admin, so creating another organization does not add quota. Railway and AI usage are not guaranteed to remain at $0.

## Deployment order

1. Keep the GitHub repository private and use only `trunk`.
2. Create a new dedicated Supabase project.
3. Apply these migrations once and in order:
   - `supabase/migrations/20260716210000_inventory_auditor.sql`
   - `supabase/migrations/20260716220000_email_delivery_verification.sql`
   - `supabase/migrations/20260716230000_email_contacts_and_profiles.sql`
   - `supabase/migrations/20260717010000_brand_location_management.sql`
   - `supabase/migrations/20260717203635_guided_history_import.sql`
4. Deploy `trunk` to a Railway staging service using `railway.json`.
5. Add the bootstrap variables below and redeploy.
6. Configure Supabase Auth Site URL, callback redirects, and custom SMTP.
7. Create the first workspace owner.
8. Save and test Resend, GitHub, and AI under Configuration → Keys.
9. Complete [the manual staging acceptance test](MANUAL_ACCEPTANCE_TEST.md).

## Bootstrap environment

These values exist before anyone can sign in and belong in Railway or `.env.local`:

| Variable | Contract |
| --- | --- |
| `APP_URL` | HTTPS deployment origin, or HTTP localhost; no path |
| `APP_SECRET_ENCRYPTION_KEY` | exactly 32 random bytes encoded as standard Base64, or 64 hexadecimal characters |
| `CRON_SECRET` | a separate random value of at least 32 characters |
| `OWNER_SETUP_SECRET` | a third separate random value of at least 32 characters; required to create the first owner |
| `EMAIL_DELIVERY_ENABLED` | `false` until internal email and scheduler acceptance pass |
| `IMPORT_MAX_BYTES` | recommended `5242880` |
| `IMPORT_MAX_ROWS` | recommended `20000` |
| `NEXT_TELEMETRY_DISABLED` | recommended `1` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | current publishable key |
| `SUPABASE_SECRET_KEY` | current server-only secret key |

Generate different application secrets with:

```bash
openssl rand -base64 32
openssl rand -hex 32
openssl rand -hex 32
```

The first output is the encryption key, the second is the cron secret, and the third is the first-owner setup code. Keep all three in an organization password manager. Replacing the encryption key makes existing encrypted provider credentials unreadable, so rotate it only with a plan to re-enter every stored provider secret.

`/api/setup/status` checks the application, Supabase configuration, and migration state. `/api/health` returns `ok` after Supabase bootstrap values are present. Neither endpoint returns credential values.

## Supabase database and Auth

The core migration creates the workspace boundary, brands, locations, location assignments, invitations, historical imports, forecast audit tables, provider metadata and encrypted-secret envelope storage, email schedules/delivery ledgers, row-level security, explicit grants, and scoped RPCs. The second migration makes a successful internal Resend delivery test a prerequisite for enabling a schedule and binds verification to the exact current credential/sender pair. The third adds location-scoped additional recipients, manual-delivery audit fields, a display-only profile position/title, race-safe invitation/contact identity rules, attempt-bound email completion, forecast claim tokens, and exactly one email schedule per workspace. The fourth adds editable brand/location records, per-brand IANA timezone defaults, and the public-read/server-write `brand-logos` bucket. The fifth adds brand-first guided history imports, remembered product/location aliases, and separate inserted, unchanged, and corrected-row outcomes. The third intentionally stops if legacy data already contains multiple schedules for one workspace; resolve that ambiguity before rerunning instead of guessing which schedule to keep.

After applying all five files, these checks should return all names and then 0 rows:

```sql
select
  to_regclass('public.ia_workspaces') as core_schema,
  to_regclass('ia_private.ia_email_delivery_verifications') as email_safety,
  to_regclass('public.ia_email_contacts') as email_contacts,
  to_regclass('public.ia_product_import_aliases') as import_aliases,
  (select id from storage.buckets where id = 'brand-logos') as logo_bucket;

select schemaname, tablename
from pg_tables
where schemaname = 'public'
  and tablename like 'ia_%'
  and not rowsecurity;
```

Use the Railway origin as the Supabase Auth Site URL. Allow the app callback path and its safe query form:

```text
https://YOUR-RAILWAY-DOMAIN/auth/callback
https://YOUR-RAILWAY-DOMAIN/auth/callback**
```

Keep email/password sign-up and email confirmation enabled. First-owner creation requires the server-only `OWNER_SETUP_SECRET` and atomically succeeds only while the workspace is empty; later registrations require a valid one-time invitation. Configure Resend as Supabase custom SMTP before creating the first owner.

## Workspace provider credentials

The default handoff path stores these after sign-in under **Configuration → Keys**:

- domain-restricted Resend Sending access key plus a plain verified sender email
- AI API key plus provider family (`openai`, `anthropic`, `google`, or `responses-compatible`), model, and HTTPS base URL
- fine-grained GitHub token plus repository owner/name and fixed `trunk` branch

The server encrypts saved secrets with AES-256-GCM under `APP_SECRET_ENCRYPTION_KEY`; the database stores only an encrypted envelope, mask, and keyed fingerprint. Browser responses never contain the saved value.

`.env.example` also lists `RESEND_*`, `AI_*`, and `GITHUB_*` as server-only fallback variables. They are useful for recovery or advanced deployment automation, but they are not required when the in-app workspace connections are saved. Stored workspace credentials take precedence.

The Resend connection probe uses a deliberately invalid, non-deliverable `/emails` request: Resend's authenticated validation response proves a Sending access key without queuing mail. **Send test to me** separately proves the verified sender and real delivery.

OpenAI uses the Responses API, Anthropic uses the Messages API, and Google uses Gemini `generateContent`; the app selects the correct authentication, endpoint, search tool, and response parser. Responses-compatible services must expose `GET /models` and `POST /responses`. The exact model must perform live search and return source URLs. **Test capabilities** makes one small live provider request and can consume credits; it verifies live search and JSON that passes the app's server-side validator. One single-location cited forecast remains the final real-data check.

For the first test, choose a lower-cost model that the provider currently documents as supporting live web search. Inventory Auditor requests low reasoning effort for native OpenAI forecasts and gives live research up to five minutes to finish. Select only one location for the first forecast so cost, latency, and any provider error remain easy to evaluate.

The GitHub token should be restricted to the one repository with Contents read/write only. Analysis Skill updates use compare-and-swap against the expected GitHub blob SHA, write root `ANALYSIS_SKILL.md` on `trunk`, read the result back, and store its policy version/checksum in Supabase.

## Historical imports

The server accepts one `.xlsx` or `.csv` file with one populated, visible worksheet and these columns in order. Extra completely blank worksheets are ignored:

```text
date, product, location, quantity
```

It validates the complete file before an atomic RPC write. Timestamps, future dates relative to each location's timezone, formulas, unknown or unauthorized locations, ambiguous names, negative/fractional quantities, duplicate rows, extra columns, oversized files, and unsupported formats fail closed. Reimporting the exact file cannot silently duplicate quantities. See [DATA_IMPORT.md](DATA_IMPORT.md).

## Forecast execution

Manual runs use `POST /api/forecasts/run` after server-side workspace, role, and assignment checks. Each run:

1. loads and validates the current GitHub-backed Analysis Skill and requires it to match the explicitly reviewed active revision;
2. fetches only authorized location/product/history rows;
3. calculates the host historical baseline;
4. invokes the selected provider's native adapter with live web search;
5. validates location IDs, product IDs, whole-number quantities, active variable IDs, and HTTPS evidence URLs;
6. stores the normalized run, items, sources, policy version, and checksum atomically against the current per-attempt claim token.

If the provider or live research is unavailable, the result fails clearly or follows the explicit baseline-only fallback in `ANALYSIS_SKILL.md`; it is never relabeled as a completed multivariate forecast.

## Email and scheduled job

`POST /api/email/test` is available only to a workspace super admin/admin. It accepts one recipient user ID, verifies the GitHub policy still matches the explicitly reviewed active revision, reloads that recipient's active email preference and assignments, requires a current deliverable stored forecast for every assigned location, sends one combined message, then records verification for the exact Resend credential/sender pair.

`POST /api/jobs/forecast` requires both:

```text
Authorization: Bearer <CRON_SECRET>
EMAIL_DELIVERY_ENABLED=true
```

The recommended scheduler interval is every 15 minutes. The route evaluates the workspace's single saved IANA-timezone schedule in a bounded 60-minute due window, generates missing exact-period forecasts, rechecks recipient eligibility and assignments immediately before sending, and uses a database unique key plus the same Resend idempotency key. Failed deliveries can retry at most three times with a 15-minute minimum interval, and only the delivery's current attempt can record its final result. Dashboard manual sends use a separate database-enforced rolling five-minute duplicate window for the same recipient and exact run set.

[Automatic email](../README.md#automatic-email) on the repository front page contains the exact Supabase Cron + pg_net + Vault setup. Never put `CRON_SECRET` in the job URL or plain Cron command.

Global email stop order:

1. set Railway `EMAIL_DELIVERY_ENABLED=false` and redeploy;
2. disable the in-app schedule;
3. deactivate the Supabase Cron job;
4. revoke the Resend key if exposure is suspected.

## Local verification

Requirements: Node.js 22.13 or newer and pnpm.

```bash
pnpm install
cp .env.example .env.local
pnpm dev
```

Use `APP_URL=http://localhost:3000` and add `http://localhost:3000/auth/callback**` to the staging Supabase redirect list. Never commit `.env.local`.

Before handoff, run:

```bash
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Then run [the manual acceptance test](MANUAL_ACCEPTANCE_TEST.md) on the Railway staging URL with invented data and internal recipients.
