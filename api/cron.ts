// Scheduled jobs, triggered every few minutes by Supabase pg_cron (Vercel Hobby crons only run daily).
//   /api/cron?job=send      autopilot: send what's due, paced across the send window; also sends scheduled replies, reminders
//                           and the end-of-day email
//   /api/cron?job=replies   check every inbox for replies, opt-outs and bounces; also runs the morning inbox placement test
//                           and copies warm-up stats from Smartlead
import { autopilotRun } from './_lib/autopilot.js'
import { loadSettings } from './_lib/db.js'
import { errorMessage, json, requireEnv } from './_lib/env.js'
import { runDailyDigest } from './_lib/digest.js'
import { runInboxTimers } from './_lib/reply.js'
import { syncReplies, within } from './_lib/replies.js'
import { seedRun } from './_lib/seed.js'
import { syncWarmup } from './_lib/smartlead.js'

async function handle(request: Request) {
  try {
    if (request.headers.get('authorization') !== `Bearer ${requireEnv('CRON_SECRET')}`) return json({ error: 'Unauthorized' }, 401)
    const job = new URL(request.url).searchParams.get('job')
    if (job === 'send') {
      // Replies you scheduled go out whether or not sending is on.
      const settings = await loadSettings()
      const timers = await runInboxTimers(settings).catch(e => [errorMessage(e)])
      const digest = await runDailyDigest(settings).catch(e => [`end-of-day email failed: ${errorMessage(e)}`])
      return json({ ...(await autopilotRun()), timers, digest })
    }
    if (job === 'replies') {
      const [replies, seed, warmup] = await Promise.all([
        syncReplies(),
        // Side jobs stop being waited on at 45s, so the reply check always finishes inside Vercel's 60s.
        within(45_000, 'seed test took over 45s', seedRun()).catch(e => ({ error: errorMessage(e) })),
        within(45_000, 'warm-up sync took over 45s', loadSettings().then(s => syncWarmup(s))).catch(e => ({ error: errorMessage(e) })),
      ])
      return json({ ...replies, seedTest: seed, warmup })
    }
    return json({ error: 'Unknown job' }, 400)
  } catch (e) {
    return json({ error: errorMessage(e) }, 500)
  }
}

export const GET = handle
export const POST = handle
