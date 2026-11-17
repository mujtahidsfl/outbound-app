import { useMemo, useState } from 'react'
import type { Shared } from '../App'
import type { Lead, Status } from '../types'
import { addDays, dailyCapacity, formatDate } from '../tracking'

type Counts = Record<Status, number>
type Tab = 'overview' | 'leads' | 'queue' | 'followups' | 'settings'

export default function Overview({ leads, derived, tracks, settings, now, counts, goTo }: Shared & {
  counts: Counts
  goTo: (t: Tab) => void
}) {
  const stats = useMemo(() => {
    let firstSent = 0, followSent = 0, overdue = 0
    for (const t of Object.values(tracks)) {
      if (t.sentAt) firstSent++
      followSent += t.followUps.length
    }
    for (const d of derived.values()) if (d.status === 'due' && d.nextDue! < now) overdue++
    const contacted = counts.awaiting + counts.due + counts.replied + counts.done
    return { firstSent, followSent, overdue, contacted }
  }, [tracks, derived, now, counts])

  const replyRate = stats.contacted ? (counts.replied / stats.contacted) * 100 : 0
  const pipeline = counts.awaiting + counts.due

  return (
    <div className="stack">
      <TodayTarget tracks={tracks} settings={settings} now={now} due={counts.due} goTo={goTo} />

      <section className="kpis">
        <Kpi label="Total leads" value={leads.length} sub={`${counts.new.toLocaleString()} not yet contacted`} />
        <Kpi
          label="Emails sent"
          value={stats.firstSent + stats.followSent}
          sub={`${stats.firstSent.toLocaleString()} first · ${stats.followSent.toLocaleString()} follow-ups`}
        />
        <Kpi label="Replies" value={counts.replied} sub={`${replyRate.toFixed(1)}% reply rate`} tone="good" />
        <Kpi label="In pipeline" value={pipeline} sub={`${counts.awaiting.toLocaleString()} awaiting · ${counts.done.toLocaleString()} sequence done`} />
        <Kpi
          label="Follow-ups due"
          value={counts.due}
          sub={stats.overdue ? `${stats.overdue} overdue` : 'None overdue'}
          tone={counts.due ? 'warn' : undefined}
          onClick={() => goTo('followups')}
        />
        <Kpi label="Bad data" value={counts.bad} sub={`${((counts.bad / leads.length) * 100).toFixed(1)}% of leads flagged`} tone={counts.bad ? 'bad' : undefined} />
      </section>

      <div className="grid-2">
        <section className="card">
          <header className="card-head">
            <h2>Emails sent, last 14 days</h2>
            <div className="legend">
              <span><i className="swatch s1" />First emails</span>
              <span><i className="swatch s2" />Follow-ups</span>
            </div>
          </header>
          <SendsChart tracks={tracks} now={now} />
        </section>

        <section className="card">
          <header className="card-head"><h2>Outreach funnel</h2></header>
          <Funnel
            steps={[
              { label: 'Leads (clean)', value: leads.length - counts.bad },
              { label: 'First email sent', value: stats.contacted },
              { label: 'Got a follow-up', value: Object.values(tracks).filter(t => t.followUps.length && !t.badReason).length },
              { label: 'Replied', value: counts.replied },
            ]}
          />
          <div className="status-strip">
            {(['new', 'awaiting', 'due', 'replied', 'done', 'bad'] as Status[]).map(s => (
              <div key={s} className="status-cell">
                <span className={`dot dot-${s}`} />
                <span className="small">{STATUS_SHORT[s]}</span>
                <strong>{counts[s].toLocaleString()}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="grid-2">
        <Breakdown title="By priority wave" leads={leads} derived={derived} group={l => `Wave ${l.wave}`} />
        <Breakdown title="By pitch hook" leads={leads} derived={derived} group={l => l.hook} />
      </div>
      <Breakdown title="By niche group" leads={leads} derived={derived} group={l => l.nicheGroup} />
    </div>
  )
}

/** Today's send target across every step of the sequence. Resets at midnight. */
function TodayTarget({ tracks, settings, now, due, goTo }: Pick<Shared, 'tracks' | 'settings' | 'now'> & {
  due: number
  goTo: (t: Tab) => void
}) {
  // steps[0] = first emails, steps[n] = follow-up n, all sent today.
  const steps = useMemo(() => {
    const s: number[] = new Array(settings.cadence.length + 1).fill(0)
    for (const t of Object.values(tracks)) {
      if (t.sentAt === now) s[0]++
      t.followUps.forEach((d, i) => {
        if (d !== now) return
        while (s.length <= i + 1) s.push(0)
        s[i + 1]++
      })
    }
    return s
  }, [tracks, now, settings.cadence.length])

  // During warm-up the inboxes can't reach the full target yet, so today's target is what they can send.
  const capacity = dailyCapacity(settings, now)
  const target = Math.min(settings.dailyEmailTarget, capacity)
  const sent = steps.reduce((a, b) => a + b, 0)
  const remaining = Math.max(0, target - sent)
  const pct = Math.min(100, (sent / Math.max(1, target)) * 100)

  return (
    <section className="card reminder">
      <div className="target-main">
        <h2>Today's target</h2>
        <p>
          <span className="big-num">{sent.toLocaleString()}</span>
          <span className="muted"> of {target.toLocaleString()} emails sent today</span>
        </p>
        {capacity < settings.dailyEmailTarget && (
          <p className="muted small">Warm-up: inboxes can send {capacity.toLocaleString()} today, rising to {settings.dailyEmailTarget.toLocaleString()} as warm-up finishes.</p>
        )}
        <span className={remaining ? 'meter meter-lg' : 'meter meter-lg meter-done'} aria-hidden><span style={{ width: `${pct}%` }} /></span>
        <p className="muted small">
          {remaining === 0
            ? <>Target hit{sent > target ? <>, plus <strong>{(sent - target).toLocaleString()}</strong> extra</> : null}. Nice work.</>
            : due > 0
              ? <><strong>{remaining.toLocaleString()}</strong> to go. Start with the <strong>{due.toLocaleString()}</strong> follow-up{due === 1 ? '' : 's'} due{due < remaining ? ', then fill the rest with first emails' : ''}.</>
              : <><strong>{remaining.toLocaleString()}</strong> to go. No follow-ups are due, so it's all first emails today.</>}
        </p>
        <div className="row-wrap">
          <button className="btn btn-sm" onClick={() => goTo('followups')}>Follow-ups</button>
          <button className="btn btn-sm" onClick={() => goTo('queue')}>First emails</button>
        </div>
      </div>
      <ul className="target-steps">
        {steps.map((n, i) => (
          <li key={i} className="target-step">
            <span className="small muted">{i === 0 ? 'First emails' : `Follow-up ${i}`}</span>
            <strong>{n.toLocaleString()}</strong>
          </li>
        ))}
      </ul>
    </section>
  )
}

const STATUS_SHORT: Record<Status, string> = {
  new: 'Not contacted',
  awaiting: 'Awaiting',
  due: 'Follow-up due',
  replied: 'Replied',
  done: 'Seq. done',
  bad: 'Bad data',
}

function Kpi({ label, value, sub, tone, progress, onClick }: {
  label: string
  value: number
  sub: string
  tone?: 'good' | 'warn' | 'bad'
  progress?: number
  onClick?: () => void
}) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag className={`kpi ${tone ? `kpi-${tone}` : ''} ${onClick ? 'kpi-link' : ''}`} onClick={onClick}>
      <span className="kpi-value">{value.toLocaleString()}</span>
      <span className="kpi-label">{label}</span>
      {progress !== undefined && (
        <span className="meter" aria-hidden><span style={{ width: `${progress * 100}%` }} /></span>
      )}
      <span className="kpi-sub">{sub}</span>
    </Tag>
  )
}

function SendsChart({ tracks, now }: { tracks: Shared['tracks']; now: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const days = useMemo(() => {
    const list = Array.from({ length: 14 }, (_, i) => ({ date: addDays(now, i - 13), first: 0, follow: 0 }))
    const idx = new Map(list.map((d, i) => [d.date, i]))
    for (const t of Object.values(tracks)) {
      if (t.sentAt && idx.has(t.sentAt)) list[idx.get(t.sentAt)!].first++
      for (const f of t.followUps) if (idx.has(f)) list[idx.get(f)!].follow++
    }
    return list
  }, [tracks, now])

  const max = Math.max(4, ...days.map(d => d.first + d.follow))
  const nice = niceMax(max)
  const W = 560, H = 220, padL = 32, padB = 26, padT = 10
  const plotW = W - padL - 8, plotH = H - padB - padT
  const slot = plotW / days.length
  const bw = Math.min(26, slot - 8)
  const y = (v: number) => padT + plotH - (v / nice) * plotH
  const ticks = [0, nice / 2, nice]
  const total = days.reduce((s, d) => s + d.first + d.follow, 0)

  return (
    <div className="chart-wrap">
      {total === 0 && <p className="chart-empty muted small">No emails logged yet. Mark leads as sent and they show up here.</p>}
      <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Emails sent per day for the last 14 days">
        {ticks.map(t => (
          <g key={t}>
            <line x1={padL} x2={W - 8} y1={y(t)} y2={y(t)} className={t === 0 ? 'axis' : 'grid'} />
            <text x={padL - 6} y={y(t) + 4} className="tick" textAnchor="end">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = padL + i * slot + (slot - bw) / 2
          const hFirst = (d.first / nice) * plotH
          const hFollow = (d.follow / nice) * plotH
          const gap = d.first && d.follow ? 2 : 0
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} className={hover === i ? 'hit hit-on' : 'hit'} />
              {d.first > 0 && <Bar x={x} y={y(d.first)} w={bw} h={hFirst} top={!d.follow} cls="fill-s1" />}
              {d.follow > 0 && <Bar x={x} y={y(d.first + d.follow)} w={bw} h={hFollow - gap} top cls="fill-s2" />}
              {(i % 2 === 1 || i === 13) && (
                <text x={padL + i * slot + slot / 2} y={H - 8} className="tick" textAnchor="middle">
                  {i === 13 ? 'Today' : formatDate(d.date)}
                </text>
              )}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="tooltip" style={{ left: `${((padL + hover * slot + slot / 2) / W) * 100}%` }}>
          <strong>{formatDate(days[hover].date)}</strong>
          <span><i className="swatch s1" />First emails <b>{days[hover].first}</b></span>
          <span><i className="swatch s2" />Follow-ups <b>{days[hover].follow}</b></span>
        </div>
      )}
    </div>
  )
}

/** A bar with 4px rounding on the data end only. */
function Bar({ x, y, w, h, top, cls }: { x: number; y: number; w: number; h: number; top: boolean; cls: string }) {
  if (h <= 0) return null
  const r = top ? Math.min(4, h, w / 2) : 0
  const d = `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
  return <path d={d} className={cls} />
}

function niceMax(v: number) {
  const steps = [4, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000]
  return steps.find(s => s >= v) ?? Math.ceil(v / 1000) * 1000
}

function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(1, steps[0].value)
  return (
    <div className="funnel">
      {steps.map((s, i) => (
        <div key={s.label} className="funnel-row" title={`${s.label}: ${s.value.toLocaleString()}`}>
          <span className="funnel-label small">{s.label}</span>
          <span className="funnel-track">
            <span className="funnel-bar" style={{ width: `${Math.max(s.value ? 0.5 : 0, (s.value / max) * 100)}%` }} />
          </span>
          <span className="funnel-value">
            {s.value.toLocaleString()}
            {i > 0 && steps[i - 1].value > 0 && (
              <span className="muted small"> · {((s.value / steps[i - 1].value) * 100).toFixed(i === 1 ? 1 : 0)}%</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

function Breakdown({ title, leads, derived, group }: {
  title: string
  leads: Lead[]
  derived: Shared['derived']
  group: (l: Lead) => string
}) {
  const rows = useMemo(() => {
    const m = new Map<string, { total: number; contacted: number; replied: number; due: number; bad: number }>()
    for (const l of leads) {
      const k = group(l)
      const r = m.get(k) ?? { total: 0, contacted: 0, replied: 0, due: 0, bad: 0 }
      const s = derived.get(l.id)!.status
      r.total++
      if (s === 'awaiting' || s === 'due' || s === 'replied' || s === 'done') r.contacted++
      if (s === 'replied') r.replied++
      if (s === 'due') r.due++
      if (s === 'bad') r.bad++
      m.set(k, r)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
  }, [leads, derived, group])

  return (
    <section className="card">
      <header className="card-head"><h2>{title}</h2></header>
      <div className="table-scroll">
        <table className="table breakdown">
          <thead>
            <tr>
              <th>Group</th>
              <th className="num">Leads</th>
              <th>Contacted</th>
              <th className="num">Replied</th>
              <th className="num">Reply %</th>
              <th className="num">Due</th>
              <th className="num">Bad</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([k, r]) => (
              <tr key={k}>
                <td>{k}</td>
                <td className="num">{r.total.toLocaleString()}</td>
                <td>
                  <span className="inline-meter" title={`${r.contacted} of ${r.total - r.bad} clean leads`}>
                    <span className="meter"><span style={{ width: `${(r.contacted / Math.max(1, r.total - r.bad)) * 100}%` }} /></span>
                    <span className="num small">{r.contacted.toLocaleString()}</span>
                  </span>
                </td>
                <td className="num">{r.replied}</td>
                <td className="num">{r.contacted ? `${((r.replied / r.contacted) * 100).toFixed(1)}%` : '—'}</td>
                <td className="num">{r.due || '—'}</td>
                <td className="num">{r.bad || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
