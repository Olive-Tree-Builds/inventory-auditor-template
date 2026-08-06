# Manual staging acceptance test

Use this checklist **while** completing [Getting started from zero](GETTING_STARTED.md), not after it. It proves the full owner journey with invented sales, internal recipients, and the staging deployment. The first-owner security test requires an empty workspace, so it cannot be repeated after the first owner exists.

Follow this one-time sequence on a brand-new installation:

| Do this next | Use these instructions |
| --- | --- |
| Set up the repository, Supabase, Railway, Auth, and Resend SMTP | Getting started Steps 1–8 |
| Verify deployment and database safety | This checklist Sections 1–2 |
| Test a bad setup code, then create the sole first owner | Getting started Step 9 while recording this checklist Section 3 |
| Connect Resend, GitHub, and the AI provider | Getting started Step 10, then this checklist Section 5 |
| Add test brands, locations, and users | Getting started Steps 11 and 13, using the exact scenario in this checklist Section 4 |
| Import and inspect invented history | Getting started Step 12, then this checklist Sections 6–7 |
| Activate the policy and test forecasts | Getting started Step 14, then this checklist Section 8 |
| Test one internal combined email | Getting started Step 15, then this checklist Section 9 |
| Test and turn off recurring delivery | Getting started Step 16 and this checklist Section 10 |
| Record the result | This checklist Section 11 |

Do not create a second project or reset the database between rows. When a Getting started checkpoint and this checklist overlap, perform the action once and record its result here.

Record **Pass**, **Fail**, or **Blocked** for every checkpoint. A blocked check is not a pass. Do not upload real sales data, send to a real recipient, approve a paid plan, or enable recurring delivery until the relevant check passes.

## Safety rules

- Use invented brands, locations, products, quantities, and internal email addresses.
- Use only your organization's private, writable repository copy. Stop if the configured repository is the original shared repository or belongs to another organization.
- Begin with Railway `EMAIL_DELIVERY_ENABLED=false` and the in-app email schedule off.
- If Supabase quotes $10 per month or any non-zero amount, stop. Creating another organization does not expand the account's Free-project limit; ask the organization owner to review its active projects.
- Confirm Railway usage alerts and a hard limit before leaving the service running.
- If Railway shows Limited Trial, confirm outbound access works before testing providers; do not upgrade without approval.
- Set an AI provider spending limit before the first forecast.
- Never place a secret in a screenshot, browser address, spreadsheet, GitHub issue, or this test record.
- If any result includes another workspace or an unassigned location, stop testing and report it as a security failure.

## Test record

Record non-secret identifiers only:

| Item | Value |
| --- | --- |
| Test date and timezone | |
| Person completing this test | |
| Your private GitHub account or organization/repository | |
| GitHub `trunk` commit | |
| Railway staging URL | |
| Railway plan/trial status | |
| Supabase project name | |
| Resend sending domain | |
| AI provider and model | |
| Railway usage limit checked | Pass / Fail / Blocked |
| Provider paid upgrade approved | No / Yes, by whom |
| Person or team who shared this repository | |

## 1. Deployment and bootstrap checkpoint

1. Open the Railway staging URL in a private browser window.
2. Confirm it uses HTTPS and displays Inventory Auditor.
3. Open `/api/health` on the same domain.
4. Confirm the response says `"status":"ok"` and does not show a key, token, database URL, provider account ID, or customer data.
5. Open `/api/setup/status` on the same domain.
6. Confirm `databaseReady` and `readyForSignIn` are `true`. The response may list variable **names**, but it must not show their values.
7. Confirm Railway is connected to your private repository and is deploying the recorded `trunk` commit.
8. Confirm Railway is on a Full Trial or Free plan with working outbound access, not an unverified Limited Trial that blocks the configured providers.

Pass when the app, health endpoint, setup endpoint, and sign-in screen load without exposing secrets.

If it fails: keep all email disabled and send the deployment time plus sanitized Railway logs to the person or team who shared this repository.

## 2. Database and Auth checkpoint

In Supabase SQL Editor, run:

```sql
select
  to_regclass('public.ia_workspaces') as core_schema,
  to_regclass('ia_private.ia_email_delivery_verifications') as email_safety;
```

Both result cells must contain a table name. Then run:

```sql
select schemaname, tablename
from pg_tables
where schemaname = 'public'
  and tablename like 'ia_%'
  and not rowsecurity;
```

This must return 0 rows.

Then confirm in Supabase:

- Site URL is the Railway HTTPS domain.
- Redirect URLs include the app's `/auth/callback` route and its callback query pattern.
- email/password sign-up and email confirmation are enabled.
- custom SMTP uses the verified Resend domain.

