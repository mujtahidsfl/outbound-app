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
