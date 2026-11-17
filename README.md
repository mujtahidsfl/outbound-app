# Outbound

A cold email app: React + TypeScript (Vite) on the front, Vercel functions in [`api/`](api) on the back, and **Supabase** for the database, login and live sync. It sends from your own Google Workspace (or Titan) inboxes, runs written multi-step campaigns, checks for replies every 30 seconds, sorts them with Claude, and has a master inbox, sender pages and analytics.

This repo has no leads, inboxes or keys in it. Everything below is set up fresh for each business.

## What's in it

- **Dashboard**: emails sent, replies, reply rate, a 14-day send chart and a funnel.
- **Leads**: search, filters, bulk actions, bad-data flags and per-lead media.
- **Campaigns**: a written sequence per lead (first email plus follow-ups), subject A/B tests, offer splits, screenshots, a per-lead preview, test sends and analytics by email, subject, trade, inbox, timing and reply intent.
- **Master inbox**: every reply in one place, sorted by intent, with replies sent from the lead's own thread.
- **Mailboxes / sender accounts**: connect inboxes (Google sign-in or app password), daily limits, warm-up ramp, bounce counts, DNS checks and a daily inbox placement test.
- **Autopilot**: sends due follow-ups, then new leads, inside the send window, paced to each inbox's daily cap.

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. **SQL Editor**: run these files in order (each is safe to re-run):
   [`schema.sql`](supabase/schema.sql), [`sending.sql`](supabase/sending.sql), [`campaigns.sql`](supabase/campaigns.sql), [`opens.sql`](supabase/opens.sql), [`guard.sql`](supabase/guard.sql), [`seed.sql`](supabase/seed.sql), [`google.sql`](supabase/google.sql), then [`master_inbox.sql`](supabase/master_inbox.sql) last.
3. **Authentication → Sign In / Providers**: turn off "Allow new users to sign up", so only people you add can log in.
4. **Authentication → Users → Add user**: add each teammate with an email and password (tick "Auto confirm").
5. **Authentication → URL Configuration**: set **Site URL** to the Vercel URL once you have it.

### 2. Local

```bash
cp .env.example .env.local
npm install
npm run dev
```

Fill `.env.local` from Supabase → Project Settings → API. The service role key stays server-side only.

### 3. Vercel

1. Import this repo as a new Vercel project.
2. Add the env vars from [`.env.example`](.env.example): at least `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `CRON_SECRET`, `UNSUBSCRIBE_SECRET`, `SMTP_HOST`, `IMAP_HOST`, and an inbox password (`INBOX_PASSWORD` or one `INBOX_PASSWORD_<INBOX>` per inbox).
3. Deploy. The workflow in [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys on every push to `main` once you add the `VERCEL_TOKEN` repo secret and the `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` repo variables. Until then it fails with a note saying so; delete it if you deploy another way.

### 4. Timer

Copy [`supabase/autopilot_cron.example.sql`](supabase/autopilot_cron.example.sql) to `supabase/autopilot_cron.sql` (git-ignored), put in the app URL and `CRON_SECRET`, and run it in the SQL Editor. It calls `/api/cron` every 5 minutes for sending and every 30 seconds for reply checks.

### 5. In the app

1. **Settings**: company name and mailing address (every email's footer needs both), send window and daily limits.
2. **Mailboxes**: add the inboxes, then **Check connections** and **Send a test email**.
3. Load leads (below), build a campaign, set it Active, then turn on Autopilot.

Sender names and signatures: an inbox signs as its first name (`alex@…` → "Alex"). For inboxes like `info@…`, add them to `PERSONA_NAMES`, and add full names and titles to `SIGNERS`, both in [`src/core.ts`](src/core.ts).

## Google sign-in for "Add inbox" (optional)

Without this, inboxes connect with Google app passwords (2-Step Verification on, then myaccount.google.com/apppasswords).

1. console.cloud.google.com: create a project and enable the **Gmail API**.
2. Google Auth Platform → Branding: home page = the app URL, privacy policy = `<app URL>/privacy.html` (fill in the placeholders in [`public/privacy.html`](public/privacy.html) first), authorised domain = the app's domain. Audience: **External**, then **Publish app** so it says In production; otherwise connected inboxes sign out after 7 days.
3. Clients → Create client → Web application, with redirect URI `<app URL>/api/google`.
4. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in Vercel and redeploy.

If sign-in says access is blocked, that Workspace's admin blocks unknown apps: allowlist the client ID in admin.google.com → Security → API controls → App access control.

## Loading leads and campaigns

```bash
python3 scripts/convert_leads.py "/path/to/leads.xlsx"            # writes data/leads.json
node --env-file=.env.local scripts/seed_supabase.mjs             # loads it into Supabase
node --env-file=.env.local scripts/import_campaign.mjs data/sequence.json   # optional: a sequence written outside the app
```

Leads are keyed by email, so re-importing keeps tracking. Campaigns can also be written in the app. READY leads send automatically, CHECK FIRST leads after approval, DO NOT SEND never. A reply stops that lead's sequence.

Keep lead files in `data/`, which is git-ignored.

## Optional extras

- `ANTHROPIC_API_KEY`: Claude sorts replies (keyword rules without it). The prompt is in [`api/_lib/claude.ts`](api/_lib/claude.ts).
- `SMARTLEAD_API_KEY`: copies Smartlead warm-up stats onto the sender pages. Don't run Smartlead campaigns from the same inboxes.
- `SEED_PASSWORD`: Gmail seed accounts for the daily inbox placement test.

## Security

- Lead data lives only in Supabase (behind login) and the git-ignored `data/` folder. It is never bundled into the site.
- Row-level security lets only signed-in users read or change data.
- Keys and inbox passwords live only in Vercel's server-side env vars, used by `api/`.