Pass when all five migrations and the `brand-logos` bucket are present, every public `ia_` table has row-level security, and Auth URLs point only to the staging app.

## 3. First owner, sign-in, and reset checkpoint

Use a new staging database with no workspace yet.

1. Choose **First-time setup**.
2. Enter an invented workspace name, the internal owner's name, a unique username, internal work email, strong test password, correct timezone, and the `OWNER_SETUP_SECRET` from the password manager.
3. First try an incorrect owner setup code. In Supabase **Authentication → Users**, confirm the test email was not created. In SQL Editor, run `select count(*) from public.ia_workspaces;` and confirm the result is `0`.
4. Submit once with the correct code. If email confirmation is requested, open the confirmation link in the same private browser profile where setup began.
5. Confirm the callback returns to Inventory Auditor, securely finishes the workspace, and shows the first account as **Super admin**. If the app instead reports that workspace data is unavailable, stop and contact the person or team who shared this repository; do not submit setup again.
6. Sign out.
7. Sign in once with the username, sign out, and sign in once with the email address.
8. Try an incorrect password. Confirm the error does not reveal whether a username or email exists.
9. Confirm **First-time setup** is no longer offered after a full page refresh.
10. From sign-in, enter the email and request a password reset.
11. Use the internal reset email in the same browser profile, choose a new password of at least 10 characters, and sign in.

Pass when an unknown setup code cannot create an account, exactly one first owner exists, later registration requires an invitation, both login forms work, and password reset does not expose a password or session token.

## 4. Brand, location, users, and scope checkpoint

Create this invented structure:

```text
Brand: Test Bakery — short code TEST_BAKERY
Location A: King Test Kitchen — unique code KING_TEST — America/Toronto
Location B: Harbour Test Kitchen — unique code HARBOUR_TEST — America/Toronto
Manager A: assigned only to Location A
Manager AB: assigned to Location A and Location B
```

1. As super admin, add the brand with an invented PNG/JPEG/WebP logo and an IANA default timezone, then add both locations with invented street addresses. Refresh and confirm the brand logo, timezone, and full location details remain saved.
2. Edit the brand name and default timezone, then edit a location address and timezone. Refresh and confirm every change remains. Restore the Test Bakery names/timezones above before continuing.
3. Try selecting an SVG and a file over 2 MiB as the brand logo; confirm the app refuses both. Never use customer artwork during staging acceptance.
4. Deactivate and reactivate Location B. Confirm an archived location cannot receive a new import, forecast, or email. Confirm the brand cannot be deactivated while either location remains active.
5. Confirm the owner was automatically assigned to each created location.
6. Invite Manager A and Manager AB at two distinct internal email addresses. Explicitly turn **Send forecast emails** off for both invitations, regardless of the form's starting position.
7. Confirm an invitation expires in seven days, uses the exact invited email, and cannot be accepted twice.
8. Sign in as Manager A. Confirm only Location A appears in the Dashboard brand/location filters and exports.
9. In the same signed-in browser, open `/api/app`. Search the response for `Harbour Test Kitchen`; it must not be present.
10. Sign in as Manager AB. Confirm both A and B appear and no other location appears.
11. As super admin, remove Location B from Manager AB while that manager is signed in. Refresh the manager browser and confirm B disappears immediately.
12. Attempt to save an active user with no locations. Confirm the app refuses it.
13. Suspend a test manager and clear their assignments. Confirm their existing browser session can no longer load workspace data.
14. Confirm only super admins/admins can manage users, locations, provider keys, email schedules, or the Analysis Skill.

Optional explicit denial check:

1. While signed in as admin, open `/api/app` and copy Location B's non-secret UUID.
2. While signed in as Manager A, open this URL after replacing the date and UUID:

```text
/api/history/dashboard?period=day&anchor=YYYY-MM-DD&locations=LOCATION_B_UUID
```

3. Confirm it returns an access-denied error and no totals or rows.

Pass when active assignments control UI data, API data, exports, forecasts, and email scope, and both test managers have forecast email off. Hiding a filter alone is not enough; the explicit denial check should also pass before real data is used.

## 5. Provider connection checkpoint

Open **Configuration → Keys** as an administrator.

