-- Autopilot every 5 minutes and reply checks every 30 seconds, run by Supabase's pg_cron.
-- Copy this file to supabase/autopilot_cron.sql (git-ignored), put in your app URL and CRON_SECRET,
-- then run it in Supabase → SQL Editor AFTER the site is deployed. The filled-in copy contains a secret: never commit it.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Replace any earlier version of these jobs.
select cron.unschedule(jobname) from cron.job where jobname in ('outbound-send', 'outbound-replies');

select cron.schedule('outbound-send', '*/5 * * * *', $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron?job=send',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  );
$$);

select cron.schedule('outbound-replies', '30 seconds', $$
  select net.http_post(
    url := 'https://YOUR-APP.vercel.app/api/cron?job=replies',
    headers := jsonb_build_object('Authorization', 'Bearer YOUR_CRON_SECRET', 'Content-Type', 'application/json'),
    timeout_milliseconds := 60000
  );
$$);
