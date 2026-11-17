// Campaign analytics: one row per contacted lead, then the same stats grouped every useful way.
// Pure functions over the campaign's leads, tracking, sent emails and inbox events.
import type { CampaignEvt, CampaignMsg } from '../../../campaigns'
import { FREE_MAIL, TIME_ZONE, inboxPersona, isBooked, isPositive, subjectPattern } from '../../../tracking'
import type { CampaignLead, ReplyIntent, Track, TrackMap } from '../../../types'

export interface LeadRow {
  m: CampaignLead
  t?: Track
  /** Sent emails, by step. */
  sent: CampaignMsg[]
  firstAt?: string
  inbox?: string
  /** Any email to them carried the open pixel / was opened. */
  tracked: boolean
  opened: boolean
  /** First reply: a human one (a reply, or an opt-out written as a reply) if there is one, else an auto-reply. */
  reply?: CampaignEvt
  /** 0-based email they answered. */
  replyStep?: number
  /** How many emails they had received when they replied. */
  afterN?: number
  hoursToReply?: number
  intent?: ReplyIntent
  positive: boolean
  bounced: boolean
  optedOut: boolean
  booked: boolean
  won: boolean
  revenue: number
}

const isLinkUnsub = (e: CampaignEvt) => e.message_id.startsWith('link:')

export function buildRows(members: CampaignLead[], tracks: TrackMap, messages: CampaignMsg[], events: CampaignEvt[]): LeadRow[] {
  const sentBy = new Map<string, CampaignMsg[]>()
  for (const m of messages) {
    if (m.status !== 'sent' || !m.lead_id || m.source === 'test') continue
    if (!sentBy.has(m.lead_id)) sentBy.set(m.lead_id, [])
    sentBy.get(m.lead_id)!.push(m)
  }
  const evBy = new Map<string, CampaignEvt[]>()
  for (const e of events) {
    if (!e.lead_id) continue
    if (!evBy.has(e.lead_id)) evBy.set(e.lead_id, [])
    evBy.get(e.lead_id)!.push(e)
  }
  const rows: LeadRow[] = []
  for (const m of members) {
    const sent = (sentBy.get(m.leadId) ?? []).sort((a, b) => a.step - b.step)
    if (!sent.length) continue
    const t = tracks[m.leadId]
    const evs = (evBy.get(m.leadId) ?? []).sort((a, b) => (a.received_at ?? a.created_at).localeCompare(b.received_at ?? b.created_at))
    // Every reply counts, auto-replies included; a human reply wins so its intent is the one shown.
    const reply = evs.find(e => e.kind === 'reply' || (e.kind === 'unsubscribe' && !isLinkUnsub(e))) ?? evs.find(e => e.kind === 'auto')
    const firstAt = sent[0].sent_at ?? sent[0].created_at
    let replyStep: number | undefined, afterN: number | undefined, hoursToReply: number | undefined
    if (reply) {
      const at = reply.received_at ?? reply.created_at
      afterN = sent.filter(s => (s.sent_at ?? s.created_at) <= at).length || 1
      replyStep = reply.step ?? sent[afterN - 1]?.step
      hoursToReply = Math.max(0, (Date.parse(at) - Date.parse(firstAt)) / 36e5)
    }
    const intent = reply ? (reply.kind === 'unsubscribe' ? 'not_interested' : reply.intent ?? 'other') : undefined
    const won = t?.stage === 'won'
    rows.push({
      m, t, sent, firstAt, inbox: t?.inbox ?? sent[0].inbox,
      tracked: sent.some(x => x.tracked), opened: sent.some(x => x.opened_at), reply, replyStep, afterN, hoursToReply, intent,
      positive: isPositive(intent),
      bounced: evs.some(e => e.kind === 'bounce'),
      optedOut: intent === 'not_interested' || evs.some(e => e.kind === 'unsubscribe') || t?.badReason === 'Unsubscribed' || t?.badReason === 'Not interested',
      booked: isBooked(t),
      won,
      revenue: won ? t?.dealValue ?? 0 : 0,
    })
  }
  return rows
}

export interface Stat {
  key: string
  leads: number
  emails: number
  /** Leads whose emails carried the open pixel, and how many of them opened. Open % = opened / tracked. */
  tracked: number
  opened: number
  replies: number
  positive: number
  loom: number
  booked: number
  won: number
  revenue: number
  bounced: number
  optedOut: number
}

const blank = (key: string): Stat => ({ key, leads: 0, emails: 0, tracked: 0, opened: 0, replies: 0, positive: 0, loom: 0, booked: 0, won: 0, revenue: 0, bounced: 0, optedOut: 0 })