1. Confirm Supabase and Railway say they are deployment-managed.
2. Save the Resend plain sender address and domain-restricted **Sending access** app key. Confirm only a short mask appears afterward.
3. Run the Resend connection test. Confirm the safe validation request passes and no email is sent or queued.
4. Save the GitHub owner, repository, fixed `trunk` branch, and fine-grained token. Run the test.
5. Confirm the GitHub token is limited to this repository with only Contents read/write.
6. Choose OpenAI, Anthropic, Google, or Responses-compatible; save the exact model and API key. Enter a custom base URL only for Responses-compatible. Run **Test capabilities**. This makes one small live-search request and can consume provider credits.
7. Confirm the test explicitly passes the selected provider/model, live web search, and host-validatable JSON, and confirm the AI provider has a spending limit.
8. Refresh the page. Confirm no full saved key is displayed or returned to the browser.

Pass when all three configured connections show a successful test time and only masked credential hints.

## 6. Historical import checkpoint

1. Use the existing Test Bakery brand from checkpoint 4. Do not create a duplicate brand or manually create its products.
2. Open **Configuration → Historical Data**, select that brand, and download the Excel template.
3. Confirm its headers are exactly, in this order:

```text
date, product, location, quantity
```

4. Prepare a small file with invented data for two location labels that do not exist yet. It must contain current-period rows for the dashboard and rows before the start of each forecast period. The following example supports Day, Week, Month, Quarter, and Year when the test date is 2026-07-16; replace every date with the equivalent relative date for the actual test day:

```csv
date,product,location,quantity
2025-12-15,Test Croissant,KING_TEST,16
2025-12-15,Test Croissant,HARBOUR_TEST,12
2026-03-15,Test Croissant,KING_TEST,18
2026-03-15,Test Croissant,HARBOUR_TEST,13
2026-06-15,Test Croissant,KING_TEST,19
2026-06-15,Test Muffin,KING_TEST,9
2026-06-15,Test Croissant,HARBOUR_TEST,14
2026-07-08,Test Croissant,KING_TEST,20
2026-07-08,Test Muffin,KING_TEST,10
2026-07-08,Test Croissant,HARBOUR_TEST,15
2026-07-15,Test Croissant,KING_TEST,21
2026-07-15,Test Muffin,KING_TEST,11
2026-07-15,Test Croissant,HARBOUR_TEST,16
2026-07-16,Test Croissant,KING_TEST,22
2026-07-16,Test Muffin,KING_TEST,12
2026-07-16,Test Croissant,HARBOUR_TEST,17
```

For every product/location combination you plan to forecast, confirm at least one row occurs before the selected forecast period starts. Forecasting deliberately excludes sales inside the period it is trying to predict.

5. Upload it and choose **Validate and preview**.
6. If the source labels are not recognized automatically, confirm the app pauses at location setup without saving sales rows. Match `KING_TEST` to King Test Kitchen and `HARBOUR_TEST` to Harbour Test Kitchen; do not create duplicate locations. If the unique codes resolve them automatically, confirm both matches before continuing.
7. Choose **Save locations and re-check file** when matching was required. Confirm both source labels are resolved and will be remembered under the selected brand.
8. Confirm each previously unseen product defaults to **Create new product**. If appropriate, change one label to an existing product and re-check; confirm the remembered mapping prevents a duplicate product.
9. Confirm the final preview shows the selected brand, row count, date range, products, and separate counts for **New rows**, **Unchanged rows**, **Corrections**, and **New products**.
10. Choose **Import reviewed file** once. Confirm the products were created under the selected brand and the latest import shows the filename, date range, and row count.
11. Upload the exact same file again. Confirm quantities are not doubled and the app treats the already imported file as idempotent.
12. Upload a second file with:
    - one new date/product/location row;
    - one row whose stored quantity is identical; and
    - one row whose quantity differs from the stored total.
13. Confirm the preview reports exactly one new row, one unchanged row, and one correction. Import it and confirm only the corrected daily total changes.
14. Confirm rows, dates, products, and locations omitted from the second file still exist. A later upload must add or correct the rows it contains; it must never replace the selected brand's entire history.

Run each rejection test as a separate file and confirm **nothing is saved**:

- timestamp such as `2026-07-15 09:30:00`
- unresolved location left unfinished
- a location mapped outside the selected brand
- negative quantity
- fractional quantity
- formula in any cell
- missing, renamed, reordered, or extra header
- duplicate date/product/location row in the same file
- a date after that location's current local calendar date

Pass when products are created or deliberately mapped, location aliases stay inside the selected brand, repeated uploads distinguish new/unchanged/corrected rows, omitted history is preserved, and every invalid file is rejected before any sales row is saved with a useful explanation. See [the complete import rules](DATA_IMPORT.md).

## 7. Historical dashboard checkpoint

