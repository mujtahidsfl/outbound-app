-- Inboxes connected with "Add inbox" (Google sign-in). Run once in the Supabase SQL editor.
-- Until this runs nothing changes: inboxes keep signing in with their app passwords.
create table if not exists public.inbox_google (
  inbox         text primary key,
  refresh_token text not null,                    -- encrypted by the server (api/_lib/google.ts)
  connected_at  timestamptz not null default now()
);

-- No policies on purpose: only the server (service role) can read this table.
alter table public.inbox_google enable row level security;
