// Pure outreach logic shared by the dashboard and the server (api/). No React or Supabase imports here.
import type {
  Campaign, CampaignConfig, CampaignEmail, CampaignLead, CampaignStep, Derived, InboxGuard, Lead, MediaItem, ReplyIntent, SequenceStep, Settings, Stage, Track, TrackMap,
} from './types.ts'

export const DEFAULT_SETTINGS: Settings = {
  cadence: [2, 2, 2],
  dailyTarget: 50,
  dailyEmailTarget: 45,
  // Sending inboxes, e.g. ['alex@yourdomain.com']. Each needs an INBOX_PASSWORD_<INBOX> env var (see api/_lib/env.ts).
  inboxes: [],
  inboxDailyLimit: 30,
  autopilot: false,
  sendStartHour: 9,
  sendEndHour: 17,
  sendWeekdaysOnly: true,
  warmupInboxes: [],
  warmupCaps: [15, 20, 25, 30],
  warmupStart: '',
  trackOpens: false,
  companyName: '',
  mailingAddress: '',
  senderName: '',
  firstSubject: 'Quick question about {business_name}',
  firstBody: `Hi {business_name} team,

I came across {business_name} while looking at {niche} businesses in {city} and noticed {observation}.

I build fast, mobile-friendly websites for local businesses that help them show up on Google and turn searches into calls. Would you be open to a quick look at what that could look like for you?

Best,
{sender_name}`,
  followUpSubject: 'Re: Quick question about {business_name}',
  followUpBody: `Hi {business_name} team,

Just bumping this up in case it got buried. Happy to put together a free mockup so you can see what a refreshed site could look like, no strings attached.

Worth a quick chat this week?

Best,
{sender_name}`,
}

// ---------- dates ----------

export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** The app runs on Eastern Time: "today", daily targets and due dates follow ET wherever you are. */
export const TIME_ZONE = 'America/New_York'
const etDate = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

