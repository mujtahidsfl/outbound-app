-- Master inbox, campaign builder, sender account stats and pipeline automation.
-- Run once in Supabase → SQL Editor, after every other SQL file. Safe to re-run. It only adds columns and tables.
-- Until it runs the app keeps sending as before; the new features switch on by themselves afterwards.

-- ---------- full emails ----------

-- Replies stored in full (older ones fill in by themselves on the next reply checks).
alter table public.email_events add column if not exists body_text     text;
-- Who sorted the reply: claude | rules | manual. Rule-sorted replies are re-read once a Claude key is added.
alter table public.email_events add column if not exists classified_by text;
-- When you were emailed about this reply, so nobody gets told twice.
alter table public.email_events add column if not exists notified_at   timestamptz;

-- The text of every email sent, and hand-written replies (from this app or from Gmail) tied to their lead.
-- lead_id stays null on those: (lead_id, step) is the one-email-per-step claim of the sequence.
alter table public.email_messages add column if not exists body_text      text;
alter table public.email_messages add column if not exists thread_lead_id text references public.leads (id) on delete cascade;
create index if not exists email_messages_thread_idx on public.email_messages (thread_lead_id);

-- ---------- click tracking ----------

alter table public.email_messages add column if not exists clicked_at  timestamptz;
alter table public.email_messages add column if not exists click_count int not null default 0;

-- Called by /api/click with the service key.
create or replace function public.record_email_click(p_id bigint) returns void
language sql security definer set search_path = public as $$
  update public.email_messages
     set click_count = click_count + 1, clicked_at = coalesce(clicked_at, now())
   where id = p_id and status = 'sent';
$$;
revoke execute on function public.record_email_click(bigint) from public, anon, authenticated;

-- ---------- campaign builder ----------

-- { folder, sequence, inboxes, subsequences, schedule, tracking, reputation... }, see CampaignConfig in src/types.ts.
alter table public.campaigns      add column if not exists config jsonb not null default '{}'::jsonb;
-- Extra columns from an uploaded lead list, used as {{variables}} in the sequence.
alter table public.campaign_leads add column if not exists vars   jsonb not null default '{}'::jsonb;

-- A lead's place in a campaign's conditional follow-up sequence. Its emails are email_messages steps 200+.
create table if not exists public.subsequence_runs (
  lead_id        text primary key references public.leads (id) on delete cascade,
  campaign_id    text not null references public.campaigns (id) on delete cascade,
  subsequence_id text not null,
  status         text not null default 'active' check (status in ('active', 'done', 'stopped')),
  enrolled_at    timestamptz not null default now()
);
create index if not exists subsequence_runs_status_idx on public.subsequence_runs (status);

-- ---------- master inbox ----------

-- Your state of each conversation (one per lead).
create table if not exists public.inbox_threads (
  lead_id       text primary key references public.leads (id) on delete cascade,
  unread        boolean not null default true,
  important     boolean not null default false,
  archived_at   timestamptz,
  snoozed_until timestamptz,
  remind_at     timestamptz,
  remind_note   text,
  reminded_at   timestamptz,
  updated_at    timestamptz not null default now()
);

-- Replies written now and sent later.
create table if not exists public.scheduled_emails (
  id         bigserial primary key,
  lead_id    text not null references public.leads (id) on delete cascade,
  inbox      text not null,
  to_email   text not null,
  subject    text not null,
  body       text not null,
  send_at    timestamptz not null,
  status     text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'canceled', 'failed')),
  error      text,
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);
create index if not exists scheduled_emails_due_idx on public.scheduled_emails (status, send_at);

-- ---------- sender accounts ----------

-- One row per inbox per day, copied from Smartlead (warm-up runs there). Smartlead's API only returns the last 7 days,
-- so the app keeps its own history.
create table if not exists public.warmup_stats (
  inbox      text not null,
  day        date not null,
  sent       int  not null default 0,
  received   int  not null default 0,
  inbox_hits int  not null default 0,
  saved      int  not null default 0,
  synced_at  timestamptz not null default now(),
  primary key (inbox, day)
);

-- ---------- access ----------

alter table public.inbox_threads    enable row level security;
alter table public.scheduled_emails enable row level security;
alter table public.warmup_stats     enable row level security;
alter table public.subsequence_runs enable row level security;

drop policy if exists "inbox threads all"     on public.inbox_threads;
drop policy if exists "scheduled emails read" on public.scheduled_emails;
drop policy if exists "warmup stats read"     on public.warmup_stats;
drop policy if exists "subsequence runs read" on public.subsequence_runs;

create policy "inbox threads all"     on public.inbox_threads    for all    to authenticated using (true) with check (true);
create policy "scheduled emails read" on public.scheduled_emails for select to authenticated using (true);
create policy "warmup stats read"     on public.warmup_stats     for select to authenticated using (true);
create policy "subsequence runs read" on public.subsequence_runs for select to authenticated using (true);
