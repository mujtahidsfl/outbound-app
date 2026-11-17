// Autopilot: called every few minutes; each inbox sends at most one email per run, paced across the send window.
// Only leads in an active campaign are sent to; the rest of the lead list is never emailed automatically.
import { FREE_MAIL, campaignEligible, campaignWindow, derive, footerReady, inboxCap, inboxTotal, sendWindow, sentByInbox, today } from '../../src/core.js'
import type { Campaign } from '../../src/types.ts'
import { db, inboxSchema, loadCampaigns, loadMembers, loadSettings, loadTracks } from './db.js'
import { errorMessage } from './env.js'
import { loginInboxes } from './google.js'
import { syncAlerts } from './alerts.js'
import { runGuard } from './guard.js'
import { runLoomNudges } from './loom.js'
import { runSubsequences, stoppedLeads } from './subsequence.js'
import { sendToLead, type SendResult } from './send.js'

const MIN_SENDS_TO_JUDGE = 30
// Follow-ups get at most this share of each inbox's day while first emails are waiting; first emails get the rest.
const FOLLOW_UP_SHARE = 0.5

/** Reputation protection: pause a campaign whose bounce rate reached the limit it was given. Returns what it paused. */
async function protectCampaigns(campaigns: Campaign[]) {
  const out: string[] = []
  if (!(await inboxSchema())) return out
  for (const c of campaigns) {
    const guard = c.config.bounceProtection
    if (c.status !== 'active' || !guard?.enabled) continue
    const since = guard.since ?? '2000-01-01'
    const sends = await db().from('email_messages').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('status', 'sent').gte('sent_at', since)
    const bounces = await db().from('email_events').select('id', { count: 'exact', head: true }).eq('campaign_id', c.id).eq('kind', 'bounce').gte('created_at', since)
    const n = sends.count ?? 0, b = bounces.count ?? 0
    if (n < MIN_SENDS_TO_JUDGE || (100 * b) / n < guard.threshold) continue
    const pausedReason = `Bounces reached ${((100 * b) / n).toFixed(1)}% (${b} of ${n}), over the ${guard.threshold}% limit.`
    c.status = 'paused'
    c.config = { ...c.config, pausedReason }
    await db().from('campaigns').update({ status: 'paused', config: c.config }).eq('id', c.id)
    out.push(`${c.name}: ${pausedReason}`)
  }
  return out
}

/**
 * One autopilot pass. `manual` is the dashboard's "Send due now": it ignores the on/off switch,
 * the send window and pacing, but still sends at most one email per inbox and respects every cap.
 */
