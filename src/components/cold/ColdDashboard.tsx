import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Check } from 'lucide-react'
import { supabase } from '../../supabase'
import { LIVE_EVENTS, STAGE_LABEL, TIME_ZONE, addDays, fetchAll, inboxPersona, isBooked, isPositive } from '../../tracking'
import { STAGES, type ReplyIntent, type TrackMap } from '../../types'
import { etDay, pctText } from './campaign/stats'
import type { ColdProps } from './ColdApp'
import { Avatar, Segmented, useWidth } from './campaign/ui'

type SentMsg = {
  id: number; lead_id: string | null; step: number; inbox: string; sent_at: string | null; campaign_id: string | null
  tracked?: boolean; opened_at?: string | null; clicked_at?: string | null
}
type InboxEvt = {
  lead_id: string | null; inbox: string; kind: string; step: number | null; message_id: string
  received_at: string | null; created_at: string; intent: ReplyIntent | null
}

/** One sent email and what came of it. Replies, bounces and opt-outs are credited to the email they answered. */
interface Sent { m: SentMsg; day: string; hour: number; replied: boolean; positive: boolean; bounced: boolean; optedOut: boolean }

// ---------- dates (Eastern Time days, ranges end-exclusive) ----------

const monthStart = (day: string, n = 0) => {
  const [y, m] = day.split('-').map(Number)
  const d = new Date(y, m - 1 + n, 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
const dateLabel = (iso: string, opts: Intl.DateTimeFormatOptions) => {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts)
}
const etHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: 'numeric', hourCycle: 'h23' })
const hourName = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`

type RangeId = 'today' | '7d' | '4w' | 'lastMonth' | '3m' | 'all'
const RANGES: { id: RangeId; short: string; label: string; prev: string }[] = [
  { id: 'today', short: 'Today', label: 'Today', prev: 'yesterday' },
  { id: '7d', short: '7D', label: 'Last 7 days', prev: 'previous 7 days' },
  { id: '4w', short: '4W', label: 'Last 4 weeks', prev: 'previous 4 weeks' },
  { id: 'lastMonth', short: 'Last month', label: 'Last month', prev: 'the month before' },
  { id: '3m', short: '3M', label: 'Last 3 months', prev: 'previous 3 months' },
  { id: 'all', short: 'All', label: 'All time', prev: '' },
]

/** The range and the equal stretch just before it, for "vs previous". */
function rangeDays(id: RangeId, now: string): { from: string; to: string; prevFrom?: string } {
  const to = addDays(now, 1)
  switch (id) {
    case 'today': return { from: now, to, prevFrom: addDays(now, -1) }
    case '7d': return { from: addDays(now, -6), to, prevFrom: addDays(now, -13) }
    case '4w': return { from: addDays(now, -27), to, prevFrom: addDays(now, -55) }
    case 'lastMonth': return { from: monthStart(now, -1), to: monthStart(now), prevFrom: monthStart(now, -2) }
    case '3m': return { from: addDays(now, -89), to, prevFrom: addDays(now, -179) }
    case 'all': return { from: '', to }
  }
}

type Period = 'day' | 'week' | 'month'
const PERIODS: { id: Period; label: string; n: number }[] = [
  { id: 'day', label: 'Daily', n: 10 },
  { id: 'week', label: 'Weekly', n: 8 },
  { id: 'month', label: 'Monthly', n: 6 },
]
/** Start of the day, Monday-start week or month containing `day`. */
function periodStart(day: string, p: Period): string {
  if (p === 'day') return day
  if (p === 'month') return monthStart(day)
  const [y, m, d] = day.split('-').map(Number)
  return addDays(day, -((new Date(y, m - 1, d).getDay() + 6) % 7))
}
const shift = (start: string, p: Period, n: number) => (p === 'day' ? addDays(start, n) : p === 'week' ? addDays(start, 7 * n) : monthStart(start, n))

// ---------- loading ----------

function useSends() {
  const [msgs, setMsgs] = useState<SentMsg[]>([])
  const [events, setEvents] = useState<InboxEvt[]>([])
  const [error, setError] = useState<string>()
  const [loadedAt, setLoadedAt] = useState<Date>()

  const load = useCallback(async () => {
    try {
      const sent = (cols: string) => fetchAll<SentMsg>((from, to) => supabase.from('email_messages').select(cols)
        .eq('status', 'sent').neq('source', 'test').order('id').range(from, to) as unknown as PromiseLike<{ data: SentMsg[] | null; error: { message: string } | null }>)
      const cols = 'id,lead_id,step,inbox,sent_at,campaign_id'
      const [m, e] = await Promise.all([
        // Before opens.sql runs there are no open columns: show everything but opens.
        sent(`${cols},tracked,opened_at,clicked_at`).catch(err => (/column/i.test(String(err?.message)) ? sent(`${cols},tracked,opened_at`) : Promise.reject(err)))
          .catch(err => (/column/i.test(String(err?.message)) ? sent(cols) : Promise.reject(err))),
        fetchAll<InboxEvt>((from, to) => supabase.from('email_events').select('lead_id,inbox,kind,step,message_id,received_at,created_at,intent')
          .in('kind', ['reply', 'auto', 'unsubscribe', 'bounce']).or(LIVE_EVENTS).order('id').range(from, to)),
      ])
      setMsgs(m)
      setEvents(e)
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLoadedAt(new Date())
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const sends = useMemo<Sent[]>(() => {
    // A reply lands in the inbox that sent the email: match on lead + inbox, then on the email they answered.
    const byLead = new Map<string, SentMsg[]>()
    for (const m of msgs) {
      if (!m.lead_id) continue
      if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, [])
      byLead.get(m.lead_id)!.push(m)
    }
    const out = new Map<number, { replied?: boolean; positive?: boolean; bounced?: boolean; optedOut?: boolean }>()
    for (const e of events) {
      const all = e.lead_id ? byLead.get(e.lead_id) : undefined
      if (!all) continue
      const own = all.filter(x => x.inbox === e.inbox)
      const list = own.length ? own : all
      const at = e.received_at ?? e.created_at
      const m = list.find(x => x.step === e.step) ?? [...list].reverse().find(x => (x.sent_at ?? '') <= at) ?? list[0]
      const o = out.get(m.id) ?? {}
      const link = e.kind === 'unsubscribe' && e.message_id.startsWith('link:') // footer link, not a reply
      if (e.kind === 'bounce') o.bounced = true
      // Every reply counts, auto-replies and out-of-office included.
      if (e.kind === 'reply' || e.kind === 'auto' || (e.kind === 'unsubscribe' && !link)) o.replied = true
      if (e.kind === 'reply' && isPositive(e.intent)) o.positive = true
      if (e.kind === 'unsubscribe' || e.intent === 'not_interested') o.optedOut = true
      out.set(m.id, o)
    }
    // Only emails to leads count: one-offs and hand-written replies with no lead aren't cold sends.
    return msgs.filter(m => m.sent_at && m.lead_id).map(m => {
      const o = out.get(m.id) ?? {}
      const at = new Date(m.sent_at!)
      return {
        m, day: etDay(m.sent_at!), hour: Number(etHourFmt.format(at)),
        replied: !!o.replied, positive: !!o.positive, bounced: !!o.bounced, optedOut: !!o.optedOut,
      }
    })
  }, [msgs, events])

  return { sends, error, loadedAt }
}

// ---------- tallies ----------

interface Row {
  key: string; sent: number; tracked: number; opened: number; clicked: number; looms: number
  leads: Set<string>; replies: number; positive: number; bounces: number; optOuts: number
}
const blank = (key: string): Row => ({ key, sent: 0, tracked: 0, opened: 0, clicked: 0, looms: 0, leads: new Set(), replies: 0, positive: 0, bounces: 0, optOuts: 0 })
function add(r: Row, s: Sent) {
  r.sent++
  if (s.m.tracked) r.tracked++
  if (s.m.opened_at) r.opened++
  if (s.m.clicked_at) r.clicked++
  if (s.m.step === LOOM_STEP) r.looms++
  if (s.m.lead_id) r.leads.add(s.m.lead_id)
  if (s.replied) r.replies++
  if (s.positive) r.positive++
  if (s.bounced) r.bounces++
  if (s.optedOut) r.optOuts++
}
function group(sends: Sent[], key: (s: Sent) => string, seed: string[] = []) {
  const rows = new Map<string, Row>(seed.map(k => [k, blank(k)]))
  for (const s of sends) {
    const k = key(s)
    if (!rows.has(k)) rows.set(k, blank(k))
    add(rows.get(k)!, s)
  }
  return rows
}
const total = (sends: Sent[]) => {
  const r = blank('All')
  sends.forEach(s => add(r, s))
  return r
}

const rate = (a: number, b: number) => (b ? (100 * a) / b : null)
/** email_messages step of a hand-written Loom, see api/_lib/loom.ts. */
const LOOM_STEP = 100
/** Fewer tracked emails than this and a rate is shown greyed out: too few to trust. */
const MIN_SAMPLE = 20
/** Only emails sent Nov 3 (10:05 AM ET) to Nov 9 carry an open pixel; tracking is off now. A rate is only real when enough were sent with one. */
const openRate = (r: Row) => (r.tracked >= MIN_SAMPLE ? rate(r.opened, r.tracked) : null)
function openSub(r: Row) {
  if (!r.tracked) return 'Open tracking is off. None of these emails were tracked'
  if (r.tracked < MIN_SAMPLE) return `${r.opened} of ${r.tracked} tracked opened · rate shows at ${MIN_SAMPLE} tracked`
  return r.tracked < r.sent ? `${r.opened} of ${r.tracked} tracked opened · ${r.sent - r.tracked} sent without tracking` : `${r.opened} of ${r.tracked} opened`
}

type Metric = 'sent' | 'openRate' | 'replyRate'
const METRICS: { id: Metric; label: string; value: (r: Row) => number | null; fmt: (v: number) => string }[] = [
  { id: 'sent', label: 'Emails sent', value: r => r.sent, fmt: v => v.toLocaleString() },
  { id: 'openRate', label: 'Open rate', value: r => rate(r.opened, r.tracked), fmt: v => `${v.toFixed(1)}%` },
  { id: 'replyRate', label: 'Reply rate', value: r => rate(r.replies, r.leads.size), fmt: v => `${v.toFixed(1)}%` },
]

// ---------- page ----------

/** Analytics: headline numbers with change vs the previous period, a trend chart, and which inboxes perform best. */
export default function ColdDashboard({ settings, now, tracks, campaigns }: ColdProps) {
  const [range, setRange] = useState<RangeId>('4w')
  const [campaign, setCampaign] = useState('')
  const [metric, setMetric] = useState<Metric>('sent')
  const { sends, error, loadedAt } = useSends()
  const r = RANGES.find(x => x.id === range)!
  const { from, to, prevFrom } = rangeDays(range, now)

  // Only the live inboxes count: anything left from a removed inbox stays out of the numbers.
  const live = useMemo(() => new Set(settings.inboxes), [settings.inboxes])
  const scoped = useMemo(() => sends.filter(s => live.has(s.m.inbox) && (!campaign || s.m.campaign_id === campaign)), [sends, live, campaign])
  const cur = useMemo(() => scoped.filter(s => s.day >= from && s.day < to), [scoped, from, to])
  const prev = useMemo(() => (prevFrom ? scoped.filter(s => s.day >= prevFrom && s.day < from) : null), [scoped, prevFrom, from])
  const t = useMemo(() => total(cur), [cur])
  const p = useMemo(() => (prev ? total(prev) : null), [prev])
  // Calls booked are set by hand: moving a lead to "Call booked" (or past it) counts it.
  const booked = useMemo(() => [...t.leads].filter(id => isBooked(tracks[id])).length, [t, tracks])
  const prevBooked = useMemo(() => (p ? [...p.leads].filter(id => isBooked(tracks[id])).length : null), [p, tracks])

  // Chart points: hours for one day, days up to three months, weeks beyond.
  const points = useMemo(() => {
    if (range === 'today') {
      const rows = group(cur, s => String(s.hour), Array.from({ length: 11 }, (_, k) => String(k + 8)))
      return [...rows.values()].filter(x => +x.key >= 8 && +x.key <= 18).sort((a, b) => +a.key - +b.key)
        .map(x => ({ label: hourName(+x.key), row: x }))
    }
    const first = from || cur.reduce((d, s) => (s.day < d ? s.day : d), now)
    const last = addDays(to, -1) < now ? addDays(to, -1) : now
    const weekly = !from && first < addDays(now, -92)
    const keyOf = (d: string) => (weekly ? periodStart(d, 'week') : d)
    const keys: string[] = []
    for (let d = keyOf(first); d <= last; d = addDays(d, weekly ? 7 : 1)) keys.push(d)
    const rows = group(cur, s => keyOf(s.day), keys)
    // Weekdays-only sending: empty weekends would just drag the line to zero twice a week.
    const weekend = (k: string) => {
      const [y, mo, d] = k.split('-').map(Number)
      return [0, 6].includes(new Date(y, mo - 1, d).getDay())
    }
    return keys.filter(k => weekly || !settings.sendWeekdaysOnly || !weekend(k) || rows.get(k)!.sent)
      .map(k => ({ label: dateLabel(k, { month: 'short', day: 'numeric' }), row: rows.get(k)! }))
  }, [cur, range, from, to, now, settings.sendWeekdaysOnly])

  const m = METRICS.find(x => x.id === metric)!
  const headline = metric === 'openRate' ? openRate(t) : m.value(t)
  const prevHeadline = p ? (metric === 'openRate' ? openRate(p) : m.value(p)) : null

  return (
    <div className="dash">
      <div className="dash-toolbar">
        <select className="select select-sm" value={campaign} onChange={e => setCampaign(e.target.value)} aria-label="Campaign">
          <option value="">All campaigns</option>
          {campaigns.campaigns.filter(c => c.status !== 'done').map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <Segmented value={range} onChange={setRange} options={RANGES.map(x => ({ id: x.id, label: x.short, title: x.label }))} />
        <span className="dash-updated">
          {error ? <span className="error-text">Couldn't load: {error}</span>
            : loadedAt ? <><Check size={14} strokeWidth={2.5} /> Updated {loadedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</> : 'Loading…'}
        </span>
      </div>

      <div className="dash-grid">
        <div className="dash-main">
          <div className="stat-row stat-row-3">
            <Stat label="Emails sent" value={t.sent.toLocaleString()} sub={`${t.leads.size.toLocaleString()} leads`}
              delta={p && p.sent ? { v: (100 * (t.sent - p.sent)) / p.sent, unit: '%' } : undefined} vs={r.prev} />
            <Stat label="Open rate" value={t.tracked >= MIN_SAMPLE ? pctText(t.opened, t.tracked) : '—'} sub={openSub(t)}
              delta={pts(openRate(t), p && openRate(p))} vs={r.prev} />
            <Stat label="Reply rate" value={pctText(t.replies, t.leads.size)} sub={`${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}`}
              delta={pts(rate(t.replies, t.leads.size), p && rate(p.replies, p.leads.size))} vs={r.prev} />
            <Stat label="Bounce rate" value={pctText(t.bounces, t.sent)} sub={`${t.bounces} bounced`} upIsBad
              delta={pts(rate(t.bounces, t.sent), p && rate(p.bounces, p.sent))} vs={r.prev} />
            <Stat label="Positive replies" value={t.positive.toLocaleString()} sub={`${pctText(t.positive, t.replies)} of replies`}
              delta={p ? { v: t.positive - p.positive, unit: '' } : undefined} vs={r.prev} />
            <Stat label="Calls booked" value={booked.toLocaleString()} sub={`${pctText(booked, t.leads.size)} of leads emailed`}
              delta={prevBooked != null ? { v: booked - prevBooked, unit: '' } : undefined} vs={r.prev} />
          </div>

          <section className="card chart-card">
            <header className="chart-head">
              <div>
                <select className="metric-select" value={metric} onChange={e => setMetric(e.target.value as Metric)} aria-label="Chart metric">
                  {METRICS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                </select>
                <div className="chart-headline">
                  <strong>{headline == null ? '—' : m.fmt(headline)}</strong>
                  {headline != null && prevHeadline != null && (
                    <span className="muted">
                      {metric === 'sent'
                        ? `${prevHeadline ? `${headline >= prevHeadline ? '+' : ''}${Math.round((100 * (headline - prevHeadline)) / prevHeadline)}%` : 'new'} vs ${r.prev}`
                        : `${headline >= prevHeadline ? '+' : ''}${(headline - prevHeadline).toFixed(1)} pts vs ${r.prev}`}
                    </span>
                  )}
                </div>
              </div>
              <span className="muted small">{r.label}</span>
            </header>
            <AreaChart points={points.map(x => ({ label: x.label, value: m.value(x.row), row: x.row }))} format={m.fmt} />
            <div className="mini-stats">
              <Mini label="Positive replies" value={t.positive} />
              <Mini label="Looms sent" value={t.looms} />
              <Mini label="Opted out" value={t.optOuts} />
              <Mini label="Clicks" value={t.clicked || '—'} title="Only campaigns with click tracking on count here." />
            </div>
          </section>
        </div>

        <TopInboxes sends={cur} inboxes={settings.inboxes} />
      </div>

      <Pipeline tracks={tracks} />

      <div className="dash-grid">
        <InboxHeatmap sends={scoped} inboxes={settings.inboxes} now={now} />
        <DomainList sends={cur} />
      </div>

      <BouncesByDay sends={scoped} inboxes={settings.inboxes} now={now} />
    </div>
  )
}

/** Where every lead who replied stands. The stages move by themselves; see api/_lib/pipeline.ts. */
function Pipeline({ tracks }: { tracks: TrackMap }) {
  const counts = useMemo(() => {
    const out = new Map<string, number>()
    for (const t of Object.values(tracks)) if (t.stage) out.set(t.stage, (out.get(t.stage) ?? 0) + 1)
    return out
  }, [tracks])
  return (
    <section className="card">
      <header className="list-head"><h2>Pipeline</h2><span className="muted small">Leads at each stage now</span></header>
      <div className="pipeline">
        {STAGES.map(s => <div key={s} className="pipe-stage"><strong>{counts.get(s) ?? 0}</strong><span className="small muted">{STAGE_LABEL[s]}</span></div>)}
      </div>
    </section>
  )
}

/** Change in percentage points between two rates, when both exist. */
const pts = (a: number | null, b: number | null | undefined) => (a != null && b != null ? { v: a - b, unit: ' pts' } : undefined)

function Stat({ label, value, sub, delta, vs, upIsBad }: {
  label: string; value: string; sub: string; delta?: { v: number; unit: string }; vs: string; upIsBad?: boolean
}) {
  const flat = !delta || Math.abs(delta.v) < 0.05
  const good = !flat && (delta!.v > 0) !== !!upIsBad
  return (
    <section className="stat">
      <header>
        <span className="stat-label">{label}</span>
        {delta && (
          <span className={flat ? 'delta' : good ? 'delta up' : 'delta down'} title={`vs ${vs}`}>
            {!flat && (delta.v > 0 ? <ArrowUp size={11} strokeWidth={3} /> : <ArrowDown size={11} strokeWidth={3} />)}
            {Math.abs(delta.v).toFixed(delta.unit === ' pts' ? 1 : 0)}{delta.unit}
          </span>
        )}
      </header>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </section>
  )
}

function Mini({ label, value, title }: { label: string; value: number | string; title?: string }) {
  return (
    <div className="mini" title={title}>
      <span>{label}</span>
      <strong>{typeof value === 'number' ? value.toLocaleString() : value}</strong>
    </div>
  )
}

// ---------- chart ----------

/** Smooth path through the points (monotone cubic, so the curve never overshoots below zero). */
function smooth(pts: [number, number][]) {
  if (pts.length < 2) return pts.length ? `M${pts[0][0]},${pts[0][1]}` : ''
  const n = pts.length
  const dx = pts.slice(1).map((q, i) => q[0] - pts[i][0])
  const sl = pts.slice(1).map((q, i) => (q[1] - pts[i][1]) / (dx[i] || 1))
  const m = pts.map((_, i) => (i === 0 ? sl[0] : i === n - 1 ? sl[n - 2] : sl[i - 1] * sl[i] <= 0 ? 0 : (sl[i - 1] + sl[i]) / 2))
  let d = `M${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3
    d += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`
  }
  return d
}

function AreaChart({ points, format }: { points: { label: string; value: number | null; row: Row }[]; format: (v: number) => string }) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const H = 240, padL = 40, padR = 12, padT = 12, padB = 26
  const plotW = Math.max(10, W - padL - padR), plotH = H - padT - padB
  const vals = points.map(p => p.value ?? 0)
  const max = Math.max(...vals, 0)
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000].find(v => Math.max(max, 1) / v <= 4) ?? 5000
  const top = Math.max(step, Math.ceil(max / step) * step)
  const x = (i: number) => padL + (points.length < 2 ? plotW / 2 : (i / (points.length - 1)) * plotW)
  const y = (v: number) => padT + plotH - (v / top) * plotH
  const xy = points.map((p, i) => [x(i), y(p.value ?? 0)] as [number, number])
  const line = smooth(xy)
  const every = Math.max(1, Math.ceil(points.length / Math.max(2, Math.floor(plotW / 70))))
  const empty = points.every(p => !p.row.sent)
  const pick = (clientX: number, el: Element) => {
    const bx = clientX - el.getBoundingClientRect().left
    const i = points.length < 2 ? 0 : Math.round(((bx - padL) / plotW) * (points.length - 1))
    setHover(Math.max(0, Math.min(points.length - 1, i)))
  }
  const h = hover != null ? points[hover] : null

  return (
    <div className="area-chart" ref={ref}>
      <svg width={W} height={H} onMouseMove={e => pick(e.clientX, e.currentTarget)} onMouseLeave={() => setHover(null)} role="img" aria-label="Trend chart">
        <defs>
          <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--chart)" stopOpacity="0.16" />
            <stop offset="100%" stopColor="var(--chart)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {Array.from({ length: top / step + 1 }, (_, k) => k * step).map(v => (
          <g key={v}>
            <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} className={v === 0 ? 'c-axis' : 'c-grid'} />
            <text x={padL - 10} y={y(v) + 4} className="c-tick" textAnchor="end">{format === METRICS[0].fmt ? v.toLocaleString() : `${v}%`}</text>
          </g>
        ))}
        {points.map((p, i) => ((i % every === 0 && points.length - 1 - i >= every * 0.7) || i === points.length - 1) && (
          <text key={i} x={x(i)} y={H - 6} className="c-tick" textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>{p.label}</text>
        ))}
        {!empty && points.length > 1 && <path d={`${line} L${x(points.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill="url(#area-fill)" />}
        {!empty && <path d={line} fill="none" stroke="var(--chart)" strokeWidth={2} strokeLinecap="round" />}
        {!empty && points.length === 1 && <circle cx={xy[0][0]} cy={xy[0][1]} r={4} fill="var(--chart)" />}
        {h && hover != null && !empty && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + plotH} className="c-guide" />
            <circle cx={xy[hover][0]} cy={xy[hover][1]} r={4.5} fill="var(--surface)" stroke="var(--chart)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {empty && <p className="chart-empty muted small">Nothing sent in this range.</p>}
      {h && hover != null && !empty && (
        <div className="c-tip" style={{ left: Math.min(Math.max(x(hover), 90), W - 90) }}>
          <strong>{h.label}</strong>
          <span>Sent <b>{h.row.sent}</b></span>
          <span>Open rate <b>{pctText(h.row.opened, h.row.tracked)}</b></span>
          <span>Replies <b>{h.row.replies}</b></span>
          {h.row.bounces > 0 && <span>Bounces <b>{h.row.bounces}</b></span>}
        </div>
      )}
    </div>
  )
}

