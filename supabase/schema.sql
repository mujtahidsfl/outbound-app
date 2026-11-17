-- Outbound: run this once in Supabase → SQL Editor.
-- Safe to re-run: every statement is idempotent.

-- ---------- tables ----------

create table if not exists public.leads (
  id                text primary key,          -- lowercased email
  sort_order        int  not null,             -- priority order from the spreadsheet
  wave              int,
  niche_group       text,
  score             int,
  hook              text,
  pitch_angle       text,
  email_type        text,
  business_name     text,
  industry          text,
  niche             text,
  specific_category text,
  what_they_do      text,
  city              text,
  address           text,
  rating            numeric,
  reviews           int,
  website_status    text,
  website           text,
  why_outdated      text,
  email             text not null,
  email_found_at    text,
  google_maps       text
);
create index if not exists leads_sort_order_idx on public.leads (sort_order);

create table if not exists public.lead_tracking (
  lead_id     text primary key references public.leads (id) on delete cascade,
  sent_at     date,
  follow_ups  date[] not null default '{}',
  replied_at  date,
  bad_reason  text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid() references auth.users (id) on delete set null
);

-- Media (mockups, screenshots, videos) per lead. Added later, so ALTER keeps re-runs safe on existing projects.
alter table public.lead_tracking add column if not exists media_done boolean not null default false;
alter table public.lead_tracking add column if not exists media      jsonb   not null default '[]'::jsonb;
-- Sending inbox for the lead's sequence (first email and follow-ups).
alter table public.lead_tracking add column if not exists inbox      text;

-- One shared row holding templates, cadence and the daily target.
create table if not exists public.app_settings (
  id         int primary key default 1 check (id = 1),
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.app_settings (id) values (1) on conflict do nothing;

-- ---------- updated_at / updated_by ----------

create or replace function public.touch_row() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_table_name = 'lead_tracking' then
    new.updated_by := coalesce(auth.uid(), new.updated_by);
  end if;
  return new;
end $$;

drop trigger if exists lead_tracking_touch on public.lead_tracking;
create trigger lead_tracking_touch before insert or update on public.lead_tracking
  for each row execute function public.touch_row();

drop trigger if exists app_settings_touch on public.app_settings;
create trigger app_settings_touch before update on public.app_settings
  for each row execute function public.touch_row();

-- ---------- row level security: signed-in users only ----------

alter table public.leads         enable row level security;
alter table public.lead_tracking enable row level security;
alter table public.app_settings  enable row level security;

drop policy if exists "leads read"      on public.leads;
drop policy if exists "tracking all"    on public.lead_tracking;
drop policy if exists "settings read"   on public.app_settings;
drop policy if exists "settings update" on public.app_settings;

create policy "leads read"      on public.leads         for select to authenticated using (true);
create policy "tracking all"    on public.lead_tracking for all    to authenticated using (true) with check (true);
create policy "settings read"   on public.app_settings  for select to authenticated using (true);
create policy "settings update" on public.app_settings  for update to authenticated using (true) with check (true);

-- ---------- media storage: private bucket, signed-in users only ----------

insert into storage.buckets (id, name, public) values ('lead-media', 'lead-media', false)
  on conflict (id) do nothing;

drop policy if exists "lead media read"   on storage.objects;
drop policy if exists "lead media upload" on storage.objects;
drop policy if exists "lead media delete" on storage.objects;

create policy "lead media read"   on storage.objects for select to authenticated using (bucket_id = 'lead-media');
create policy "lead media upload" on storage.objects for insert to authenticated with check (bucket_id = 'lead-media');
create policy "lead media delete" on storage.objects for delete to authenticated using (bucket_id = 'lead-media');

-- ---------- realtime: teammates see each other's changes live ----------

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'lead_tracking') then
    alter publication supabase_realtime add table public.lead_tracking;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'app_settings') then
    alter publication supabase_realtime add table public.app_settings;
  end if;
end $$;

-- Sending through the Titan inboxes (SMTP/IMAP). Run once in Supabase → SQL Editor. Safe to re-run.

-- Every email the app sends. (lead_id, step) is claimed before sending so nothing goes out twice.
create table if not exists public.email_messages (
  id          bigserial primary key,
  lead_id     text references public.leads (id) on delete cascade,  -- null for test emails
  step        int  not null,                                         -- 0 = first email, n = follow-up n
  inbox       text not null,
  to_email    text not null,
  subject     text,
  message_id  text unique,
  status      text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  error       text,
  source      text not null default 'manual',                        -- manual | autopilot | test
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  unique (lead_id, step)
);
create index if not exists email_messages_created_idx on public.email_messages (created_at desc);

-- Replies, opt-outs, out-of-office auto-replies and bounces found in the inboxes.
create table if not exists public.email_events (
  id          bigserial primary key,
  lead_id     text references public.leads (id) on delete cascade,
  inbox       text not null,
  kind        text not null check (kind in ('reply', 'unsubscribe', 'auto', 'bounce')),
  from_email  text,
  subject     text,
  snippet     text,
  message_id  text not null,
  received_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (inbox, message_id)
);
create index if not exists email_events_created_idx on public.email_events (created_at desc);

-- How far each inbox has been read, so every check only looks at new mail.
create table if not exists public.inbox_state (
  inbox        text primary key,
  last_uid     bigint not null default 0,
  uid_validity text,
  checked_at   timestamptz,
  error        text
);

-- Signed-in users can read these (activity log); only the server writes them.
alter table public.email_messages enable row level security;
alter table public.email_events   enable row level security;
alter table public.inbox_state    enable row level security;

drop policy if exists "email messages read" on public.email_messages;
drop policy if exists "email events read"   on public.email_events;
drop policy if exists "inbox state read"    on public.inbox_state;

create policy "email messages read" on public.email_messages for select to authenticated using (true);
create policy "email events read"   on public.email_events   for select to authenticated using (true);
create policy "inbox state read"    on public.inbox_state    for select to authenticated using (true);
