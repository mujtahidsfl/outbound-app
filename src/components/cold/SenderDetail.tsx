import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, RefreshCw } from 'lucide-react'
import { api } from '../../api'
import { supabase } from '../../supabase'
import { LIVE_EVENTS, addDays, fetchAll, formatDate, inboxCap, inboxPersona, inboxTotal, isPositive, isWarmingUp, sentByInbox, warmupWeek } from '../../tracking'
import type { ReplyIntent } from '../../types'
import type { ColdProps } from './ColdApp'
import { when } from './data'
import { etDay, pctText } from './campaign/stats'
import { Avatar, Segmented, StackedBars } from './campaign/ui'

type Msg = { id: number; lead_id: string | null; thread_lead_id?: string | null; step: number; campaign_id: string | null; sent_at: string | null; tracked?: boolean; opened_at?: string | null }
type Ev = { lead_id: string | null; kind: string; intent: ReplyIntent | null; campaign_id: string | null; message_id: string; received_at: string | null; created_at: string }
type Warm = { day: string; sent: number; received: number; inbox_hits: number; saved: number }

type Range = '7' | '30' | 'all'
const RANGES: { id: Range; label: string }[] = [{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: 'all', label: 'All time' }]

function useSender(inbox: string) {
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [events, setEvents] = useState<Ev[]>([])
  const [warm, setWarm] = useState<Warm[]>([])
  const [error, setError] = useState<string>()
  const load = useCallback(async () => {
    const sent = (cols: string) => fetchAll<Msg>((from, to) => supabase.from('email_messages').select(cols).eq('inbox', inbox).eq('status', 'sent')
      .neq('source', 'test').order('id').range(from, to) as unknown as PromiseLike<{ data: Msg[] | null; error: { message: string } | null }>)
    const base = 'id,lead_id,step,campaign_id,sent_at'
    try {
      const [m, e, w] = await Promise.all([
        sent(`${base},tracked,opened_at`).catch(err => (/column/i.test(String(err?.message)) ? sent(base) : Promise.reject(err))),
        fetchAll<Ev>((from, to) => supabase.from('email_events').select('lead_id,kind,intent,campaign_id,message_id,received_at,created_at').eq('inbox', inbox).or(LIVE_EVENTS).order('id').range(from, to)),
        supabase.from('warmup_stats').select('day,sent,received,inbox_hits,saved').eq('inbox', inbox).order('day'),
      ])
      setMsgs(m)
      setEvents(e)
      setWarm((w.data ?? []) as Warm[])
      setError(undefined)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [inbox])
  useEffect(() => { load() }, [load])
  return { msgs, events, warm, error, load }
}

/** One sender account: what it sent and received, how warm-up is going, and what each campaign got out of it. */
export default function SenderDetail({ inbox, onBack, tracks, settings, now, data, campaigns }: ColdProps & { inbox: string; onBack: () => void }) {
  const { msgs, events, warm, error, load } = useSender(inbox)
  const [range, setRange] = useState<Range>('7')
  const [sync, setSync] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})
  const from = range === 'all' ? '' : addDays(now, 1 - Number(range))

  const cur = useMemo(() => msgs.filter(m => m.sent_at && etDay(m.sent_at) >= from), [msgs, from])
  const evs = useMemo(() => events.filter(e => etDay(e.received_at ?? e.created_at) >= from), [events, from])
  const wu = useMemo(() => warm.filter(w => w.day >= from), [warm, from])
  const sum = (key: keyof Warm) => wu.reduce((s, w) => s + Number(w[key]), 0)
  const human = evs.filter(e => e.kind === 'reply' || (e.kind === 'unsubscribe' && !e.message_id.startsWith('link:')))
  const bounces = evs.filter(e => e.kind === 'bounce').length

  const rows = useMemo(() => {
    const names = new Map(campaigns.campaigns.map(c => [c.id, c.name]))
    const out = new Map<string, { key: string; sent: number; tracked: number; opened: number; replies: Set<string>; positive: Set<string>; bounced: number }>()
    const row = (id: string | null) => {
      const key = id ?? ''
      if (!out.has(key)) out.set(key, { key, sent: 0, tracked: 0, opened: 0, replies: new Set(), positive: new Set(), bounced: 0 })
      return out.get(key)!
    }
    for (const m of cur) {
      const r = row(m.campaign_id)
      r.sent++
      if (m.tracked) r.tracked++
      if (m.opened_at) r.opened++
    }
    for (const e of evs) {
      const r = row(e.campaign_id)
      if (e.kind === 'bounce') r.bounced++
      if (e.kind === 'reply' && e.lead_id) r.replies.add(e.lead_id)
      if (e.kind === 'reply' && e.lead_id && isPositive(e.intent)) r.positive.add(e.lead_id)
    }
    return [...out.values()].sort((a, b) => b.sent - a.sent).map(r => ({ ...r, name: r.key ? names.get(r.key) ?? r.key : 'Looms and hand-written replies' }))
  }, [cur, evs, campaigns.campaigns])

  const days = useMemo(() => {
    const list = Array.from({ length: 14 }, (_, i) => addDays(now, i - 13))
    const count = (d: string) => msgs.filter(m => m.sent_at && etDay(m.sent_at) === d).length
    return { list, sent: list.map(count), warm: list.map(d => warm.find(w => w.day === d)?.sent ?? 0) }
  }, [msgs, warm, now])

  const syncWarmup = async () => {
    setSync({ busy: true })
    const r = await api<{ synced?: number; skipped?: string }>({ action: 'warmup-sync' }, '/api/inbox')
    if (r.error) return setSync({ msg: r.error, error: true })
    setSync({ msg: r.skipped ?? `Copied from Smartlead for ${r.synced} account${r.synced === 1 ? '' : 's'}.`, error: !!r.skipped })
    load()
  }

  const st = data.states[inbox]
  const connected = data.status?.passwords[inbox]
  const sentToday = inboxTotal(sentByInbox(tracks, now)[inbox])
  const cap = inboxCap(settings, inbox, now)
  const warming = isWarmingUp(settings, inbox, now)
  const last = [...msgs].reverse().find(m => m.sent_at)?.sent_at
  const noWarm = !warm.length
  const leads = Object.values(tracks).filter(t => t.inbox === inbox).length
  const stat = (label: string, value: string, sub: string) => (
    <section className="stat"><span className="stat-label">{label}</span><div className="stat-value">{value}</div><div className="stat-sub" title={sub}>{sub}</div></section>
  )

  return (
    <div className="stack">
      <header className="camp-head">
        <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> All email accounts</button>
        <div className="camp-title">
          <span className="who">
            <Avatar inbox={inbox} />
            <span><h2>{inboxPersona(inbox)}</h2><small>{inbox}</small></span>
          </span>
          <span className="row-wrap">
            <Segmented value={range} onChange={setRange} options={RANGES} />
            <button className="btn btn-sm" onClick={syncWarmup} disabled={sync.busy}><RefreshCw size={14} /> {sync.busy ? 'Syncing…' : 'Sync warm-up'}</button>
          </span>
        </div>
      </header>
      {sync.msg && <p className={sync.error ? 'small error-text' : 'small check'}>{sync.msg}</p>}
      {error && <p className="small error-text">Couldn't load: {error}</p>}

      <div className="stat-row stat-row-5">
        {stat('Warm-up emails sent', noWarm ? '—' : sum('sent').toLocaleString(), noWarm ? 'Connect Smartlead to see this' : 'through Smartlead')}
        {stat('Emails sent', cur.length.toLocaleString(), `${new Set(cur.flatMap(m => m.lead_id ?? [])).size.toLocaleString()} leads · ${pctText(bounces, cur.length)} bounced`)}
        {stat('Landed in inbox', noWarm ? '—' : sum('inbox_hits').toLocaleString(), noWarm ? 'From warm-up, via Smartlead' : `${pctText(sum('inbox_hits'), sum('sent'))} of warm-up emails`)}
        {stat('Saved from spam', noWarm ? '—' : sum('saved').toLocaleString(), noWarm ? 'From warm-up, via Smartlead' : `${pctText(sum('saved'), sum('sent'))} of warm-up emails`)}
        {stat('Emails received', (human.length + sum('received')).toLocaleString(), `${human.length} from leads${noWarm ? '' : ` · ${sum('received').toLocaleString()} warm-up`}`)}
      </div>

      <div className="dash-grid">
        <section className="card">
          <header className="list-head">
            <h2>Last 14 days</h2>
            <div className="legend"><span><i className="swatch s1" />Campaign emails</span><span><i className="swatch s2" />Warm-up</span></div>
          </header>
          <StackedBars labels={days.list.map(d => (d === now ? 'Today' : formatDate(d)))} height={220} empty="Nothing sent in the last 14 days."
            series={[{ name: 'Campaign emails', cls: 'fill-s1', values: days.sent }, { name: 'Warm-up', cls: 'fill-s2', values: days.warm }]} />
        </section>
        <section className="card">
          <header className="list-head"><h2>Outbound status</h2></header>
          <dl className="kv-list">
            <div><dt>Status</dt><dd>{!data.status ? '…' : !connected ? <span className="pill pill-muted">Not connected</span> : st?.error ? <span className="pill pill-bad" title={st.error}><i />Error</span> : <span className="pill pill-good"><i />Active</span>}</dd></div>
            <div><dt>Sent today</dt><dd>{sentToday} <span className="muted">/ {cap}</span></dd></div>
            <div><dt>Warm-up ramp</dt><dd>{warming ? `Week ${warmupWeek(settings, now, inbox) + 1}` : 'Finished'}</dd></div>
            <div><dt>Leads on this account</dt><dd>{leads.toLocaleString()}</dd></div>
            <div><dt>Last email sent</dt><dd>{last ? when.format(new Date(last)) : '—'}</dd></div>
            <div><dt>Replies last checked</dt><dd>{st?.checked_at ? when.format(new Date(st.checked_at)) : '—'}</dd></div>
          </dl>
        </section>
      </div>

      <section className="card flush">
        <header className="card-head pad"><h2>Campaigns</h2><span className="small muted">Only what this account sent</span></header>
        <div className="table-scroll"><table className="table compact">
          <thead><tr><th>Campaign</th><th className="num">Sent</th><th className="num">Opened</th><th className="num">Replied</th><th className="num">Positive</th><th className="num">Bounced</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td className="strong">{r.name}</td>
                <td className="num">{r.sent.toLocaleString()}</td>
                <td className="num">{r.tracked ? `${r.opened} · ${pctText(r.opened, r.tracked)}` : '—'}</td>
                <td className="num">{r.replies.size}</td>
                <td className="num">{r.positive.size}</td>
                <td className="num">{r.bounced} <span className="muted small">{pctText(r.bounced, r.sent)}</span></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="empty">Nothing sent in this range.</td></tr>}
          </tbody>
        </table></div>
      </section>
    </div>
  )
}