function add(s: Stat, r: LeadRow) {
  s.leads++
  s.emails += r.sent.length
  if (r.tracked) s.tracked++
  if (r.opened) s.opened++
  if (r.reply) s.replies++
  if (r.positive) s.positive++
  if (r.intent === 'loom') s.loom++
  if (r.booked) s.booked++
  if (r.won) s.won++
  s.revenue += r.revenue
  if (r.bounced) s.bounced++
  if (r.optedOut) s.optedOut++
}

export function totals(rows: LeadRow[]): Stat {
  const s = blank('All')
  rows.forEach(r => add(s, r))
  return s
}

export function groupBy(rows: LeadRow[], key: (r: LeadRow) => string | undefined | null): Stat[] {
  const out = new Map<string, Stat>()
  for (const r of rows) {
    const k = key(r) || '—'
    if (!out.has(k)) out.set(k, blank(k))
    add(out.get(k)!, r)
  }
  return [...out.values()]
}

// ---------- per-email stats ----------

export interface StepStat { step: number; sent: number; tracked: number; opened: number; replies: number; positive: number; bounces: number; optOuts: number; repliedAfter: number }

/** For each email: how many went out, how many replies answered that email, and how many replied after receiving it last. */
export function stepStats(rows: LeadRow[], steps: number): StepStat[] {
  const out = Array.from({ length: steps }, (_, step) => ({ step, sent: 0, tracked: 0, opened: 0, replies: 0, positive: 0, bounces: 0, optOuts: 0, repliedAfter: 0 }))
  for (const r of rows) {
    for (const s of r.sent) {
      const o = out[s.step]
      if (!o) continue
      o.sent++
      if (s.tracked) o.tracked++
      if (s.opened_at) o.opened++
    }
    if (r.reply && r.replyStep != null && out[r.replyStep]) {
      out[r.replyStep].replies++
      if (r.positive) out[r.replyStep].positive++
      if (r.optedOut) out[r.replyStep].optOuts++
    }
    if (r.afterN && out[r.afterN - 1]) out[r.afterN - 1].repliedAfter++
    if (r.bounced && out[r.sent.length - 1]) out[r.sent.length - 1].bounces++
  }
  return out
}

/** Subject lines of a new-thread email, grouped by wording (business name filled out) and A/B variant. */
export function subjectStats(rows: LeadRow[], step: number) {
  const out = new Map<string, { key: string; variant: string; sent: number; tracked: number; opened: number; replies: number; positive: number; example: string }>()
  for (const r of rows) {
    const msg = r.sent.find(s => s.step === step)
    if (!msg?.subject) continue
    const variant = msg.subject_variant ?? 'A'
    const key = `${variant}: ${subjectPattern(msg.subject, r.m)}`
    if (!out.has(key)) out.set(key, { key, variant, sent: 0, tracked: 0, opened: 0, replies: 0, positive: 0, example: msg.subject })
    const s = out.get(key)!
    s.sent++
    if (msg.tracked) s.tracked++
    if (msg.opened_at) s.opened++
    // A reply anywhere in the thread this subject started counts for the subject.
    if (r.reply && r.replyStep != null && r.replyStep >= step && (step === 0 ? r.replyStep === 0 : true)) {
      s.replies++
      if (r.positive) s.positive++
    }
  }
  return [...out.values()].sort((a, b) => b.sent - a.sent)
}

// ---------- dimensions ----------

const et = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, ...opts })
const weekday = et({ weekday: 'short' })
const hour = et({ hour: 'numeric', hourCycle: 'h23' })
const day = et({ year: 'numeric', month: '2-digit', day: '2-digit' })