export function today(): string {
  const p = Object.fromEntries(etDate.formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return toISODate(new Date(y, m - 1, d + days))
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

export function formatDate(iso?: string): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function relativeDue(iso: string, now: string): string {
  const diff = daysBetween(now, iso)
  if (diff === 0) return 'Today'
  if (diff < 0) return `${-diff}d overdue`
  if (diff === 1) return 'Tomorrow'
  return `in ${diff}d`
}

// ---------- status ----------

export const EMPTY_TRACK: Track = { followUps: [] }

export function derive(t: Track | undefined, cadence: number[], now: string): Derived {
  if (!t) return { status: 'new', touches: 0 }
  const touches = (t.sentAt ? 1 : 0) + t.followUps.length
  if (t.badReason) return { status: 'bad', touches }
  if (t.repliedAt) return { status: 'replied', touches }
  if (!t.sentAt) return { status: 'new', touches }
  const n = t.followUps.length
  if (n >= cadence.length) return { status: 'done', touches }
  const last = n ? t.followUps[n - 1] : t.sentAt
  const nextDue = addDays(last, cadence[n])
  return { status: nextDue <= now ? 'due' : 'awaiting', nextDue, touches }
}

// ---------- inboxes ----------

export type InboxCount = { first: number; follow: number }

/** Emails sent on `day` per inbox, first emails and follow-ups. Key '' collects sends with no inbox flagged. */
export function sentByInbox(tracks: TrackMap, day: string): Record<string, InboxCount> {
  const out: Record<string, InboxCount> = {}
  for (const t of Object.values(tracks)) {
    const first = t.sentAt === day ? 1 : 0
    const follow = t.followUps.filter(d => d === day).length
    if (!first && !follow) continue
    const c = (out[t.inbox ?? ''] ??= { first: 0, follow: 0 })
    c.first += first
    c.follow += follow
  }
  return out
}

export const inboxTotal = (c?: InboxCount) => (c ? c.first + c.follow : 0)

/** When an inbox's warm-up started: its own date once the guard is set up, else the shared date. Empty = not started. */
export const inboxWarmupStart = (settings: Settings, inbox?: string) =>
  inbox && settings.guard ? settings.guard[inbox]?.warmupStart ?? '' : settings.warmupStart

/** Warm-up week (0-based) on `day`, for one inbox or the shared date. Before the first send the ramp hasn't started: week 0. */
export function warmupWeek(settings: Settings, day: string, inbox?: string): number {
  const start = inboxWarmupStart(settings, inbox)
  return start ? Math.max(0, Math.floor(daysBetween(start, day) / 7)) : 0
}

/**
 * What an inbox sends on `day` on its own: its own fixed limit if it has one, else the shared inboxDailyLimit,
 * held under the warm-up ramp for inboxes on it.
 */
export function autoCap(settings: Settings, inbox: string, day: string): number {
  const limit = settings.inboxLimits?.[inbox] ?? settings.inboxDailyLimit
  const ramp = settings.warmupCaps
  if (!settings.warmupInboxes.includes(inbox) || !ramp.length) return limit
  const week = warmupWeek(settings, day, inbox)
  return Math.min(limit, week < ramp.length ? ramp[week] : limit)
}

/** Emails an inbox may send on `day`: a number set by hand for that day on Email accounts, else the automatic cap. */
export function inboxCap(settings: Settings, inbox: string, day: string): number {
  const set = settings.sendsToday?.[inbox]
  return set?.day === day ? set.n : autoCap(settings, inbox, day)
}

export const isWarmingUp = (settings: Settings, inbox: string, day: string) =>
  settings.warmupInboxes.includes(inbox) && warmupWeek(settings, day, inbox) < settings.warmupCaps.length

/** Total emails all inboxes may send on `day`. */
export const dailyCapacity = (settings: Settings, day: string) =>
  settings.inboxes.reduce((sum, i) => sum + inboxCap(settings, i, day), 0)

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const clocks = new Map<string, Intl.DateTimeFormat>()
const clock = (timeZone: string) => {
  if (!clocks.has(timeZone)) clocks.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }))
  return clocks.get(timeZone)!
}

export type SendWindow = { open: boolean; fraction: number; reason?: string }

function windowAt(at: Date, timeZone: string, days: number[], startHour: number, endHour: number): SendWindow {
  const p = Object.fromEntries(clock(timeZone).formatToParts(at).map(x => [x.type, x.value]))
  const minutes = Number(p.hour) * 60 + Number(p.minute)
  const start = startHour * 60
  const end = endHour * 60
  if (!days.includes(WEEKDAYS.indexOf(p.weekday))) return { open: false, fraction: 0, reason: 'not a sending day' }
  if (minutes < start) return { open: false, fraction: 0, reason: 'before hours' }
  if (minutes >= end) return { open: false, fraction: 1, reason: 'after hours' }
  return { open: true, fraction: (minutes - start) / Math.max(1, end - start) }
}

const windowDays = (s: Settings) => (s.sendWeekdaysOnly ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6])

/** Where `at` falls in the Eastern Time send window. `fraction` runs 0 → 1 across the window. */
export const sendWindow = (settings: Settings, at = new Date()): SendWindow =>
  windowAt(at, TIME_ZONE, windowDays(settings), settings.sendStartHour, settings.sendEndHour)

/** The same for one campaign: its own schedule where set, the app-wide window for anything left unset. */
export function campaignWindow(c: Pick<Campaign, 'config'>, settings: Settings, at = new Date()): SendWindow {
  const cfg = c.config ?? {}
  return windowAt(at, cfg.timeZone || TIME_ZONE, cfg.days?.length ? cfg.days : windowDays(settings), cfg.startHour ?? settings.sendStartHour, cfg.endHour ?? settings.sendEndHour)
}

export const STATUS_LABEL: Record<Derived['status'], string> = {
  new: 'Not contacted',
  awaiting: 'Awaiting reply',
  due: 'Follow-up due',
  replied: 'Replied',
  done: 'Sequence done',
  bad: 'Bad data',
}

