# Inventory Auditor

Inventory Auditor shows historical product sales by brand and location, creates AI-assisted production forecasts, and can email each manager one combined recommendation for only their assigned locations.

## Choose how you want to set it up

- **Set it up yourself:** follow [Setup](#setup) from top to bottom. It assumes no technical experience.
- **Have an AI agent guide and operate the setup:** go to [AI-guided setup](#ai-guided-setup), connect an action-capable agent such as Codex, and paste the complete prompt provided there.

Both paths create the same owner-controlled app. The AI path still pauses when a person must sign in, complete MFA, approve a permission or cost, manage a secret, or authorize real email.

## Setup

This is the complete owner setup guide for doing it manually. You do not need to download the code, use Terminal, or open another instruction document. Complete the basic setup first; forecasting and email are optional sections farther down this same page.

### Before you begin

You need:

- an email address owned by your business;
- a password manager;
- new GitHub, Supabase, and Railway accounts;
- an internal email address for testing; and
- only if you want email, access to a domain your business owns.

> **Stop before any charge.** Inventory Auditor has no fee of its own, but GitHub, Supabase, Railway, Resend, and the AI provider control their pricing. Continue only with a plan or trial your business has approved. If a screen requests a card, upgrade, paid overage, or any amount above $0, stop and get approval. A continuously running Railway app and live AI research are not guaranteed to remain free.

Keep every password, key, token, and generated security value in the password manager. Never put one in GitHub, a screenshot, chat, or email.

## Part 1 — Get the basic app working

The basic app includes sign-in, brands, locations, historical-data upload, and the historical dashboard. Resend and AI are not required yet.

### 1. Make your private GitHub copy

1. Sign in to GitHub and return to this repository.
2. Above the file list, select **Use this template → Create a new repository**.
3. Choose your own GitHub account or organization as **Owner**.
4. Name the repository `inventory-auditor`.
5. Select **Private** and leave **Include all branches** off.
6. Select **Create repository**.

You are finished with this step when the new repository address begins with your username or organization and its branch selector says `trunk`. Do not use **Download ZIP**, create `main` or `dev`, or continue working in the original shared repository.

### 2. Create the Supabase database

1. Open [Supabase](https://supabase.com/dashboard), create an account, and select **New project**.
2. Create a new project dedicated to Inventory Auditor. Continue only if its displayed price is approved.
3. Choose a region near your business, create a strong database password, and save that password in the password manager.
4. When the project is ready, open **Connect** or **Project Settings → API Keys**. Save these three values:
   - **Project URL**
   - **Publishable key**, beginning with `sb_publishable_`
   - **Secret key**, beginning with `sb_secret_`

If the Publishable and Secret sections are empty, select **Create new API keys** first. Then copy one publishable key and create or copy one secret key.

The secret key is for Railway only.

Now create the database tables. Run these five files once, in this order:

1. [`20260716210000_inventory_auditor.sql`](supabase/migrations/20260716210000_inventory_auditor.sql)
2. [`20260716220000_email_delivery_verification.sql`](supabase/migrations/20260716220000_email_delivery_verification.sql)
3. [`20260716230000_email_contacts_and_profiles.sql`](supabase/migrations/20260716230000_email_contacts_and_profiles.sql)
4. [`20260717010000_brand_location_management.sql`](supabase/migrations/20260717010000_brand_location_management.sql)
5. [`20260717203635_guided_history_import.sql`](supabase/migrations/20260717203635_guided_history_import.sql)

For each file: open it in GitHub, select **Raw**, copy everything, then open **Supabase → SQL Editor → New query**, paste it, and select **Run**. Wait for **Success** before moving to the next file. If a file reports an error, stop and record the filename and error with all private values hidden.

### 3. Put the app online with Railway

1. Open [Railway](https://railway.com/), create an account, and select **New Project → Empty Project**.
2. Railway creates an environment named `production` automatically. Leave it empty. Open the environment menu, select **+ New Environment → Empty Environment**, name it `staging`, and switch to `staging`.
3. While `staging` is selected, add a service from a **GitHub repo**. Give Railway access to only your new private `inventory-auditor` repository, then select it.
4. Confirm the service is deploying the `trunk` branch.
5. Open **Workspace Usage → Set Usage Limits**. Set a Compute email alert and hard limit no higher than the amount your business approved. If no charge is approved and Railway cannot enforce an acceptable limit, stop here.
6. Open the service's **Settings → Networking** and select **Generate Domain**. Copy the complete `https://...` address without a final `/`. This is your `APP_URL`.
7. Open that address. The first deployment should show **Setup required**.
8. On that screen, select **Generate safe values**. Copy all three generated values into the password manager under their displayed names. They disappear when the page closes.
9. In Railway, open the `staging` service's **Variables** page and add exactly these seven values:

| Variable | What to enter |
| --- | --- |
| `APP_URL` | your Railway `https://...` address |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SECRET_KEY` | Supabase secret key |
| `APP_SECRET_ENCRYPTION_KEY` | generated value with this name |
| `CRON_SECRET` | generated value with this name |
| `OWNER_SETUP_SECRET` | generated value with this name |

10. Save the variables and redeploy the Railway service. The included `railway.json` already supplies the build, start, and health-check settings.
11. Open `https://YOUR-RAILWAY-DOMAIN/api/setup/status`. Continue when it shows:
   - `"databaseReady": true`
   - `"readyForSignIn": true`
   - `"invalidBootstrapValues": []`

If the repository is missing in Railway, change the Railway GitHub App permission; do not make the repository public. If the setup status lists a missing migration or value, correct that exact item and redeploy.

### 4. Connect Supabase sign-in

In Supabase, open **Authentication → URL Configuration** and enter:

- **Site URL:** your exact Railway `APP_URL`
- **Redirect URL:** `https://YOUR-RAILWAY-DOMAIN/auth/callback`
- **Additional redirect URL:** `https://YOUR-RAILWAY-DOMAIN/auth/callback**`

Under the email sign-in provider, keep email/password sign-up and email confirmation enabled.

For the first owner, use the same business email that owns or belongs to the Supabase project. Supabase's built-in mail service can send only to pre-authorized project-team addresses. If the confirmation message does not arrive, complete **Part 3 — Add email** below, then return here.

### 5. Create the first owner

1. Open the Railway app and select **First-time setup**.
2. Enter the business name, your name, username, business email, password, and timezone.
3. For the owner setup code, enter the saved `OWNER_SETUP_SECRET`.
4. Submit once, open the confirmation email, and follow its link.
5. Return to the app and sign in.

The first successful account becomes the workspace's super admin. After it is created, public first-time registration closes and later users must be invited by an administrator.

### 6. Add a brand and historical data

1. Open **Configuration → Brands & Locations** and add the brand. You do not need to create every product or location first.
2. Open **Configuration → Historical Data**, select that brand, and download the Excel template.
3. The template is intentionally blank below its headings. Starting on row 2, fill its four columns: `date`, `product`, `location`, and `quantity`. Dates use `YYYY-MM-DD`; quantities are complete daily totals expressed as whole numbers of zero or more.
4. Upload the file and select **Validate and preview**. Products are discovered automatically under the selected brand.
5. If the file contains a location the brand does not recognize, either match it to an existing location or complete the short location card with its address and timezone. Nothing is imported until every location is resolved.
6. Review the displayed counts for new rows, unchanged rows, and corrections. Select **Import reviewed file** only when those counts are correct.
7. Open **Dashboard**, choose the brand, location, product, and date period, and confirm the totals match the file. Later uploads add new dates and products, leave omitted history untouched, and replace only a changed total for the same date, location, and product.

The basic app is now working. Open an optional section below only for a feature you want to use.

## Optional features

<details>
<summary><strong>Add multivariate forecasting</strong></summary>

### Multivariate forecasting

Forecasting needs a GitHub token and a compatible AI API. The app calculates and condenses the sales history locally. The AI reads the active `ANALYSIS_SKILL.md` and researches only the variables defined there; the app validates those sourced assessments and calculates the final recommendations itself. The result keeps four decisions separate: the historical baseline, live researched factors, any low-confidence rough estimate used when factor-specific history is unavailable, and the final AI-advised quantity.

### Connect GitHub

1. In GitHub, create a [fine-grained personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).
2. Limit it to your private `inventory-auditor` repository.
3. Give it only **Contents: Read and write** permission and the shortest practical expiration.
4. In Inventory Auditor, open **Configuration → Keys → GitHub Sync** and enter:
   - your repository owner;
   - repository name `inventory-auditor`;
   - branch `trunk`; and
   - the token.
5. Select **Save securely**, then **Test**.

### Connect the AI provider

Choose **OpenAI**, **Anthropic (Claude)**, **Google (Gemini)**, or an explicitly **OpenAI Responses-compatible** service. The app uses the selected provider's real authentication, endpoint, live-search tool, and response shape; changing the label does not pretend one API is another. The exact model must support that provider's live web-search feature and source URLs. Set an approved spending limit before creating the key. The capability test makes one small live-search request, so it can consume provider credits.

For the first test, choose a lower-cost model that the provider currently documents as supporting live web search. The capability test will confirm whether the exact model and account access are compatible. Native OpenAI forecasts request low reasoning effort, and live-research runs may take up to five minutes.

1. Create the provider account and API key.
2. In **Configuration → Keys → AI Analysis**, choose the provider, enter the exact API model name, and paste that provider's API key. The official base URL is filled automatically. Enter a base URL yourself only for the Responses-compatible option.
3. Select **Save securely**, then **Test capabilities**. A pass means the selected provider/model completed live search and returned JSON that passed the app's server-side validator.
4. Open **Configuration → Analysis Skill**, read the active variables, and select **Save and activate**.
5. Open **Dashboard**, select one location and **Day**, then run one forecast with test data.
6. Confirm the result shows, in order:
   - **Historical baseline by location** for each product;
   - **Live researched factors by location** for the selected dates, with direct source links;
   - **Rough prediction based on no previous data for these factors**, kept separate and labeled low-confidence when factor-specific history is unavailable; and
   - **AI-advised production quantities** beside the historical baseline, including the difference and a brief reason.

Any non-zero rough estimate must show **Review needed**. If live research fails, accept only a clearly labeled sales-history-only result or warning; it must not claim that outside factors were applied.

If no compatible provider or budget is approved, leave AI disconnected. The historical dashboard still works.

</details>

<details>
<summary><strong>Add invitations and email</strong></summary>

### Invitations and email

Email needs a domain your business owns. Resend supplies DNS records; the company that manages your domain must add them.

1. Create a [Resend](https://resend.com/) account and add a business-owned domain or subdomain.
2. Add Resend's DNS records and wait until the domain says **Verified**.
3. Choose a sender address on that domain, such as `forecasts@updates.example.com`.
4. Create two **Sending access** keys restricted to that domain:
   - `inventory-auditor-auth` for Supabase sign-in email;
   - `inventory-auditor-app` for invitations and forecast email.
5. Save both keys in the password manager.

In **Supabase → Authentication → SMTP Settings**, enable custom SMTP and enter:

| SMTP setting | Value |
| --- | --- |
| Sender email | your verified sender address |
| Sender name | `Inventory Auditor` |
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | the `inventory-auditor-auth` key |

Save the SMTP settings. If Resend link tracking is on, turn it off for authentication email so sign-in links are not rewritten.

Then, in Inventory Auditor:

1. Open **Configuration → Keys → Resend**. Enter the verified sender address and the `inventory-auditor-app` key. Select **Save securely**, then **Test**.
2. Open **Configuration → Email Schedule**. Leave **Forecast emails enabled** off, choose the delivery settings, and select **Save schedule**.
3. Select **Send test to me**. Do not continue until exactly one correct internal test message arrives.
4. Open **Configuration → Users**, invite each user, assign at least one location, and choose whether that user receives forecast email. A user sees and receives only assigned locations.
5. Add any email-only recipients under **Configuration → Email Schedule** and assign their locations.
6. Keep the schedule off while testing. The Dashboard's **Send Email** button becomes the manual backup after the schedule and internal test exist.

</details>

<details>
<summary><strong>Turn on automatic email</strong></summary>

### Automatic email

Do this only after a manual forecast and internal test email both work. Scheduled runs can use Railway, Supabase, AI, and Resend allowances.

1. In Railway, add `EMAIL_DELIVERY_ENABLED` with value `false`, then redeploy.
2. In Supabase, enable **Integrations → Cron** and the `pg_net` database extension.
3. In **Supabase → Vault**, create:
   - `inventory_auditor_app_url` with your Railway `APP_URL`;
   - `inventory_auditor_cron_secret` with the same `CRON_SECRET` stored in Railway.
4. In **Supabase → SQL Editor → New query**, run this exactly. It contains secret names, not secret values:

```sql
select cron.schedule(
  'inventory-auditor-forecast-every-15-minutes',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'inventory_auditor_app_url'
    ) || '/api/jobs/forecast',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'inventory_auditor_cron_secret'
      )
    ),
    body := jsonb_build_object('triggered_at', now()),
    timeout_milliseconds := 300000
  ) as request_id;
  $$
);
```

5. In **Supabase → Integrations → Cron → Jobs**, confirm the job exists, then switch it **Inactive** for now.
6. In Inventory Auditor, set the intended users' email toggles, configure **Email Schedule**, and enable the schedule.
7. In Railway, change `EMAIL_DELIVERY_ENABLED` to `true` and redeploy.
8. Return to Supabase Cron and switch the job **Active**.

To stop all automatic email, set Railway `EMAIL_DELIVERY_ENABLED=false`, turn off the in-app schedule, and make the Supabase Cron job inactive.

</details>

## Quick final check

The basic app is ready when:

- the owner can sign in;
- each user sees only assigned locations;
- at least one brand and location exist; and
- imported totals match the historical dashboard.

If you enabled forecasting, one test forecast must follow the active Analysis Skill and show the historical baseline, sourced live factors, the separate low-confidence rough-estimate section, and the final AI-advised quantity with its difference and reason. If you enabled email, one internal test email must be correct. Automatic email should remain off unless you deliberately completed that section.

## If you get stuck

Contact the person or team who shared this repository. Tell them the numbered step, the screen name, what you expected, what happened, and the time it happened. Hide all emails, account IDs, business data, passwords, API keys, tokens, and secret values.

## AI-guided setup

Use this path if you have Codex or another action-capable AI agent that can read the repository and operate a signed-in browser. A text-only chatbot can explain the guide, but it cannot complete the browser setup for you.

### Test the repository before creating provider accounts

You can first verify the application code without creating Supabase, Railway, Resend, or AI-provider accounts. Give Codex access to this repository and say:

> Read the entire README and AGENTS.md. Do not create or connect any external account. In an authorized code workspace, install the locked dependencies if needed, run `pnpm verify:handoff`, and give me a plain-language pass/fail report. Clearly separate account-free code readiness from live services that remain untested.

That check runs the automated tests, lint check, type check, and production build. It verifies the app's code and simulated provider contracts without needing credentials or sending data. It cannot prove that a future account has the right permissions, that DNS or email delivery works, that Railway allows outbound traffic, that the live database denies cross-location access, or that a chosen AI model performs web research correctly. The full AI-guided setup below performs those live checks after the owner connects each service.

### What Codex can reuse

Codex should use any organization-authorized connectors, plugins, and signed-in provider sessions that are already available before asking you to create another account or repeat work. Those connections help Codex operate the setup; they do not become credentials for the deployed application. A ChatGPT or Codex subscription is not an AI API key, and a plugin's private session token must never be copied into Railway or Inventory Auditor. Scheduled forecasts and email therefore still need restricted, app-specific runtime credentials entered directly by the owner when Codex reaches that step.

### What happens first

1. Create or sign in to Codex on a private computer.
2. Give the agent access to the Inventory Auditor repository you received. If it is still the shared template, that is fine: the agent will guide you through making your own private copy and then tell you how to reopen the task in that copy.
3. Connect any available GitHub, Supabase, Railway, or Resend tools and allow browser control. Do not create a duplicate account just because a connector is unavailable.
4. In separate browser tabs, sign in only to organization-owned provider accounts you already have. Missing accounts can wait; the agent will identify what is reusable first and then walk you through creating only what is still required.
5. Open an agent task for the repository and paste the complete prompt below.

### What you need to do during setup

Stay available while the agent works. When it pauses, it must tell you one exact action in plain language. You handle sign-in, MFA, CAPTCHA, account terms, payment decisions, DNS approval, and secret storage. Do not paste a password or secret into the chat; enter it directly into the provider's password or secret field when the agent asks.

### What happens after that

The agent works through the same setup as the manual guide, validates each checkpoint, and gives you a final non-secret handoff report. It must keep production and real-recipient email off unless you explicitly approve them after testing.

<details>
<summary><strong>Copy the complete AI setup prompt</strong></summary>

```text
You are my Inventory Auditor setup operator and patient beginner guide. Assume I know nothing about GitHub, Supabase, Railway, Resend, APIs, DNS, databases, deployments, or AI models. Your job is to get this repository's complete Inventory Auditor stack working with accounts owned by my organization, while protecting secrets, preventing unexpected charges, and explaining every human action in plain language.

OBJECTIVE

Set up and verify, in this order:

1. my independent private GitHub repository created from the Inventory Auditor template;
2. a new dedicated Supabase project with all required database migrations and authentication;
3. a Railway staging environment deployed from the repository's trunk branch;
4. the first super-admin owner account;
5. one test brand, two test locations, and invented historical sales data;
6. replaceable GitHub and AI connections plus the active ANALYSIS_SKILL.md forecasting workflow;
7. Resend authentication and application email, a disabled saved schedule, and one internal test message;
8. one location-scoped test user and proof that the user cannot see another location;
9. the protected Supabase Cron scheduler, initially inactive; and
10. complete functional, security, and handoff verification.

SOURCE OF TRUTH

- Read this entire README before taking action. Use its manual Setup section as the product-specific source of truth, including the exact migration order, Railway variables, callback URLs, provider requirements, email gates, and Cron command.
- Read the repository's AGENTS.md and follow any applicable safety, branch, QA, and deployment rules.
- Inspect the repository before changing anything. Confirm that railway.json, ANALYSIS_SKILL.md, the five Supabase migration files, and the Excel history template exist.
- If a provider screen or label has changed, inspect the current screen and consult that provider's current official documentation. Adapt the clicks without weakening any safety rule. Do not guess.
- Do not modify application code, database migrations, ANALYSIS_SKILL.md, or repository instructions merely to bypass a failed setup step. If the setup appears blocked by a real product defect, show me the evidence and ask before making any code change.

HOW TO WORK WITH ME

- Maintain a visible checklist with one status for every phase: Not started, In progress, Waiting for me, Passed, or Blocked.
- Before asking me to create an account, key, or connection, inventory the authorized connectors, plugins, code-workspace capabilities, and signed-in browser sessions already available. Use existing organization-owned access first when it can safely complete that setup step.
- Do every safe, reversible, in-scope action you can through authorized plugins, connectors, the browser, or the provider's own interface.
- Ask me only for actions that genuinely require the account owner. Ask one short question or give one short instruction at a time.
- Before I act, tell me: where to click, what I should see, what I must enter, why it is needed, and how we will know it worked. Avoid unexplained technical terms.
- After I act, inspect the result and verify it before advancing. Never mark a checkpoint Passed merely because a button was clicked.
- If you lack a required plugin, connector, browser permission, or signed-in session, say exactly what is missing and walk me through enabling only that access.
- Treat connector and browser authorization as temporary setup access. Never extract, reveal, copy, or repurpose an agent-session, browser-session, OAuth, or connector token as an application credential. When the deployed app needs unattended access, explain why and use a separate least-privilege runtime credential owned by my organization.
- Never ask me to send you a password, MFA code, recovery code, full API key, database secret, owner setup secret, or payment-card detail in chat.
- Before any password, token, API key, generated security value, recovery code, or MFA code is created or revealed, stop inspecting the browser and hand control to me. Tell me to generate or reveal it, save it directly in the organization password manager, enter it directly in the destination secret field when required, then hide or close it and reply `done`. Resume only after it is no longer visible. Never capture the page, DOM, clipboard, or a screenshot while it is shown. Do not repeat, display, log, or summarize it.
- In progress reports and support messages, redact email addresses, account IDs, project references, private URLs, and all secrets. In this private owner-only task, use exact non-secret repository and staging URLs only when needed for navigation and the final handoff; never publish or forward them.

NON-NEGOTIABLE SAFETY RULES

- Work only in my independent private repository. Do not alter the original template repository or anyone else's copy.
- This repository intentionally uses the single branch trunk. Do not create main or dev. Never force-push or rewrite shared history.
- Railway staging is the only authorized deployment. Leave Railway's default production environment empty. Never deploy production.
- Never make a private repository public as a workaround.
- Never place a password, API key, token, database secret, generated security value, customer data, or real sales data in GitHub, a committed file, chat, logs, screenshots, issue text, or test output.
- Use invented brands, locations, products, quantities, and internal organization-controlled email addresses until every relevant test passes.
- Do not create a paid plan, add a credit card, approve overages, buy a domain, or accept any amount above $0 without showing me the exact quoted cost and receiving my explicit approval. If a no-cost path is unavailable, mark that feature Blocked instead of improvising.
- Set the lowest approved provider budgets, usage alerts, and hard limits before any potentially billable AI call or continuously running deployment.
- Do not broaden a GitHub token, API key, repository permission, or user role beyond the minimum stated in the README.
- Do not treat my ChatGPT or Codex subscription as OpenAI API access, and do not attempt to recover or reuse Codex's own credentials. The deployed forecaster must use an explicitly approved API project and app-specific key.
- Keep EMAIL_DELIVERY_ENABLED=false, the in-app email schedule disabled, and the Supabase Cron job inactive until the internal email and scheduler tests pass.
- Do not send email to a real manager, customer, or external address without showing me the exact recipients and receiving explicit approval.
- Do not activate automatic email until you show me the exact recipients, cadence, timezone, forecast horizon, provider-cost implications, and stop controls, then receive explicit approval.

REQUIRED WORKFLOW AND CHECKPOINTS

PHASE 0 — ACCESS AND COST PREFLIGHT

1. Confirm I am using a private computer and an organization-controlled password manager.
2. Inventory the authorized connectors, plugins, code-execution tools, and signed-in provider sessions already available. Tell me what can be reused for setup, what is missing, and which services will still require permanent app-specific runtime credentials. Do not ask me to create duplicate accounts.
3. Confirm you have an authorized code-execution workspace for this repository. Install the locked dependencies if needed and run `pnpm verify:handoff` before creating external resources. Report the actual test, lint, type-check, and production-build results. This is account-free code readiness only; keep every live provider, database security, DNS, email, and AI forecast checkpoint Not started until actually tested.
4. If an authorized code workspace is unavailable, explain how to connect or open the repository there and disclose any checkout, cloud-compute, or usage implications and costs first. If it remains unavailable, mark automated QA Blocked and never claim full verification.
5. Confirm which organization-owned email address will own each service. Personal developer accounts are not acceptable for the final handoff.
6. Confirm access to an internal test inbox and, if email is required, a business-owned domain and its DNS manager.
7. Confirm the person authorized to approve costs and the maximum approved amount for GitHub, Supabase, Railway, Resend, the domain, and the AI provider. Treat an unspecified amount as $0.
8. Confirm you can access an authorized browser. Report any remaining missing capability before continuing.

PHASE 1 — PRIVATE GITHUB COPY

1. Determine whether the open repository is the shared template or my independent copy.
2. Use an existing authorized GitHub connector or signed-in browser session if available. If it is the template, guide me through Use this template → Create a new repository, selecting my account or organization, naming it inventory-auditor, choosing Private, and leaving Include all branches off. If Use this template is unavailable, stop and tell me to contact the repository owner; do not substitute a fork, ZIP, or public repository.
3. Confirm the new URL belongs to my account or organization, the repository is private, trunk is the only branch, and the required setup files exist.
4. If the agent task or code workspace still points at the shared template, pause and guide me through opening the new private copy. Re-read that copy's README and AGENTS.md before changing anything or continuing to Phase 2.
5. Do not use a fork or Download ZIP.

PHASE 2 — SUPABASE DATABASE

1. Guide me through creating a new dedicated Supabase project in an organization-owned account. Stop before confirmation if the displayed price is not approved.
2. Have me save the database password in the password manager.
3. Locate the Project URL, one sb_publishable_ key, and one server-only sb_secret_ key. If the new key sections are empty, guide me through creating them. Before either key is generated or revealed, hand browser control to me and follow the secret-handling rule above until the values are safely stored and hidden.
4. Keep the secret key out of NEXT_PUBLIC variables and out of every browser-visible application field.
5. Apply these committed migrations once, to the new empty project, in this exact order:
   a. supabase/migrations/20260716210000_inventory_auditor.sql
   b. supabase/migrations/20260716220000_email_delivery_verification.sql
   c. supabase/migrations/20260716230000_email_contacts_and_profiles.sql
   d. supabase/migrations/20260717010000_brand_location_management.sql
   e. supabase/migrations/20260717203635_guided_history_import.sql
6. After each migration, verify Success before continuing. On an error, stop, preserve the database, and report the filename plus a sanitized error. Do not edit or repeatedly rerun SQL blindly.
7. Verify the migration markers, row-level security readiness, and brand-logos bucket expected by the application without exposing data or secrets.

PHASE 3 — RAILWAY STAGING

1. Create an Empty Project in Railway.
2. Leave Railway's automatically created production environment empty. Create and switch to an Empty Environment named staging.
3. In staging only, add the private GitHub repository and confirm it deploys trunk using the committed railway.json configuration.
4. Before leaving the service running, configure the approved Compute alert and hard limit. Stop if Railway cannot enforce an acceptable approved limit.
5. Generate a Railway domain and record the non-secret HTTPS APP_URL without a trailing slash.
6. Open the first deployment. Seeing Setup required is expected.
7. Before selecting the app's Generate safe values control, stop inspecting the browser and hand control to me. Tell me to generate and store the three values under their exact names, close or hide the values, and reply `done` before you resume:
   APP_SECRET_ENCRYPTION_KEY
   CRON_SECRET
   OWNER_SETUP_SECRET
8. Guide me through adding exactly these seven Railway staging variables, with secrets entered directly in Railway:
   APP_URL
   NEXT_PUBLIC_SUPABASE_URL
   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
   SUPABASE_SECRET_KEY
   APP_SECRET_ENCRYPTION_KEY
   CRON_SECRET
   OWNER_SETUP_SECRET
9. Redeploy staging. Verify the deployment is healthy.
10. Verify /api/setup/status reports databaseReady true, readyForSignIn true, no invalidBootstrapValues, and no missing migrations. Verify /api/health does not expose credentials.

PHASE 4 — AUTHENTICATION AND FIRST OWNER

1. In Supabase Authentication → URL Configuration, set Site URL to the exact Railway APP_URL.
2. Add only the app callback URLs from the README, including the exact /auth/callback URL and its safe callback pattern. Do not add a site-wide wildcard.
3. Keep email/password signup and email confirmation enabled.
4. Use an organization-controlled Supabase-team email for initial setup. If Supabase's built-in mail cannot deliver, temporarily perform only Phase 7 steps 1–6 (domain, authentication key, and Supabase SMTP), then return here; complete the in-app Resend connection after owner sign-in.
5. Open the Railway app's First-time setup page. Pause for me to enter the owner details, strong password, correct timezone, and OWNER_SETUP_SECRET directly.
6. Complete email confirmation in the same browser profile and verify the callback returns to Inventory Auditor.
7. Verify that the first account is Super admin, public first-time setup has closed, and the owner can sign out and sign back in with both username and email.

PHASE 5 — BRAND, LOCATION, AND INVENTED HISTORY

1. Add one invented test brand. Use a harmless test logo and correct IANA default timezone if needed, but do not manually create its products.
2. Download the app's Excel history template. Do not create a different column layout.
3. Fill only date, product, location, and quantity. Use YYYY-MM-DD dates and whole-number nonnegative daily totals. Include at least two invented location names and enough past dates to test day, week, month, quarter, and year views.
4. Select the invented brand, upload the file, and validate it. For each discovered location that does not already exist, complete its new-location card with a different invented address, unique import code, and correct timezone. If a location genuinely already exists under this brand, match that source label to it instead. Save the location setup and re-check the file.
5. Verify the preview clearly identifies automatically discovered products and classifies new, unchanged, and corrected sales rows. Import only when there are no unresolved locations or validation issues.
6. Upload a second file containing one new date, one identical row, and one corrected quantity. Verify the new date is inserted, the identical row remains unchanged, the correction is explicit and audited, and history omitted from the second file remains present.
7. Verify the saved imports and independently reconcile Dashboard totals, dates, products, and locations with the files.

PHASE 6 — GITHUB ANALYSIS SKILL AND AI FORECASTING

1. Guide me to the fine-grained GitHub-token creation page, configured for only my private Inventory Auditor repository, with only Contents: Read and write and the shortest practical expiration. Before the token is created or revealed, hand browser control to me and follow the secret-handling rule above. Have me store the token and renewal date in the password manager, hide it, and reply `done` before you resume.
2. Connect GitHub Sync under Configuration → Keys using my repository owner, inventory-auditor, trunk, and the token. Save and Test. Verify the app can read root ANALYSIS_SKILL.md.
3. First check whether my organization already has an approved AI API-platform project and a suitable app-specific credential. A ChatGPT or Codex subscription, Codex sign-in, or AI plugin connection does not count as runtime API access and must not be copied into the app. Reuse an existing approved API account for setup when possible, but have me create or enter the restricted runtime key directly.
4. Do not pick an AI provider or model by guessing. Ask which organization-approved provider and maximum budget I authorize. If none is selected, research current compatible options only from official provider documentation, explain the choices, current official unit pricing, estimated test cost, and a proposed hard maximum budget or cap, then wait for my decision.
5. Verify the selected model supports its provider's live-search tool and direct source URLs. Use the native OpenAI Responses adapter, Anthropic Messages adapter, Google Gemini adapter, or the explicitly Responses-compatible adapter as selected in the app; do not substitute one provider's request format for another.
6. Set the approved spending limit before creating or using an AI key. Before the key is created or revealed, hand browser control to me and follow the secret-handling rule above. Have me choose the provider and enter the exact model and API key directly under Configuration → Keys → AI Analysis, hide the key, and reply `done` before you resume. The app fills official base URLs automatically; a custom URL is required only for Responses-compatible services.
7. Save and Test the connection. A model-list test alone is not full forecast proof.
8. Open Configuration → Analysis Skill. Read and validate the entire repository-backed ANALYSIS_SKILL.md. Explain its active variables in plain language. Do not change them unless I request a specific change.
9. Select Save and activate only after the exact repository version is reviewed.
10. Choose the current **Day / Today** period. Run and verify one single-location forecast, then repeat one location at a time for every location assigned to the signed-in owner. Do not continue until every assigned location has a fresh current-policy forecast for the same **Today** horizon that the disabled email schedule will use. For each run, verify these four displayed steps in order: **Historical baseline by location**; **Live researched factors by location** with direct valid sources for the exact location and dates; the separate **Rough prediction based on no previous data for these factors** section; and **AI-advised production quantities** beside the baseline with the difference and a brief reason. Any non-zero rough estimate must be low-confidence and mark the run **Review needed**. If live research fails, require a truthful sales-history-only result or warning and do not pass the forecast as multivariate. Treat missing research, citations, scope, or explanations as a failed test.

PHASE 7 — RESEND, AUTH EMAIL, AND APP EMAIL

1. Confirm I own the proposed sending domain or subdomain. Do not purchase one without approval.
2. In Resend, add the domain, show me the exact DNS records, and pause for me to authorize or make the DNS changes. Wait for Resend to show Verified.
3. Choose a plain From address on the verified domain.
4. Prepare two domain-restricted Sending access keys with the shortest practical scope:
   inventory-auditor-auth for Supabase custom SMTP
   inventory-auditor-app for Inventory Auditor invitations and forecasts
5. Before either key is created or revealed, hand browser control to me and follow the secret-handling rule above. Have me create and store both keys in the password manager, hide them, and reply `done` before you resume. Never expose either key in chat or reports.
6. Configure Supabase custom SMTP using the README's exact sender, host, port, username, and auth-key mapping. Turn off link tracking for authentication email if enabled.
7. Connect Resend in Configuration → Keys using the verified From address and the app key. Save and Test.
8. In Configuration → Email Schedule, keep Forecast emails enabled off, set the forecast horizon to **Today** so it matches the verified forecasts from Phase 6, choose the other intended test delivery settings, and Save schedule before adding recipients.
9. Select Send test to me. Verify exactly one correct message arrives at the signed-in internal administrator and contains only expected invented data and assigned locations.
10. If any sender credential changes, require another successful internal test before scheduling.

PHASE 8 — USER SCOPE AND MANUAL EMAIL

1. Invite one internal test user. Assign that user to exactly one invented location and leave forecast email off initially.
2. Guide the user through invitation acceptance, password creation, confirmation, and sign-in without sharing passwords.
3. Verify through the user interface and safe authorized checks that this user can see only the assigned location and cannot access the second test location by changing filters or URLs.
4. Enable email only for the intended internal test user after scope passes.
5. Confirm the Dashboard Send Email action names the exact stored forecast, period, locations, and recipients before sending. Send one manual internal message only after I approve that confirmation.
6. Verify one correct message and no duplicate delivery.

PHASE 9 — PROTECTED AUTOMATIC SCHEDULER

1. Keep Railway EMAIL_DELIVERY_ENABLED=false and the in-app schedule disabled.
2. Follow the README's Automatic email section exactly: enable Supabase Cron and pg_net, place APP_URL and CRON_SECRET in Supabase Vault under the specified secret names, and create the protected every-15-minute POST job to /api/jobs/forecast.
3. Confirm the Cron command contains Vault secret names, never secret values or a secret query parameter.
4. Immediately keep the Cron job Inactive.
5. Verify the current Resend credential/sender pair passed its internal test, recipients have explicit active location assignments, the correct Analysis Skill is active, and fresh cited forecasts exist.
6. Show me a final activation summary containing the exact internal recipients, location scope, email cadence, timezone, forecast horizon, estimated provider usage, Railway kill switch, in-app stop control, and Cron stop control.
7. Ask for explicit approval before enabling anything. If approved, enable the in-app schedule, set Railway EMAIL_DELIVERY_ENABLED=true and redeploy staging, then activate the Supabase Cron job. If not approved, leave the complete scheduler configured but off.
8. For acceptance, use exactly one internal recipient, a daily **Today** schedule timed just before the next 15-minute check, and fresh matching forecasts. Observe at least two checks and verify exactly one email. Then disable the in-app schedule, set Railway `EMAIL_DELIVERY_ENABLED=false` and redeploy staging, deactivate Cron, and verify a later poll sends nothing. Leave all three controls off unless I separately and explicitly approve leaving internal-only automatic delivery active after reviewing the final activation summary. Never send to external or real manager addresses during setup.

PHASE 10 — FINAL QA AND HANDOFF

1. Recheck the private repository and single trunk branch. Confirm no secrets or real data were committed.
2. Confirm Railway production is empty and only staging is deployed.
3. Confirm Supabase migrations, authentication, row-level access, storage, and owner status.
4. Confirm the historical Dashboard for all periods and individual products.
5. Confirm GitHub Sync, the exact active ANALYSIS_SKILL.md revision, the AI connection, one forecast that passes every Phase 6 display and evidence check, Resend, one internal test email, one location-scoped user, and manual-email controls.
6. Confirm the scheduler is either explicitly approved and tested or fully configured and safely off. Test all three stop controls when safe.
7. Run every repository-provided automated test, type check, lint check, and production build available in the authorized environment. Do not claim they passed without the actual results.
8. Produce a final sanitized handoff report containing:
   - the non-secret GitHub repository and Railway staging URLs;
   - which organization owns each provider account;
   - provider connection and test status;
   - database migration status;
   - active Analysis Skill version/checksum if displayed;
   - test-data, user-scope, forecast, and email results;
   - current schedule and kill-switch state;
   - approved budgets, alerts, and credential-renewal dates without secret values;
   - anything Blocked, the exact next human action, and who should be contacted.

DEFINITION OF DONE

Do not say setup is complete until every applicable phase is Passed or explicitly marked Blocked with a clear reason. The minimum working historical app requires owner sign-in, one brand/location, a clean import, and reconciled Dashboard totals. Full forecasting additionally requires connected GitHub and AI, an activated repository Analysis Skill, and a test forecast that passes the four-step baseline, live-research, rough-estimate, and final-advice checks in Phase 6. Full email additionally requires a verified Resend domain, custom SMTP, a connected app key, a saved disabled schedule, explicit location-scoped recipients, and a successful internal test. Automatic delivery additionally requires the protected Cron chain and my explicit activation approval.

Begin now by reading the entire README and AGENTS.md, inspecting the repository, showing me the 11-phase checklist, and asking only the first necessary access or preflight question.
```

</details>

## License

Inventory Auditor is free software licensed under the [GNU Affero General Public License v3.0 or later](LICENSE) (`AGPL-3.0-or-later`). Commercial use is allowed, but modified versions that are distributed or offered to users over a network must keep the same license and make their complete corresponding source code available to those users. Copyright © 2026 Olive Tree Builds.

For developers maintaining the code, technical references remain in `docs/`; an app owner does not need them for setup.
