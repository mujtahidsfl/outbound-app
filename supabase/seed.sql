-- Inbox placement test: each sending morning every inbox emails the seed Gmail accounts, and the app records
-- which folder each email landed in. Run once in Supabase → SQL Editor. Safe to re-run.

create table if not exists public.seed_tests (
  id          bigserial primary key,
  run         text not null,                     -- the ET date for the daily test, or manual-<time>
  inbox       text not null,                     -- sending inbox
  seed        text not null,                     -- the Gmail account it was sent to
  message_id  text,
  subject     text,
  placement   text not null default 'pending'
              check (placement in ('pending', 'inbox', 'promotions', 'updates', 'social', 'forums', 'spam', 'missing', 'failed')),
  error       text,
  created_at  timestamptz not null default now(),
  sent_at     timestamptz,
  checked_at  timestamptz,
  unique (run, inbox, seed)
);
create index if not exists seed_tests_created_idx on public.seed_tests (created_at desc);

-- Signed-in users see the results; only the server (service key) writes them.
alter table public.seed_tests enable row level security;
drop policy if exists "seed tests read" on public.seed_tests;
create policy "seed tests read" on public.seed_tests for select to authenticated using (true);