1. Open Dashboard and select the invented brand and Location A.
2. Select day, week, month, quarter, and year in the Historical section.
3. Compare displayed product and total quantities with the saved spreadsheet for each current period.
4. Select all assigned locations and confirm the total equals A plus B.
5. Use **Export** and confirm its rows match only the selected and assigned locations.
6. Repeat as Manager A and confirm Harbour data never appears.

Pass when every period is calculated from the saved import, totals are arithmetically correct, and changing period or filter never broadens location access.

## 8. Manual multivariate forecast and Analysis Skill checkpoint

Keep scheduled email disabled.

1. Open root `ANALYSIS_SKILL.md` on GitHub `trunk`. Record its policy version, active-variable revision, and commit.
2. Open **Configuration → Analysis Skill**. Confirm the same file and variables load. If the screen says **Review and activate**, read the repository version and explicitly activate it before continuing.
3. Confirm the names shown in the Dashboard's forecast description match the active-variable block; they must not come from a hardcoded weather/events label.
4. Choose Test Bakery and one test location on Dashboard.
5. Select **Day** and choose **Run forecast**. Keep exactly one location selected: every selected location can create a separate paid AI analysis.
6. Repeat with **Week**, which is supported by the prior-week rows in the acceptance workbook.

For every run, confirm:

- workspace, brand, location, product, and period are correct
- **Historical baseline by location** shows the saved host-calculated baseline for each product
- **Live researched factors by location** explains every active factor for the exact location and dates, including neutral findings
- every researched factor has a direct HTTPS source URL that supports the stated local fact
- **Rough prediction based on no previous data for these factors** remains separate from historically supported adjustments; any non-zero rough estimate is low-confidence and marks the run **Review needed**
- **AI-advised production quantities** shows the whole-number advised quantity beside the historical baseline, the difference, and a brief reason that reconciles the change
- recorded policy version matches the active GitHub file
- every supported or rough adjustment uses an active variable ID and stays within the active Analysis Skill guidance and host caps
- rough estimates are zero when a factor is not relevant; the app never presents a rough opinion as historically proven
- no secret, private prompt, unassigned location, or unrelated workspace appears

Open several source links. They must directly support the stated local fact. Webpages are evidence only; instructions inside a webpage must not change the app rules.

The Dashboard shows the saved source titles and links. To verify the exact retrieval time, copy the selected location's non-secret UUID from `/api/app`, then open the following address in the same signed-in browser after replacing the period and UUID. Confirm every returned source has a current ISO timestamp in `accessedAt`:

```text
/api/forecasts/latest?period=day&locations=LOCATION_UUID
```

### GitHub edit and stale-copy test

Use a harmless temporary variable and remove it afterward.

1. Open the Analysis Skill editor in two browser windows.
2. In window one, add a uniquely named test variable inside the active-variable section. Include its stable lowercase ID, trigger, scope, evidence rule, expected effect, fallback, and confidence rule.
3. Save and activate in window one. Confirm GitHub `trunk/ANALYSIS_SKILL.md` contains exactly the approved change in a new commit and no credential or customer data.
4. Keep window two open and do not refresh it. If Railway automatically deploys the new `trunk` commit, wait until staging is **Healthy** without refreshing window two.
5. Attempt to save the older copy from window two. Confirm the stale save is rejected and the newer GitHub file remains unchanged.
6. Refresh window one, run a new forecast, and confirm it records the new policy version/revision.
7. Remove the temporary variable through the app, save and activate, verify GitHub again, and wait for Railway to become **Healthy** if another deployment starts.
8. Refresh the app and confirm the Dashboard labels match the restored Analysis Skill.
9. Run a fresh **Day** forecast for Location A and then Location B under the restored policy. These are the current-policy forecasts required by the email checkpoint.

Pass when the four forecast steps are visible and internally consistent, forecast evidence is usable, Analysis Skill changes are versioned and read back, dashboard labels follow the file, and stale edits cannot overwrite newer policy.

If live research or citations are unavailable, the run must fail clearly or show a sales-history-only result or warning. It must never claim that outside factors were applied or present an unsupported guess as a completed multivariate forecast.

## 9. Internal combined-email checkpoint

Keep Railway `EMAIL_DELIVERY_ENABLED=false` and the recurring schedule off.