// ---------- templates ----------

function observation(lead: Lead): string {
  switch (lead.hook) {
    case 'broken site':
      return `your website (${lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}) isn't loading right now`
    case 'outdated site':
      return "your website looks like it hasn't been updated in a while and doesn't hold up well on phones"
    case 'site not on Google':
      return "your website isn't showing up when people search for you on Google"
    case 'social only':
      return "you're running everything through social media without a website of your own"
    default:
      return "you don't have a website yet, so customers searching online can't find you"
  }
}

/** Inboxes whose address doesn't spell the sender's first name, e.g. { 'info@yourdomain.com': 'Alex' }. */
const PERSONA_NAMES: Record<string, string> = {}

/**
 * Who signs for each first name, e.g. { Alex: { name: 'Alex Rivera', title: 'Founder, Your Company' } }.
 * A sender with no entry keeps their plain sign-off.
 */
export const SIGNERS: Record<string, { name: string; title: string }> = {}

/** First name used for an inbox's From header and {sender_name}: zayn@… → "Zayn". */
export function inboxPersona(inbox: string): string {
  if (PERSONA_NAMES[inbox.toLowerCase()]) return PERSONA_NAMES[inbox.toLowerCase()]
  const local = inbox.split('@')[0].split(/[._+-]/)[0]
  return local.charAt(0).toUpperCase() + local.slice(1)
}

export function fillTemplate(tpl: string, lead: Lead, settings: Settings, inbox?: string): string {
  const vars: Record<string, string> = {
    business_name: lead.businessName,
    city: lead.city,
    niche: lead.niche.toLowerCase(),
    category: lead.specificCategory,
    website: lead.website,
    pitch_angle: lead.pitchAngle,
    observation: observation(lead),
    sender_name: inbox ? inboxPersona(inbox) : settings.senderName || '[Your name]',
  }
  return tpl.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)
}

const SITE_STATUS: Record<string, string> = {
  broken: 'broken / down',
  outdated: 'outdated',
  none: 'no website',
  'social-only': 'social media only',
}

