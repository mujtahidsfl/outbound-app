-- Open tracking: a 1×1 image in each lead email; loading it marks the email opened.
-- Run once in Supabase → SQL Editor, after sending.sql and campaigns.sql. Safe to re-run.

alter table public.email_messages add column if not exists tracked        boolean not null default false;  -- sent with the open pixel
alter table public.email_messages add column if not exists opened_at      timestamptz;                     -- first open
alter table public.email_messages add column if not exists last_opened_at timestamptz;
alter table public.email_messages add column if not exists open_count     int not null default 0;

-- Called by /api/open with the service key. Opens before the send finished are mail scanners, not people.
create or replace function public.record_email_open(p_id bigint) returns void
language sql security definer set search_path = public as $$
  update public.email_messages
     set open_count = open_count + 1, opened_at = coalesce(opened_at, now()), last_opened_at = now()
   where id = p_id and tracked and status = 'sent';
$$;
revoke execute on function public.record_email_open(bigint) from public, anon, authenticated;
