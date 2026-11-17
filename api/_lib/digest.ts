// The end-of-day email: everything that isn't a positive reply (those are emailed the moment they land). Sends, opens,
// other replies, reminders that came due, paused campaigns and deliverability problems, once a day after DIGEST_HOUR ET.
import { TIME_ZONE, isPositive, today } from '../../src/core.js'
import type { Settings } from '../../src/types.ts'
import { db, loadLeads } from './db.js'
import { publicUrl } from './env.js'
import { notifyMe, threadUrl } from './notify.js'

export const DIGEST_HOUR = 18

const LIST = 15
const INTENT: Record<string, string> = { question: 'asked a question', not_interested: 'not interested', other: 'replied', loom: 'wants the Loom', meeting: 'wants a call', interested: 'is interested' }

const etHour = (at: Date) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' }).format(at))

/** Midnight ET on `day`, as an ISO timestamp. */
function etMidnight(day: string) {
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, timeZoneName: 'longOffset' })
    .formatToParts(new Date(`${day}T12:00:00Z`)).find(p => p.type === 'timeZoneName')?.value.replace('GMT', '') || '-05:00'
  return new Date(`${day}T00:00:00${off}`).toISOString()
}

const lines = <T>(rows: T[], show: (r: T) => string) =>
  [...rows.slice(0, LIST).map(show), ...(rows.length > LIST ? [`…and ${rows.length - LIST} more in the app`] : [])].join('\n')

/** Once a day after DIGEST_HOUR ET. Claims the day first so two passes can't both send it. */
export async function runDailyDigest(settings: Settings, now = new Date()): Promise<string[]> {
  if (!settings.alertEmail?.trim() || etHour(now) < DIGEST_HOUR) return []
  const day = today()
  const row = await db().from('app_settings').select('data').eq('id', 1).single()
  if (row.error) return [row.error.message]
  const data = row.data.data as Partial<Settings>
  if (data.digestSentOn === day) return []
  const claim = await db().from('app_settings').update({ data: { ...data, digestSentOn: day } }).eq('id', 1)
    .or(`data->>digestSentOn.is.null,data->>digestSentOn.neq.${day}`).select('id')
  if (!claim.data?.length) return []
  try {
    const d = await buildDigest(day)
    if (!d) return ['end-of-day email skipped: nothing happened today']
    await notifyMe(settings, d.subject, d.text)
    if (d.alertIds.length) await db().from('alerts').update({ emailed_at: new Date().toISOString() }).in('id', d.alertIds)
    return ['end-of-day email sent']
  } catch (e) {
    const cur = await db().from('app_settings').select('data').eq('id', 1).single()
    if (cur.data) await db().from('app_settings').update({ data: { ...cur.data.data, digestSentOn: data.digestSentOn ?? null } }).eq('id', 1)
    throw e
  }
}

/** The day's digest, or null when nothing happened. */
export async function buildDigest(day: string) {
  const since = etMidnight(day)
  const [sent, opened, events, reminders, paused, alerts] = await Promise.all([
    db().from('email_messages').select('id', { count: 'exact', head: true }).eq('status', 'sent').gte('sent_at', since),
    db().from('email_messages').select('to_email,subject,open_count,opened_at').gte('last_opened_at', since).order('last_opened_at', { ascending: false }).limit(200),
    db().from('email_events').select('lead_id,kind,from_email,snippet,intent').gte('created_at', since).order('created_at').limit(500),
    db().from('inbox_threads').select('lead_id,remind_note').gte('reminded_at', since),
    db().from('campaigns').select('name,config').eq('status', 'paused').gte('updated_at', since),
    db().from('alerts').select('id,level,title,detail,created_at').is('resolved_at', null).order('created_at', { ascending: false }),
  ])
  const ev = events.data ?? []
  const replies = ev.filter(e => e.kind === 'reply')
  const good = replies.filter(e => isPositive(e.intent))
  const other = replies.filter(e => !isPositive(e.intent))
  const optOuts = ev.filter(e => e.kind === 'unsubscribe').length
  const bounces = ev.filter(e => e.kind === 'bounce').length
  const opens = opened.data ?? []
  const firstOpens = opens.filter(m => m.opened_at && m.opened_at >= since).length
  const due = reminders.data ?? []
  const stopped = (paused.data ?? []).filter(c => (c.config as { pausedReason?: string })?.pausedReason)
  const problems = alerts.data ?? []
  const sentN = sent.count ?? 0
  if (!sentN && !opens.length && !ev.length && !due.length && !stopped.length && !problems.length) return null

  const leads = new Map((await loadLeads([...new Set(replies.map(r => r.lead_id).filter(Boolean))] as string[])).map(l => [l.id, l]))
  const who = (e: { lead_id: string | null; from_email: string | null }) => (e.lead_id && leads.get(e.lead_id)?.businessName) || e.from_email || e.lead_id || 'Someone'
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })

  const sections = [
    [`Today (${label})`, [
      `Sent: ${sentN}`,
      `Opened: ${opens.length} email${opens.length === 1 ? '' : 's'} (${firstOpens} for the first time)`,
      `Replies: ${replies.length}${good.length ? ` (${good.length} positive, each already emailed to you)` : ''}`,
      ...(optOuts ? [`Opt-outs: ${optOuts}`] : []),
      ...(bounces ? [`Bounces: ${bounces}`] : []),
    ].join('\n')],
    ...(good.length ? [['Positive replies', lines(good, e => `${who(e)} ${INTENT[e.intent!]}`)]] : []),
    ...(other.length ? [['Other replies', lines(other, e => `${who(e)} (${e.from_email}): ${INTENT[e.intent ?? 'other'] ?? 'replied'}\n  "${(e.snippet ?? '').replace(/\s+/g, ' ').slice(0, 200)}"${e.lead_id ? `\n  ${threadUrl(e.lead_id)}` : ''}`)]] : []),
    ...(opens.length ? [['Opened today', lines(opens, m => `${m.to_email}: ${m.subject} (${m.open_count} open${m.open_count === 1 ? '' : 's'} so far)`)]] : []),
    ...(due.length ? [['Reminders that came due', lines(due, r => `${r.lead_id}: ${r.remind_note || 'You set a reminder for this conversation.'}\n  ${threadUrl(r.lead_id)}`)]] : []),
    ...(stopped.length ? [['Campaigns paused', lines(stopped, c => `${c.name}: ${(c.config as { pausedReason: string }).pausedReason}`)]] : []),
    ...(problems.length ? [['Deliverability problems', lines(problems, a => `${a.level === 'critical' ? 'CRITICAL' : 'WARNING'}${a.created_at >= since ? ' (new today)' : ''}: ${a.title}\n  ${a.detail ?? ''}`)]] : []),
  ]
  const text = [...sections.map(([h, b]) => `${h.toUpperCase()}\n${b}`), `Dashboard: ${publicUrl()}`,
    `Positive replies are emailed the moment they land. Everything else waits for this email at ${DIGEST_HOUR - 12} PM ET.`].join('\n\n')
  const subject = `End of day ${label}: ${sentN} sent, ${opens.length} opened, ${replies.length} repl${replies.length === 1 ? 'y' : 'ies'}${problems.length ? `, ${problems.length} problem${problems.length === 1 ? '' : 's'}` : ''}`
  return { subject, text, alertIds: problems.map(a => a.id) }
}