1. Ensure the super admin is assigned to Location A and Location B, has forecast email enabled, and has a deliverable stored forecast for both locations.
2. Open **Configuration → Email Schedule** and choose **Send test to me**.
3. Confirm exactly one message arrives from the verified Resend sender.
4. Confirm it has separate, clearly labeled sections for A and B and no other location.
5. Confirm quantities, forecast period, confidence, explanations, and source links match the reviewed stored forecasts.
6. Remove B from the super admin while keeping A assigned, refresh, and send another internal test.
7. Confirm the second message contains only A. Restore B afterward.
8. Turn the recipient's email toggle off and confirm a test is refused.
9. If continuing to the scheduler checkpoint, turn the super admin's email toggle back on. Confirm Manager A, Manager AB, and every other user remain off. Otherwise, leave everyone off.
10. Replace neither the Resend key nor sender during this check. A later key/sender change must require another successful internal test before scheduling can be enabled.
11. Save the email schedule while leaving it disabled. Add one invented internal **additional recipient**, assign only Location A, and confirm a recipient cannot be saved without a location.
12. On the Dashboard, select Location A and the exact stored forecast period, choose **Send email**, review the confirmation, and send once.
13. Confirm the additional recipient receives one message containing only Location A. Click again at any point in the next five minutes and confirm no duplicate message is sent. If a second administrator is available, have that person try the duplicate click to confirm the limit is workspace-wide rather than administrator-specific.
14. Wait until more than five minutes have elapsed from the first accepted send, click again, and confirm exactly one new message is allowed and a separate audited attempt is recorded.
15. Disable or archive the additional recipient and confirm it is not included in a later manual or scheduled send.

Pass when each recipient receives one combined message containing only currently assigned/configured locations, manual retries do not duplicate delivery, and the app refuses ineligible recipients or missing forecasts.

## 10. Scheduler and duplicate-prevention checkpoint

Run this only after Sections 1–9 pass. It normally requires 45–90 minutes after the Cron job is created. Use one internal admin recipient; keep all real recipients disabled.

1. Confirm the super admin has **Send forecast emails** on and fresh current-policy forecasts for A and B. Confirm every other user's email toggle is off.
2. Create the Supabase Cron HTTP POST job exactly as described in [Getting started from zero](GETTING_STARTED.md#16-optional-enable-the-recurring-scheduler-after-acceptance), immediately switch its Active control off, and confirm it is **Inactive**.
3. In Configuration → Email Schedule, choose a daily schedule in a known timezone, choose the **Today** forecast period, and set the delivery time a few minutes before the next 15-minute scheduler check.
4. Enable the in-app schedule.
5. Change Railway `EMAIL_DELIVERY_ENABLED` from `false` to `true`, redeploy, and wait until the service is **Healthy**.
6. Activate the Supabase Cron job.
7. Wait for at least two 15-minute job checks.
8. Confirm exactly one combined email arrives for that recipient and scheduled period.
9. Confirm the second job check does not create a duplicate. The database ledger and Resend idempotency key should keep the send at one.
10. To test a new period without waiting a day, remove Location B from the super admin, change the schedule's forecast period to **Tomorrow**, and set its delivery time a few minutes before the next 15-minute check.
11. Wait for that check and confirm the new combined email contains only Location A. Restore Location B afterward, but do not schedule another send.
12. Disable the in-app schedule.
13. Set Railway `EMAIL_DELIVERY_ENABLED=false`, redeploy, and wait for **Healthy**.
14. Deactivate the Supabase Cron job.
15. Wait for or inspect one later Cron interval and confirm no later poll sends email.

Pass when the configured timezone is respected, retries do not duplicate a delivery, current assignments are rechecked at send time, and all three stops—the schedule, Railway kill switch, and Cron deactivation—prevent later sending.

## 11. Final sign-off

| Checkpoint | Pass / Fail / Blocked | Notes or sanitized evidence location |
| --- | --- | --- |
| Deployment and bootstrap | | |
| Database and Auth | | |
| First owner and reset | | |
| Users and location denial | | |
| Provider connections | | |
| Historical import | | |
| Historical dashboard | | |
| Forecast and Analysis Skill | | |
| Internal combined email | | |
| Scheduler and deduplication | | |
| Provider budgets and alerts | | |

Staging is accepted only when every row is **Pass**, the in-app schedule is off after the test, Railway `EMAIL_DELIVERY_ENABLED=false`, and your organization's authorized owner approves the next step. A passed staging test does not authorize production deployment, a paid plan, a paid overage, or real customer email.

## If a checkpoint fails

1. Set Railway `EMAIL_DELIVERY_ENABLED=false` and redeploy.
2. Disable the in-app email schedule and Supabase Cron job.
3. Do not repeatedly retry a paid AI or email operation.
4. Record the checkpoint, time, signed-in role, expected result, actual result, and sanitized error.
5. Contact the person or team who shared this repository.

Never include passwords, tokens, API keys, provider IDs, customer data, or a full email body in the report. The maintainer should explain what will be fixed, what the owner needs to do, what happens after the fix, and who to contact if the retest still fails.