// ---------- ranked lists ----------

const RANKS: { id: Metric; label: string }[] = [
  { id: 'openRate', label: 'Open rate' },
  { id: 'replyRate', label: 'Reply rate' },
  { id: 'sent', label: 'Sent' },
]

const TOP_N = 6

/** Every live inbox ranked by open rate, reply rate or volume, with a bar to compare them at a glance. */
function TopInboxes({ sends, inboxes }: { sends: Sent[]; inboxes: string[] }) {
  const [by, setBy] = useState<Metric>('openRate')
  const [all, setAll] = useState(false)
  const m = METRICS.find(x => x.id === by)!
  const rows = useMemo(() => {
    const list = [...group(sends, s => s.m.inbox, inboxes).values()]
    const sample = (r: Row) => (by === 'sent' ? r.sent : r.tracked)
    // Inboxes with enough sends rank first; thin ones follow, greyed out.
    return list.sort((a, b) => Number(sample(b) >= MIN_SAMPLE) - Number(sample(a) >= MIN_SAMPLE) || (m.value(b) ?? -1) - (m.value(a) ?? -1) || b.sent - a.sent)
  }, [sends, inboxes, by, m])
  const best = Math.max(...rows.map(r => m.value(r) ?? 0), by === 'sent' ? 1 : 0.0001)
  return (
    <section className="card list-card">
      <header className="list-head">
        <h2>Top inboxes</h2>
        <Segmented value={by} onChange={setBy} options={RANKS} />
      </header>
      <ol className="rank-list">
        {rows.slice(0, all ? rows.length : TOP_N).map((r, i) => {
          const v = m.value(r)
          const thin = by !== 'sent' && r.tracked < MIN_SAMPLE
          return (
            <li key={r.key} className={thin ? 'thin' : undefined} title={thin ? `Only ${r.tracked} tracked emails so far: too few to trust` : undefined}>
              <span className="rank">{i + 1}</span>
              <Avatar inbox={r.key} />
              <span className="rank-name">
                <span>{inboxPersona(r.key)}</span>
                <small>{r.key}</small>
              </span>
              <span className="rank-value">
                {v == null ? '—' : m.fmt(v)}
                <small>{by === 'sent' ? `${r.leads.size} leads` : `of ${by === 'openRate' ? r.tracked : r.leads.size}`}</small>
              </span>
              <span className="rank-bar"><span style={{ width: `${((v ?? 0) / best) * 100}%` }} /></span>
            </li>
          )
        })}
        {!rows.length && <li className="empty">No inboxes yet.</li>}
      </ol>
      {rows.length > TOP_N && (
        <button className="link-accent list-more" onClick={() => setAll(!all)}>{all ? 'Show top 6' : `Show all ${rows.length} inboxes`}</button>
      )}
    </section>
  )
}

