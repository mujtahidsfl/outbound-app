-- Campaigns: a per-lead written sequence, its screenshots and its tracking.
-- Run once in Supabase → SQL Editor, after schema.sql and sending.sql. Safe to re-run.

create table if not exists public.campaigns (
  id                text primary key,
  name              text not null,
  status            text not null default 'paused' check (status in ('active', 'paused', 'done')),
  -- Follow-ups (every step after the first email) wait while this is on; first emails keep going.
  follow_ups_paused boolean not null default true,
  -- Autopilot sends nothing for this campaign before this ET date (YYYY-MM-DD).
  start_date        date,
  -- Days to wait after the previous email before each follow-up, e.g. {3,4,4} = day 0, 3, 7, 11.
  cadence           int[] not null default '{3,4,4}',
  -- [{ "n": 1, "day": 0, "thread": "new" | "reply", "replyTo": 2, "attachImages": true }]
  steps             jsonb not null default '[]'::jsonb,
  -- Screenshots in the campaign-media bucket: [{ "name", "path", "type", "size" }]
  images            jsonb not null default '[]'::jsonb,
  -- Optional subject-line B test per email: { "1": "q: {name}?", "2": "..." }. Empty = everyone gets the written subject.
  subject_b         jsonb not null default '{}'::jsonb,
  -- Which send statuses go out without a manual approve.
  auto_statuses     text[] not null default '{READY}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.campaign_leads (
  campaign_id   text not null references public.campaigns (id) on delete cascade,
  lead_id       text not null references public.leads (id) on delete cascade,
  position      int  not null,                      -- send order within the campaign
  lead_no       int,                                -- "Lead #" in the source document
  send_status   text not null,                      -- READY | CHECK FIRST | DO NOT SEND
  approved      boolean not null default false,     -- CHECK FIRST leads only send once approved
  to_email      text not null,                      -- cleaned address the campaign sends to
  business_name text,
  short_name    text,
  trade         text,
  city          text,
  rating        numeric,
  reviews       int,
  website       text,
  offer         text,
  tier          text,
  price         int,
  checks        text[] not null default '{}',
  icebreaker    text,                               -- family-run | seasonal/local
  subject_noun  text,                               -- jobs | clients | patients | customers
  subject_owner text,                               -- owner's first name when the subject opens with it
  emails        jsonb not null,                     -- [{ "step": 1, "day": 0, "thread", "replyTo", "subject", "body" }]
  primary key (campaign_id, lead_id)
);
-- A lead is in at most one campaign, so its tracking row always means one sequence.
create unique index if not exists campaign_leads_lead_idx on public.campaign_leads (lead_id);
create index if not exists campaign_leads_order_idx on public.campaign_leads (campaign_id, position);
create index if not exists campaign_leads_email_idx on public.campaign_leads (lower(to_email));

-- Tracking columns on the existing tables.
alter table public.email_messages add column if not exists campaign_id     text;
alter table public.email_messages add column if not exists subject_variant text;      -- A | B
alter table public.email_messages add column if not exists attachments     int not null default 0;
create index if not exists email_messages_campaign_idx on public.email_messages (campaign_id);

alter table public.email_events add column if not exists campaign_id text;
alter table public.email_events add column if not exists step        int;             -- which email they answered (0 = Email 1)
alter table public.email_events add column if not exists intent      text;            -- loom | interested | question | not_interested | other
create index if not exists email_events_campaign_idx on public.email_events (campaign_id);

-- Pipeline after a reply: replied → loom_requested → loom_sent → call_booked → proposal → won | lost | not_interested.
alter table public.lead_tracking add column if not exists stage      text;
alter table public.lead_tracking add column if not exists stage_log  jsonb not null default '{}'::jsonb;  -- { stage: ISO timestamp }
alter table public.lead_tracking add column if not exists deal_value numeric;

drop trigger if exists campaigns_touch on public.campaigns;
create trigger campaigns_touch before update on public.campaigns
  for each row execute function public.touch_row();

-- Signed-in users read everything and can pause/resume, upload screenshots, approve leads and set intents.
alter table public.campaigns      enable row level security;
alter table public.campaign_leads enable row level security;

drop policy if exists "campaigns read"        on public.campaigns;
drop policy if exists "campaigns update"      on public.campaigns;
drop policy if exists "campaign leads read"   on public.campaign_leads;
drop policy if exists "campaign leads update" on public.campaign_leads;
drop policy if exists "email events update"   on public.email_events;

create policy "campaigns read"        on public.campaigns      for select to authenticated using (true);
create policy "campaigns update"      on public.campaigns      for update to authenticated using (true) with check (true);
create policy "campaign leads read"   on public.campaign_leads for select to authenticated using (true);
create policy "campaign leads update" on public.campaign_leads for update to authenticated using (true) with check (true);
create policy "email events update"   on public.email_events   for update to authenticated using (true) with check (true);

-- Screenshots attached to follow-ups: private bucket, signed-in users only (the server reads it with the service key).
insert into storage.buckets (id, name, public) values ('campaign-media', 'campaign-media', false)
  on conflict (id) do nothing;

drop policy if exists "campaign media read"   on storage.objects;
drop policy if exists "campaign media upload" on storage.objects;
drop policy if exists "campaign media delete" on storage.objects;

create policy "campaign media read"   on storage.objects for select to authenticated using (bucket_id = 'campaign-media');
create policy "campaign media upload" on storage.objects for insert to authenticated with check (bucket_id = 'campaign-media');
create policy "campaign media delete" on storage.objects for delete to authenticated using (bucket_id = 'campaign-media');

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'campaigns') then
    alter publication supabase_realtime add table public.campaigns;
  end if;
end $$;