export const etDay = (iso: string) => {
  const p = Object.fromEntries(day.formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
const etHour = (iso: string) => Number(hour.format(new Date(iso)))
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`

const bucket = (v: number | null | undefined, edges: [number, string][], none = 'Unknown') => {
  if (v == null) return none
  for (const [max, label] of edges) if (v <= max) return label
  return edges[edges.length - 1][1]
}

export const DIMENSIONS: { id: string; label: string; key: (r: LeadRow) => string | undefined | null }[] = [
  { id: 'offer', label: 'Offer', key: r => r.m.offer || null },
  { id: 'trade', label: 'Trade', key: r => r.m.trade },
  { id: 'city', label: 'City', key: r => r.m.city },
  { id: 'tier', label: 'Offer tier', key: r => (r.m.tier ? `${r.m.tier}${r.m.price ? ` $${r.m.price.toLocaleString()}` : ''}` : null) },
  { id: 'status', label: 'Send status', key: r => (r.m.sendStatus === 'READY' ? 'READY' : `${r.m.sendStatus} (approved)`) },
  { id: 'icebreaker', label: 'Icebreaker', key: r => r.m.icebreaker },
  { id: 'noun', label: 'Subject word (jobs / clients…)', key: r => r.m.subjectNoun },
  { id: 'owner', label: 'Subject opens with owner name', key: r => (r.m.subjectOwner ? 'Owner name first' : 'Business name only') },
  { id: 'variant', label: 'Email 1 subject A/B', key: r => r.sent.find(s => s.step === 0)?.subject_variant ?? 'A' },
  { id: 'inbox', label: 'Sending inbox', key: r => r.inbox },
  { id: 'sender', label: 'Sender name', key: r => (r.inbox ? inboxPersona(r.inbox) : null) },
  { id: 'domain', label: 'Sending domain', key: r => r.inbox?.split('@')[1] },
  { id: 'provider', label: 'Their email provider', key: r => {
    const d = r.m.toEmail.split('@')[1]?.toLowerCase() ?? ''
    return FREE_MAIL.test(d) ? d.split('.')[0] : 'Business domain'
  } },
  { id: 'rating', label: 'Google rating', key: r => bucket(r.m.rating, [[3.9, 'Under 4.0'], [4.4, '4.0–4.4'], [4.7, '4.5–4.7'], [4.9, '4.8–4.9'], [5, '5.0']]) },
  { id: 'reviews', label: 'Review count', key: r => bucket(r.m.reviews, [[9, 'Under 10'], [49, '10–49'], [149, '50–149'], [499, '150–499'], [Infinity, '500+']]) },
  { id: 'weekday', label: 'Day Email 1 went out', key: r => (r.firstAt ? weekday.format(new Date(r.firstAt)) : null) },
  { id: 'hour', label: 'Hour Email 1 went out (ET)', key: r => (r.firstAt ? hourLabel(etHour(r.firstAt)) : null) },
]

/** Reply speed: hours from Email 1 to the reply. */
export function replySpeed(rows: LeadRow[]) {
  const edges: [number, string][] = [[1, 'Under 1 hour'], [4, '1–4 hours'], [24, '4–24 hours'], [72, '1–3 days'], [168, '3–7 days'], [Infinity, 'Over a week']]
  const counts = new Map(edges.map(([, l]) => [l, 0]))
  const hours: number[] = []
  for (const r of rows) {
    if (r.hoursToReply == null) continue
    hours.push(r.hoursToReply)
    const label = edges.find(([max]) => r.hoursToReply! <= max)![1]
    counts.set(label, counts.get(label)! + 1)
  }
  hours.sort((a, b) => a - b)
  const median = hours.length ? hours[Math.floor(hours.length / 2)] : null
  return { buckets: [...counts.entries()], median }
}

/** When replies arrive (ET hour of day). */
export function replyHours(rows: LeadRow[]) {
  const counts = new Array(24).fill(0)
  for (const r of rows) if (r.reply) counts[etHour(r.reply.received_at ?? r.reply.created_at)]++
  return counts.map((n, h) => ({ label: hourLabel(h), n })).filter((_, h) => h >= 6 && h <= 23)
}

export function intentCounts(rows: LeadRow[]) {
  const out: Record<ReplyIntent, number> = { loom: 0, meeting: 0, interested: 0, question: 0, not_interested: 0, other: 0 }
  for (const r of rows) if (r.intent) out[r.intent]++
  return out
}

/** Sends per day per step, and replies per day. */
export function daily(rows: LeadRow[], steps: number) {
  const days = new Map<string, { date: string; sent: number[]; replies: number }>()
  const get = (d: string) => {
    if (!days.has(d)) days.set(d, { date: d, sent: new Array(steps).fill(0), replies: 0 })
    return days.get(d)!
  }
  for (const r of rows) {
    for (const s of r.sent) get(etDay(s.sent_at ?? s.created_at)).sent[s.step]++
    if (r.reply) get(etDay(r.reply.received_at ?? r.reply.created_at)).replies++
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export const rate = (a: number, b: number) => (b ? (100 * a) / b : 0)
export const pctText = (a: number, b: number) => (b ? `${rate(a, b).toFixed(1)}%` : '—')

export const INTENT_LABEL: Record<ReplyIntent, string> = {
  loom: 'Wants the Loom',
  meeting: 'Wants a call',
  interested: 'Interested',
  question: 'Question',
  not_interested: 'Said no',
  other: 'Other reply',
}
