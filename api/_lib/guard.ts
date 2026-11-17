// Deliverability guard, run at the start of every autopilot pass. It only raises alerts (see alerts.ts); it never
// pauses an inbox or holds its cap, so sending is stopped by hand when an alert calls for it:
//   failed sends, inbox blocked/limited by the provider, replies that can't be read, very few opens, many unsubscribes, SPF or DKIM missing, a test email landing in spam.
import { fetchAll } from '../../src/core.js'
import type { Settings } from '../../src/types.ts'
import type { AlertDraft } from './alerts.js'
import { db, saveGuard } from './db.js'
import { checkDomain } from './deliverability.js'
import { isPersonalGmail, TRACK_OPENS } from './env.js'
import { seedAlerts } from './seed.js'

export const GUARD = {
  windowDays: 7,
  dnsEveryMs: 60 * 60_000,
  // Open rates far below normal usually mean the spam folder. Only emails sent over a day ago count.
  opensMinInbox: 40,
  opensLowInbox: 0.1,
  opensMinAll: 100,
  opensLowAll: 0.15,
  optOutMin: 50,
  optOutHigh: 0.05,
}

/** SMTP answers meaning this one recipient doesn't exist: a bounce for that lead, not a problem with the inbox. */
export const RECIPIENT_REJECTED = /\b5\.1\.\d\b|no such (user|mailbox|recipient)|user unknown|unknown (user|recipient)|recipient address rejected|mailbox (unavailable|not found|does ?n.t exist)|address (rejected|not found|does ?n.t exist)/i
/** SMTP answers meaning the provider is blocking, limiting or locking the inbox itself. */
export const BLOCKED = /spam|blocked|blacklist|block ?list|reputation|suspend|disabled|locked|too many|rate limit|limit exceeded|quota|abuse|\b5\.7\.\d\b|authenticat|\b535\b/i

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

export interface GuardResult {
  alerts: AlertDraft[]
  /** Alert key prefixes this pass didn't re-check (left as they are). */
  skipped: string[]
}