/** Plain-text profile of a lead for pasting elsewhere. Empty fields are left out. */
export function leadDetails(l: Lead): string {
  const site = SITE_STATUS[l.websiteStatus] ?? l.websiteStatus
  const lines: [string, string | number | null | undefined][] = [
    ['Category', `${l.specificCategory} (${l.industry} › ${l.niche})`],
    ['What they do', l.whatTheyDo],
    ['Location', `${l.address ? `${l.address}, ` : ''}${l.city}`],
    ['Google', l.rating != null ? `${l.rating}★ from ${(l.reviews ?? 0).toLocaleString()} reviews` : null],
    ['Website', l.website ? `${l.website} (${site})` : site],
    ['Problem', l.whyOutdated],
    ['Hook', l.hook],
    ['Pitch', l.pitchAngle],
    ['Email', `${l.email} (${l.emailType})`],
    ['Email found at', l.emailFoundAt],
    ['Google Maps', l.googleMaps],
    ['Priority', `Wave ${l.wave} · score ${l.score}`],
  ]
  // Skip blanks, and repeats like "no website" showing up as website, problem and hook alike.
  const seen = new Set<string>()
  const kept = lines.filter(([, v]) => {
    const key = String(v ?? '').trim().toLowerCase()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  return [l.businessName, ...kept.map(([k, v]) => `${k}: ${v}`)].join('\n')
}

/** "Your Company · 123 Main St, Springfield, IL 62701": the line under the sender's name in every email. */
export const companyLine = (s: Settings) => `${s.companyName.trim()} · ${s.mailingAddress.trim().replace(/\s*\n\s*/g, ', ')}`

/** CAN-SPAM footer: who is sending and a real postal address. Empty until both are set. */
export function emailFooter(settings: Settings): string {
  if (!footerReady(settings)) return ''
  return companyLine(settings)
}

export const footerReady = (s: Settings) => !!s.companyName.trim() && !!s.mailingAddress.trim()

export function composeEmail(lead: Lead, settings: Settings, followUp: boolean, inbox?: string) {
  const subject = fillTemplate(followUp ? settings.followUpSubject : settings.firstSubject, lead, settings, inbox)
  const footer = emailFooter(settings)
  const text = fillTemplate(followUp ? settings.followUpBody : settings.firstBody, lead, settings, inbox)
  const body = footer ? `${text.trimEnd()}\n${footer}` : text
  const mailto = `mailto:${lead.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  return { subject, body, mailto }
}

// ---------- database rows (shared with the server) ----------

const PAGE = 1000 // PostgREST's default max rows per request

// Column aliases map snake_case columns straight onto the Lead shape.
export const LEAD_COLUMNS = [
  'id', 'wave', 'nicheGroup:niche_group', 'score', 'hook', 'pitchAngle:pitch_angle', 'emailType:email_type',
  'businessName:business_name', 'industry', 'niche', 'specificCategory:specific_category', 'whatTheyDo:what_they_do',
  'city', 'address', 'rating', 'reviews', 'websiteStatus:website_status', 'website', 'whyOutdated:why_outdated',
  'email', 'emailFoundAt:email_found_at', 'googleMaps:google_maps',
].join(',')

export async function fetchAll<T>(query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>) {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

// ---------- deliverability guard rows (inbox_guard) ----------

export const GUARD_COLUMNS = 'inbox,warmup_start'

export interface GuardRow {
  inbox: string; warmup_start: string | null
  /** '*' row only: last hourly DNS check. */
  checked_at?: string | null
}

export const guardFromRows = (rows: GuardRow[]): Record<string, InboxGuard> =>
  Object.fromEntries(rows.map(r => [r.inbox, { warmupStart: r.warmup_start }]))

export interface TrackingRow {
  lead_id: string
  sent_at: string | null
  follow_ups: string[]
  replied_at: string | null
  bad_reason: string | null
  notes: string | null
  media_done: boolean
  media: MediaItem[]
  inbox: string | null
  stage?: string | null
  stage_log?: Record<string, string> | null
  deal_value?: number | string | null
}

export const TRACKING_COLUMNS = 'lead_id,sent_at,follow_ups,replied_at,bad_reason,notes,media_done,media,inbox,stage,stage_log,deal_value'

export const fromRow = (r: TrackingRow): Track => ({
  sentAt: r.sent_at ?? undefined,
  followUps: r.follow_ups ?? [],
  repliedAt: r.replied_at ?? undefined,
  badReason: r.bad_reason ?? undefined,
  notes: r.notes ?? undefined,
  mediaDone: r.media_done || undefined,
  media: r.media?.length ? r.media : undefined,
  inbox: r.inbox ?? undefined,
  stage: (r.stage as Stage | null) ?? undefined,
  stageLog: r.stage_log && Object.keys(r.stage_log).length ? r.stage_log : undefined,
  dealValue: r.deal_value != null && r.deal_value !== '' ? Number(r.deal_value) : undefined,
})

export const toRow = (id: string, t: Track): TrackingRow => ({
  lead_id: id,
  sent_at: t.sentAt ?? null,
  follow_ups: t.followUps,
  replied_at: t.repliedAt ?? null,
  bad_reason: t.badReason ?? null,
  notes: t.notes ?? null,
  media_done: !!t.mediaDone,
  media: t.media ?? [],
  inbox: t.inbox ?? null,
  stage: t.stage ?? null,
  stage_log: t.stageLog ?? {},
  deal_value: t.dealValue ?? null,
})

// ---------- campaigns ----------

const BASE_CAMPAIGN_COLUMNS = [
  'id', 'name', 'status', 'followUpsPaused:follow_ups_paused', 'startDate:start_date', 'cadence', 'steps', 'images',
  'subjectB:subject_b', 'autoStatuses:auto_statuses',
].join(',')
export const CAMPAIGN_COLUMNS = `${BASE_CAMPAIGN_COLUMNS},config`

/**
 * Load campaign rows with `config`, or without it before master_inbox.sql has added the column: sending must keep
 * working through a deploy that lands before the SQL has run.
 */
export async function withCampaignConfig<T>(load: (columns: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T> {
  let res = await load(CAMPAIGN_COLUMNS)
  if (res.error && /config/i.test(res.error.message)) res = await load(BASE_CAMPAIGN_COLUMNS)
  if (res.error) throw new Error(res.error.message)
  const fill = (c: Partial<Campaign>) => ({ ...c, config: c.config ?? {} })
  return (Array.isArray(res.data) ? res.data.map(fill) : fill(res.data as Partial<Campaign>)) as T
}

export const CAMPAIGN_LEAD_COLUMNS = [
  'campaignId:campaign_id', 'leadId:lead_id', 'position', 'leadNo:lead_no', 'sendStatus:send_status', 'approved',
  'toEmail:to_email', 'businessName:business_name', 'shortName:short_name', 'trade', 'city', 'rating', 'reviews',
  'website', 'offer', 'tier', 'price', 'checks', 'icebreaker', 'subjectNoun:subject_noun', 'subjectOwner:subject_owner',
].join(',')

export const normalizeCampaignLead = (m: CampaignLead): CampaignLead => ({
  ...m,
  rating: m.rating == null ? null : Number(m.rating),
  checks: m.checks ?? [],
})

/** The signature placeholder in the written emails, filled with the sending inbox's first name. */
export const SIGNATURE_TOKEN = '{{sendingAccountFirstName}}'

/** Filter for email_events queries. Bounces cleared from the numbers carry intent 'cleared'; the leads stay stopped. */
export const LIVE_EVENTS = 'intent.is.null,intent.neq.cleared'

/** Whether autopilot may send to this lead: never DO NOT SEND; other statuses need auto-send or an approve. */
export const campaignEligible = (m: Pick<CampaignLead, 'sendStatus' | 'approved'>, c: Pick<Campaign, 'autoStatuses'>) =>
  m.sendStatus !== 'DO NOT SEND' && (c.autoStatuses.includes(m.sendStatus) || m.approved)

/** 0-based step of the email that started the thread: always Email 1, because every follow-up replies in its thread. */
export const threadRoot = (_c: Pick<Campaign, 'steps'>, _step: number): number => 0

// FNV-1a, so a lead always lands in the same subject variant.
function hash(s: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}

/** Subject variant for a new-thread step (0-based): 'B' for half the leads once a subject B is written, else 'A'. */
export function subjectVariant(c: Pick<Campaign, 'subjectB'>, leadId: string, step: number): 'A' | 'B' {
  return c.subjectB[String(step + 1)]?.trim() && hash(`${leadId}:${step + 1}`) % 2 ? 'B' : 'A'
}

export function fillSubjectB(tpl: string, m: CampaignLead): string {
  const vars: Record<string, string> = {
    name: m.shortName,
    owner: m.subjectOwner ?? m.shortName,
    noun: m.subjectNoun ?? 'jobs',
    city: m.city,
    trade: m.trade.toLowerCase(),
  }
  return tpl.trim().replace(/\{(\w+)\}/g, (x, k: string) => vars[k] ?? x)
}

// The 'Not a fit? Reply "no"' line came out of every email on 2026-11-05. Older stored bodies still carry it, so it's dropped wherever it sits.
const WRITTEN_OPT_OUT = /\n*[ \t]*Not a fit\? Reply "no" and I won't email again\.[ \t]*(?=\n|$)/g
export const withoutOptOut = (body: string) => body.replace(WRITTEN_OPT_OUT, '').trimEnd()

// Plain text emails close with the sender's full name, title and address, with the street and city on separate lines so
// Gmail doesn't turn the address into a Maps link. Anything written after the sign-off, like a P.S., moves above it.
function plainSignOff(body: string, inbox: string) {
  const persona = inboxPersona(inbox)
  const signer = SIGNERS[persona]
  const end = [...body.matchAll(new RegExp(`(?:^|\\n+)${persona}\\n+([^\\n]+) · ([^,\\n]+), ([^\\n]+)`, 'g'))].pop()
  if (!end) return body
  const written = [body.slice(0, end.index).trimEnd(), body.slice(end.index + end[0].length).trim()].filter(Boolean).join('\n\n')
  // The name signed is the name the email is sent from (its From name, e.g. "Alex"), plus the signer's surname when known.
  const surname = signer?.name.split(' ').slice(1).join(' ')
  const name = surname ? `${persona} ${surname}` : persona
  const title = signer?.title ?? end[1]
  // A closing like "Best," sits right above the name; anything else gets a blank line first.
  return `${written}${/,$/.test(written) ? '\n' : '\n\n'}${name}\n${title}\n${end[2]}\n${end[3]}`
}

/**
 * One campaign email ready to send. `rootSubject` is the subject actually sent at the start of the thread,
 * so replies keep "Re: <same subject>" even when the thread started on subject B.
 */
export function composeCampaignEmail(c: Campaign, m: CampaignLead, emails: CampaignEmail[], step: number, inbox: string, rootSubject?: string) {
  const email = emails[step]
  const root = threadRoot(c, step)
  // Campaigns written in the app carry their variant on each email; imported ones use the subject B test.
  const variant = email.variant != null ? String.fromCharCode(65 + email.variant) : subjectVariant(c, m.leadId, root)
  const written = (i: number) => (emails[i].variant == null && subjectVariant(c, m.leadId, i) === 'B' ? fillSubjectB(c.subjectB[String(i + 1)], m) : emails[i].subject)
  const subject = root === step ? written(step) : `Re: ${rootSubject ?? written(root)}`
  const body = withoutOptOut(email.body.split(SIGNATURE_TOKEN).join(inboxPersona(inbox)))
  return { subject, body: c.config?.plainText ? plainSignOff(body, inbox) : body, variant }
}

/** Email 1's subject wording with the business filled out, for comparing subject lines across leads. */
export function subjectPattern(subject: string, m: Pick<CampaignLead, 'shortName' | 'subjectOwner'>): string {
  const s = subject.replace(/^Re: /, '')
  const q = /^(?:(.+?), )?q: is (.+) taking on more (\w+)\?$/.exec(s)
  if (q) return `${q[1] ? '{owner}, ' : ''}q: is {name} taking on more ${q[3]}?`
  // Business name first: it often contains the owner's name ("Luke's Flooring").
  let out = s
  if (m.shortName) out = out.split(m.shortName).join('{name}')
  if (m.subjectOwner) out = out.split(m.subjectOwner).join('{owner}')
  return out
}

// ---------- campaigns written in the app ----------

/** What a new campaign starts with. Imported campaigns have an empty config, so they behave as they always did. */
export const NEW_CAMPAIGN_CONFIG: CampaignConfig = {
  sequence: [{ gap: 0, variants: [{ subject: '', body: '' }] }],
  variantDistribution: 'pattern',
  followUpShare: 100,
  bounceProtection: { enabled: false, threshold: 5 },
}

export const isWritten = (c: Pick<Campaign, 'config'>) => !!c.config?.sequence?.length

/** The steps and cadence the rest of the app runs on, worked out from a written sequence. */
export function sequencePlan(seq: SequenceStep[]): { steps: CampaignStep[]; cadence: number[] } {
  let day = 0
  const steps = seq.map((s, i): CampaignStep => {
    if (i) day += s.gap
    // Follow-ups always reply in Email 1's thread, even when one was given a subject.
    return i === 0 ? { n: 1, day, thread: 'new' } : { n: i + 1, day, thread: 'reply', replyTo: 1 }
  })
  return { steps, cadence: seq.slice(1).map(s => s.gap) }
}

/** Which variant a lead gets when no live count is at hand: list order, or random but stable across retries. */
export function variantIndex(c: Pick<Campaign, 'config'>, m: Pick<CampaignLead, 'leadId' | 'position'>, step: number, n: number) {
  if (n < 2) return 0
  return c.config.variantDistribution === 'random' ? hash(`${m.leadId}:${step}`) % n : m.position % n
}

/** {{variables}} for one lead: the uploaded list's columns plus the campaign's own fields. */
export function leadVars(m: CampaignLead): Record<string, string> {
  const own = Object.fromEntries(Object.entries(m.vars ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
  const company = own.company || own.company_name || m.businessName
  return {
    ...own, company, company_name: company, business_name: company, city: own.city || m.city, website: own.website || m.website,
    email: m.toEmail, sender_name: SIGNATURE_TOKEN, sendingaccountfirstname: SIGNATURE_TOKEN,
  }
}

/** Fill {{first_name}} or {{first_name|there}} (with a fallback). A variable the lead doesn't have comes out blank. */
export const fillVars = (tpl: string, vars: Record<string, string>) =>
  tpl.replace(/\{\{\s*([\w ]+?)\s*(?:\|([^}]*))?\}\}/g, (_, k: string, fallback?: string) => vars[k.toLowerCase().replace(/ /g, '_')] || fallback?.trim() || '')

/**
 * A written campaign's emails for one lead, in the shape imported campaigns store per lead. The company line goes on
 * here (imported emails have it written in); `pick` overrides the variant, for "even" distribution.
 */
export function templateEmails(c: Pick<Campaign, 'config'>, m: CampaignLead, settings: Settings, pick?: (step: number, n: number) => number | undefined): CampaignEmail[] {
  const seq = c.config.sequence ?? []
  const { steps } = sequencePlan(seq)
  const vars = leadVars(m)
  const foot = footerReady(settings) ? `\n\n${companyLine(settings)}` : ''
  return seq.map((s, i) => {
    const variant = pick?.(i, s.variants.length) ?? variantIndex(c, m, i, s.variants.length)
    const v = s.variants[variant] ?? s.variants[0]
    const subject = v.subject.trim() || s.variants.find(x => x.subject.trim())?.subject.trim() || ''
    return {
      step: i + 1, day: steps[i].day, thread: steps[i].thread, replyTo: steps[i].replyTo ?? null, variant,
      subject: fillVars(subject, vars), body: `${fillVars(v.body, vars).trimEnd()}${foot}`,
    }
  })
}

// ---------- pipeline ----------

/** Replies that count as positive on the dashboard. */
export const isPositive = (intent?: ReplyIntent | null) => intent === 'loom' || intent === 'meeting' || intent === 'interested'

/** Where a reply moves a lead. Stages a person set further along (proposal, won, lost) stay as they are. */
export function stageAfterReply(cur: Stage | undefined, intent: ReplyIntent): Stage {
  if (cur === 'proposal' || cur === 'won' || cur === 'lost') return cur
  if (intent === 'not_interested') return 'not_interested'
  if (intent === 'meeting') return 'call_booked'
  if (cur === 'call_booked' || cur === 'loom_sent') return cur
  if (intent === 'loom') return 'loom_requested'
  return cur === 'loom_requested' ? cur : 'replied'
}

/** Shared mail providers: everyone there is a different company, so company-level rules skip these domains. */
export const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|comcast|att|bellsouth|verizon|cox|earthlink|protonmail)\./i

export const STAGE_LABEL: Record<Stage, string> = {
  replied: 'Replied',
  loom_requested: 'Wants Loom',
  loom_sent: 'Loom sent',
  call_booked: 'Call booked',
  proposal: 'Proposal sent',
  won: 'Won',
  lost: 'Lost',
  not_interested: 'Not interested',
}

/** Booked = reached "call booked" at any point, even if the deal was lost later. */
export const isBooked = (t?: Track) => !!t && (!!t.stageLog?.call_booked || t.stage === 'call_booked' || t.stage === 'proposal' || t.stage === 'won')