export async function autopilotRun({ manual = false, now = new Date() } = {}) {
  const settings = await loadSettings()
  if (!manual && !settings.autopilot) return { skipped: 'Autopilot is off' }
  // Deliverability alerts are refreshed each pass. They never stop sending; a guard error is reported but doesn't stop the pass.
  let guard: string[] = []
  try {
    const g = await runGuard(settings, now)
    guard = await syncAlerts(g.alerts, g.skipped)
  } catch (e) {
    guard = [`Guard check failed: ${errorMessage(e)}`]
  }
  const window = manual ? { open: true, fraction: 1 } : sendWindow(settings, now)
  if (!footerReady(settings)) return { skipped: 'Company name and mailing address are not set' }
  const day = today()
  const all = await loadCampaigns()
  const protection = await protectCampaigns(all).catch(e => [`Reputation check failed: ${errorMessage(e)}`])
  // Loom nudges go out whether or not a campaign is running; they and subsequences keep to the app-wide window.
  const loom = window.open ? await runLoomNudges(settings).catch(e => [`Loom nudges failed: ${errorMessage(e)}`]) : []
  const subsequences = window.open ? await runSubsequences(settings, all).catch(e => [`Subsequences failed: ${errorMessage(e)}`]) : []

  // Each campaign keeps its own schedule; one with none set follows the app-wide window.
  const live = all.filter(c => c.status === 'active' && (!c.startDate || c.startDate <= day))
  const campaigns = new Map<string, Campaign>(live.filter(c => manual || campaignWindow(c, settings, now).open).map(c => [c.id, c]))
  if (!live.length) return { skipped: 'No active campaign today', loom, subsequences, protection }
  if (!campaigns.size) return { skipped: `Outside the send window (${window.reason ?? 'campaign schedules'})`, loom, subsequences, protection }
  const fraction = manual ? 1 : Math.max(...[...campaigns.values()].map(c => campaignWindow(c, settings, now).fraction))
  const members = (await loadMembers()).filter(m => campaigns.has(m.campaignId))
  const memberOf = new Map(members.map(m => [m.leadId, m]))

  const tracks = await loadTracks()
  const counts = sentByInbox(tracks, day)
  const firstToday = new Map<string, number>()
  const followToday = new Map<string, number>()
  for (const [id, t] of Object.entries(tracks)) {
    const c = memberOf.get(id)?.campaignId
    if (!c) continue
    if (t.sentAt === day) firstToday.set(c, (firstToday.get(c) ?? 0) + 1)
    const follows = t.followUps.filter(d => d === day).length
    if (follows) followToday.set(c, (followToday.get(c) ?? 0) + follows)
  }
  const stopped = await stoppedLeads([...campaigns.values()]).catch(() => new Set<string>())
  // Emails to each company domain over the last day, for campaigns with a domain limit.
  const byDomain = new Map<string, number>()
  const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? ''
  if ([...campaigns.values()].some(c => c.config.domainDailyLimit)) {
    const { data } = await db().from('email_messages').select('to_email').eq('status', 'sent').gte('sent_at', new Date(now.getTime() - 864e5).toISOString())
    for (const m of data ?? []) byDomain.set(domainOf(m.to_email), (byDomain.get(domainOf(m.to_email)) ?? 0) + 1)
  }
  const picked = new Set<string>()
  const jobs: { inbox: string; leadId: string; delayMs: number }[] = []
  const notes: Record<string, string> = {}

  const ready = await loginInboxes(settings.inboxes)
  for (const inbox of settings.inboxes) {
    if (!ready.has(inbox)) { notes[inbox] = 'no login'; continue }
    const cap = inboxCap(settings, inbox, day)
    const sent = inboxTotal(counts[inbox])
    // Spread the cap evenly across the window, and skip some runs at random so sends don't land on a fixed beat.
    const allowedByNow = Math.min(cap, Math.floor(cap * fraction) + 1)
    if (sent >= cap) { notes[inbox] = `cap reached (${sent}/${cap})`; continue }
    if (!manual && sent >= allowedByNow) { notes[inbox] = `pacing (${sent}/${allowedByNow} so far)`; continue }
    if (!manual && Math.random() < 0.2) { notes[inbox] = 'skipped this run (jitter)'; continue }
    // An inbox behind its pace (skipped runs, or a late start) sends two this run, the second a little later, so it still
    // reaches its cap by the end of the window. One send per 5-minute run tops out around 77 a day.
    const room = manual ? 1 : Math.min(cap, allowedByNow) - sent
    const perRun = room >= 2 ? 2 : 1
    for (let k = 0; k < perRun; k++) {

    // The next uncontacted lead a campaign can start from this inbox (unassigned, or already assigned to it).
    const fresh = (m: (typeof members)[number]) => {
      const c = campaigns.get(m.campaignId)!
      if (picked.has(m.leadId) || stopped.has(m.leadId) || !campaignEligible(m, c)) return false
      if (c.config.inboxes?.length && !c.config.inboxes.includes(inbox)) return false
      if (c.config.newLeadsPerDay != null && (firstToday.get(c.id) ?? 0) >= c.config.newLeadsPerDay) return false
      const domain = domainOf(m.toEmail)
      if (c.config.domainDailyLimit && !FREE_MAIL.test(domain) && (byDomain.get(domain) ?? 0) >= c.config.domainDailyLimit) return false
      const t = tracks[m.leadId]
      return !t || (!t.sentAt && !t.badReason && !t.repliedAt && (!t.inbox || t.inbox === inbox))
    }
    // A campaign's share for follow-ups is used up: new leads go first until they run out.
    const overShare = (c: Campaign) => {
      const share = c.config.followUpShare ?? 100
      if (share >= 100) return false
      const f = followToday.get(c.id) ?? 0
      return (100 * (f + 1)) / (f + 1 + (firstToday.get(c.id) ?? 0)) > share && members.some(m => m.campaignId === c.id && fresh(m))
    }

    // Due follow-ups from this inbox come first, oldest due date first (unless the campaign has follow-ups paused).
    const due = Object.entries(tracks)
      .filter(([id, t]) => t.inbox === inbox && !picked.has(id))
      .flatMap(([id, t]) => {
        const m = memberOf.get(id)
        const c = campaigns.get(m?.campaignId ?? '')
        // A lead stopped after its first email (DO NOT SEND, unapproved) would otherwise block this inbox every run.
        if (!m || !c || c.followUpsPaused || stopped.has(id) || !campaignEligible(m, c) || overShare(c)) return []
        const d = derive(t, c.cadence, day)
        return d.status === 'due' ? [{ id, due: d.nextDue! }] : []
      })
      .sort((a, b) => a.due.localeCompare(b.due))
    // Once follow-ups have used their share of this inbox's day, first emails go next; follow-ups take whatever they leave.
    const followFull = (counts[inbox]?.follow ?? 0) >= Math.ceil(cap * FOLLOW_UP_SHARE)
    let leadId: string | undefined = followFull ? undefined : due[0]?.id

    // Otherwise a new lead. Active campaigns take turns: the one with the fewest first emails today goes next, so a
    // later campaign isn't stuck behind an earlier one.
    if (!leadId) {
      const next = [...campaigns.keys()]
        .sort((a, b) => (firstToday.get(a) ?? 0) - (firstToday.get(b) ?? 0))
        .map(id => members.find(m => m.campaignId === id && fresh(m)))
        .find(m => m)
      if (next) {
        leadId = next.leadId
        firstToday.set(next.campaignId, (firstToday.get(next.campaignId) ?? 0) + 1)
        byDomain.set(domainOf(next.toEmail), (byDomain.get(domainOf(next.toEmail)) ?? 0) + 1)
      }
    }
    if (!leadId) leadId = due[0]?.id
    if (leadId && leadId === due[0]?.id) {
      const c = memberOf.get(leadId)!.campaignId
      followToday.set(c, (followToday.get(c) ?? 0) + 1)
    }
    if (!leadId) { if (!k) notes[inbox] = 'nothing to send'; break }
    picked.add(leadId)
    jobs.push({ inbox, leadId, delayMs: k ? 5_000 + Math.floor(Math.random() * 10_000) : 0 })
    }
  }

  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
  const results = await Promise.allSettled(jobs.map(async ({ delayMs, ...j }) => {
    if (delayMs) await wait(delayMs)
    return sendToLead({ ...j, source: manual ? 'manual' : 'autopilot', settings, tracks })
  }))
  const sent: SendResult[] = results.map((r, i) =>
    r.status === 'fulfilled' ? r.value : { ok: false, leadId: jobs[i].leadId, error: String(r.reason) })
  return { window, sent, notes, guard, loom, subsequences, protection }
}