/** Check every inbox and return the alerts that should be open right now. */
export async function runGuard(settings: Settings, now = new Date()): Promise<GuardResult> {
  if (!settings.guard) return { alerts: [], skipped: [] } // guard.sql not run yet
  const nowIso = now.toISOString()
  const since = now.getTime() - GUARD.windowDays * 864e5
  const sinceIso = new Date(since).toISOString()
  const alerts: AlertDraft[] = []

  type Sent = { inbox: string; sent_at: string; step: number; tracked?: boolean; opened_at?: string | null }
  const [sends, unsubscribes, attempts, states] = await Promise.all([
    fetchAll<Sent>((from, to) => db().from('email_messages').select(TRACK_OPENS ? 'inbox,sent_at,step,tracked,opened_at' : 'inbox,sent_at,step')
      .eq('status', 'sent').not('lead_id', 'is', null).neq('source', 'test').gte('sent_at', sinceIso).order('id').range(from, to) as unknown as PromiseLike<{ data: Sent[] | null; error: { message: string } | null }>),
    fetchAll<{ inbox: string }>((from, to) => db().from('email_events').select('inbox')
      .eq('kind', 'unsubscribe').gte('created_at', sinceIso).order('id').range(from, to)),
    db().from('email_messages').select('inbox,status,error,created_at').not('lead_id', 'is', null).in('status', ['sent', 'failed'])
      .order('id', { ascending: false }).limit(500),
    db().from('inbox_state').select('inbox,error'),
  ])
  if (attempts.error) throw new Error(attempts.error.message)

  // Bounces raise nothing here: each day's count is on the dashboard and on Mailboxes, and a bounced lead is stopped when it comes in.
  for (const inbox of settings.inboxes) {
    // ---------- failed sends ----------
    // Newest first, leaving out the ones that were just a dead address.
    const own = (attempts.data ?? []).filter(a => a.inbox === inbox && !(a.status === 'failed' && RECIPIENT_REJECTED.test(a.error ?? '')))
    let streak = 0
    while (streak < own.length && own[streak].status === 'failed') streak++
    const last = (own[0]?.error ?? '').replace(/^Send failed: /, '').slice(0, 160)
    if (streak) {
      const blocked = BLOCKED.test(last)
      alerts.push({
        key: `send-fail:${inbox}`, level: blocked || streak >= 3 ? 'critical' : 'warn', inbox,
        title: blocked ? `The mail server is refusing ${inbox}` : `${streak === 1 ? 'A send' : `${streak} sends in a row`} from ${inbox} failed`,
        detail: `The mail server said: ${last}. A one-off timeout is normal; a wrong password or a block from the mail provider is not. Turn the inbox off yourself if it keeps happening.`,
      })
    }
  }

  // ---------- replies can't be read ----------
  for (const s of (states.data ?? []) as { inbox: string; error: string | null }[]) {
    if (!s.error || !settings.inboxes.includes(s.inbox)) continue
    alerts.push({
      key: `imap:${s.inbox}`, level: 'warn', inbox: s.inbox,
      title: `Can't check replies for ${s.inbox}`,
      detail: `Reading the inbox failed: ${s.error.slice(0, 200)}. Until it works again, replies, unsubscribes and bounces sent to it aren't seen, so follow-ups could still go to people who said no.`,
    })
  }

  // ---------- opens far below normal: probably the spam folder ----------
  if (TRACK_OPENS) {
    const dayAgo = now.getTime() - 864e5
    const aged = sends.filter(s => s.tracked && Date.parse(s.sent_at) < dayAgo)
    const low = (key: string, list: Sent[], min: number, floor: number) => {
      const opened = list.filter(s => s.opened_at).length
      if (list.length < min || opened / list.length >= floor) return
      alerts.push({
        key: `opens:${key}`, level: 'warn', inbox: key === '*' ? null : key,
        title: `Very few opens on ${key === '*' ? 'all inboxes' : key}: ${pct(opened / list.length)}`,
        detail: `${opened} of ${list.length} tracked emails sent 1–${GUARD.windowDays} days ago were opened. Cold email usually opens at 30%+, so these are likely landing in spam. Send a test to your own Gmail and Outlook and see which folder it lands in.`,
      })
    }
    low('*', aged, GUARD.opensMinAll, GUARD.opensLowAll)
    for (const inbox of settings.inboxes) low(inbox, aged.filter(s => s.inbox === inbox), GUARD.opensMinInbox, GUARD.opensLowInbox)
  }

  // ---------- many people asking to stop: spam-complaint risk ----------
  const firsts = sends.filter(s => s.step === 0).length
  const optOuts = unsubscribes.length
  if (firsts >= GUARD.optOutMin && optOuts / firsts >= GUARD.optOutHigh) {
    alerts.push({
      key: 'optout:*', level: 'warn', inbox: null,
      title: `${pct(optOuts / firsts)} of new leads asked to unsubscribe`,
      detail: `${optOuts} unsubscribes against ${firsts} first emails in ${GUARD.windowDays} days. People who want out but can't find how click "Report spam", which hurts every inbox. Check the targeting and Email 1.`,
    })
  }

  // ---------- SPF/DKIM, once an hour ----------
  const skipped: string[] = []
  const star = await db().from('inbox_guard').select('checked_at').eq('inbox', '*').maybeSingle()
  if (now.getTime() - (Date.parse(star.data?.checked_at ?? '') || 0) >= GUARD.dnsEveryMs) {
    // gmail.com is Google's own domain: nothing to set up, and its DKIM selectors change, so it's not checked.
    const domains = [...new Set(settings.inboxes.filter(i => !isPersonalGmail(i)).map(i => i.split('@')[1]).filter(Boolean))]
    const checks = await Promise.all(domains.map(d => checkDomain(d).catch(() => null)))
    checks.forEach((c, i) => {
      const domain = domains[i]
      if (!c) { skipped.push(`dns:${domain}`); return }
      // A failed lookup (c.unchecked) isn't a missing record, so it never raises this alert.
      const missing = [c.spfCoversSending === false && 'SPF', !c.dkimSelector && !c.unchecked.includes('DKIM') && 'DKIM'].filter(Boolean).join(' and ')
      if (!missing) return
      const inboxes = settings.inboxes.filter(x => x.endsWith(`@${domain}`))
      alerts.push({
        key: `dns:${domain}`, level: 'warn', inbox: null,
        title: `${missing} not found on ${domain}`,
        detail: `The hourly DNS check couldn't find ${missing} for ${domain}. Without it, emails from ${inboxes.join(', ')} land in spam. Check that domain's DNS records.`,
      })
    })
    await saveGuard('*', { checked_at: nowIso })
  } else skipped.push('dns:')

  // ---------- this morning's inbox placement test (seed.ts) ----------
  const seeds = await seedAlerts(settings).catch(() => null)
  if (seeds) alerts.push(...seeds)
  else skipped.push('seed:')

  return { alerts, skipped }
}
