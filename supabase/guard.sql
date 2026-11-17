-- Deliverability guard and alerts: autopilot raises an alert when sends keep failing or the domain's
-- SPF/DKIM disappear (it never pauses or caps an inbox). Also each inbox's own warm-up start date.
-- state, cap, reason, since, cleared_at and dns_fails are no longer used by the app.
-- Run once in Supabase → SQL Editor, after sending.sql. Safe to re-run.

create table if not exists public.inbox_guard (
  inbox        text primary key,                 -- an inbox address, or '*' for every inbox
  warmup_start date,                             -- this inbox's warm-up week 1 (set on its first send)
  state        text not null default 'ok' check (state in ('ok', 'hold', 'paused')),
  cap          int,                              -- hold: daily cap frozen at this until bounces settle
  reason       text,
  since        timestamptz,                      -- when the current hold / pause started
  cleared_at   timestamptz,                      -- last manual resume: bounce rates only count sends after it
  dns_fails    int not null default 0,           -- consecutive hourly DNS checks with SPF or DKIM missing
  checked_at   timestamptz,                      -- '*' row: last hourly DNS check
  updated_at   timestamptz not null default now()
);

drop trigger if exists inbox_guard_touch on public.inbox_guard;
create trigger inbox_guard_touch before update on public.inbox_guard
  for each row execute function public.touch_row();

-- The '*' row covers every inbox. Each inbox starts its own warm-up on its first send.
insert into public.inbox_guard (inbox, warmup_start) values ('*', null)
on conflict (inbox) do nothing;

-- Signed-in users see the guard and can resume an inbox; the server (service key) does the rest.
alter table public.inbox_guard enable row level security;
drop policy if exists "inbox guard read"   on public.inbox_guard;
drop policy if exists "inbox guard update" on public.inbox_guard;
create policy "inbox guard read"   on public.inbox_guard for select to authenticated using (true);
create policy "inbox guard update" on public.inbox_guard for update to authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'inbox_guard') then
    alter publication supabase_realtime add table public.inbox_guard;
  end if;
end $$;

-- Alerts: every problem the guard notices, from early symptoms (bounces rising, a failed send, few opens) to pauses.
-- One open alert per key; it resolves by itself once the problem is gone.
create table if not exists public.alerts (
  id          bigserial primary key,
  key         text not null,                    -- e.g. bounces:alex@yourdomain.com, send-fail:*, dns:yourdomain.com
  level       text not null check (level in ('warn', 'critical')),
  title       text not null,
  detail      text,
  inbox       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  resolved_at timestamptz,
  seen_at     timestamptz,
  emailed_at  timestamptz
);
create unique index if not exists alerts_open_key on public.alerts (key) where resolved_at is null;
create index if not exists alerts_created_idx on public.alerts (created_at desc);

alter table public.alerts enable row level security;
drop policy if exists "alerts read"   on public.alerts;
drop policy if exists "alerts update" on public.alerts;
create policy "alerts read"   on public.alerts for select to authenticated using (true);
create policy "alerts update" on public.alerts for update to authenticated using (true) with check (true);

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'alerts') then
    alter publication supabase_realtime add table public.alerts;
  end if;
end $$;