function DomainList({ sends }: { sends: Sent[] }) {
  const rows = useMemo(() => [...group(sends, s => s.m.inbox.split('@')[1] ?? '—').values()]
    .sort((a, b) => (rate(b.opened, b.tracked) ?? -1) - (rate(a.opened, a.tracked) ?? -1)), [sends])
  return (
    <section className="card list-card">
      <header className="list-head"><h2>Sending domains</h2><span className="muted small">by open rate</span></header>
      <ol className="rank-list compact">
        {rows.map((r, i) => (
          <li key={r.key} className={r.tracked < MIN_SAMPLE ? 'thin' : undefined}>
            <span className="rank">{i + 1}</span>
            <span className="rank-name"><span>{r.key}</span><small>{r.sent.toLocaleString()} sent · {pctText(r.replies, r.leads.size)} replied · {pctText(r.bounces, r.sent)} bounced</small></span>
            <span className="rank-value">{pctText(r.opened, r.tracked)}</span>
          </li>
        ))}
        {!rows.length && <li className="empty">Nothing sent in this range.</li>}
      </ol>
    </section>
  )
}

// ---------- bounces by day ----------

/** Each sending day on its own: what went out that day and how much of it bounced, overall and per inbox. */
function BouncesByDay({ sends, inboxes, now }: { sends: Sent[]; inboxes: string[]; now: string }) {
  const days = useMemo(() => {
    const first = addDays(now, -20)
    const rows = group(sends.filter(s => s.day >= first), s => s.day)
    return [...rows.values()].sort((a, b) => b.key.localeCompare(a.key)).slice(0, 10).map(r => ({
      r, inbox: group(sends.filter(s => s.day === r.key), s => s.m.inbox),
    }))
  }, [sends, now])
  const cell = (r?: Row) => (r?.sent ? <>{r.bounces} <span className="muted">of {r.sent}</span></> : <span className="muted">·</span>)
  return (
    <section className="card flush">
      <header className="list-head"><h2>Bounces by day</h2><span className="muted small">bounced of emails sent that day</span></header>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr><th>Day</th><th className="num">All inboxes</th><th className="num">Rate</th>{inboxes.map(i => <th key={i} className="num" title={i}>{inboxPersona(i)} <small>@{i.split('@')[1]}</small></th>)}</tr>
          </thead>
          <tbody>
            {days.map(({ r, inbox }) => (
              <tr key={r.key}>
                <td className="nowrap">{r.key === now ? 'Today' : dateLabel(r.key, { weekday: 'short', month: 'short', day: 'numeric' })}</td>
                <td className="num">{cell(r)}</td>
                <td className="num">{pctText(r.bounces, r.sent)}</td>
                {inboxes.map(i => <td key={i} className="num">{cell(inbox.get(i))}</td>)}
              </tr>
            ))}
            {!days.length && <tr><td colSpan={3 + inboxes.length} className="muted small">Nothing sent yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------- open rate heatmap ----------

/** Open rate per inbox for each of the last days / weeks / months: spot an inbox sliding into spam early. */
function InboxHeatmap({ sends, inboxes, now }: { sends: Sent[]; inboxes: string[]; now: string }) {
  const [period, setPeriod] = useState<Period>('day')
  const { starts, overall, cells, names } = useMemo(() => {
    const n = PERIODS.find(x => x.id === period)!.n
    const current = periodStart(now, period)
    const starts = Array.from({ length: n }, (_, k) => shift(current, period, k - n + 1))
    const first = starts[0]
    const recent = sends.filter(s => s.day >= first)
    const overall = group(recent, s => periodStart(s.day, period))
    const cells = new Map<string, Map<string, Row>>()
    for (const s of recent) {
      if (!cells.has(s.m.inbox)) cells.set(s.m.inbox, new Map())
      const c = cells.get(s.m.inbox)!
      const k = periodStart(s.day, period)
      if (!c.has(k)) c.set(k, blank(k))
      add(c.get(k)!, s)
    }
    return { starts, overall, cells, names: inboxes }
  }, [sends, inboxes, period, now])
  const head = (s: string, k: number) => k === starts.length - 1
    ? (period === 'day' ? 'Today' : period === 'week' ? 'This wk' : 'This mo')
    : period === 'month' ? dateLabel(s, { month: 'short' }) : period === 'day' ? dateLabel(s, { weekday: 'short', day: 'numeric' }) : dateLabel(s, { month: 'short', day: 'numeric' })

  return (
    <section className="card heat-card">
      <header className="list-head">
        <div>
          <h2>Open rate by inbox</h2>
          <p className="muted small">Darker = more opens. One inbox far lighter than the rest is usually landing in spam.</p>
        </div>
        <Segmented value={period} onChange={setPeriod} options={PERIODS.map(x => ({ id: x.id, label: x.label }))} />
      </header>
      <div className="table-scroll">
        <table className="heat">
          <thead>
            <tr><th />{starts.map((s, k) => <th key={s}>{head(s, k)}</th>)}</tr>
          </thead>
          <tbody>
            <tr className="heat-all"><td>All inboxes</td>{starts.map(s => <HeatCell key={s} r={overall.get(s)} />)}</tr>
            {names.map(i => (
              <tr key={i}>
                <td title={i}><span className="heat-name">{inboxPersona(i)}<small>@{i.split('@')[1]}</small></span></td>
                {starts.map(s => <HeatCell key={s} r={cells.get(i)?.get(s)} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function HeatCell({ r }: { r?: Row }) {
  if (!r?.sent) return <td className="heat-cell none">·</td>
  const v = rate(r.opened, r.tracked)
  const thin = r.tracked < 10
  const alpha = v == null || thin ? 0 : Math.min(1, v / 40)
  return (
    <td className={thin ? 'heat-cell thin' : 'heat-cell'} title={`${r.sent} sent · ${r.opened} of ${r.tracked} tracked opened · ${r.replies} replies · ${r.bounces} bounces`}>
      <span style={{ background: `color-mix(in srgb, var(--chart) ${Math.round(alpha * 85)}%, transparent)`, color: alpha > 0.55 ? '#fff' : undefined }}>
        {v == null ? '—' : `${Math.round(v)}%`}
      </span>
    </td>
  )
}

export function Found({ ok, unknown }: { ok: boolean; unknown?: boolean }) {
  if (unknown && !ok) return <span className="badge badge-due">couldn't check</span>
  return ok ? <span className="badge badge-replied">found</span> : <span className="badge badge-bad">missing</span>
}
