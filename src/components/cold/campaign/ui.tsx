import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { STAGE_LABEL, actions, inboxPersona, type Updater } from '../../../tracking'
import { STAGES, type ReplyIntent, type Stage, type Track } from '../../../types'
import { INTENT_LABEL, pctText, rate, type Stat } from './stats'

const INTENT_CLS: Record<ReplyIntent, string> = {
  loom: 'badge-replied', meeting: 'badge-replied', interested: 'badge-replied', question: 'badge-awaiting', not_interested: 'badge-bad', other: 'badge-new',
}

export function IntentBadge({ intent }: { intent?: ReplyIntent | null }) {
  if (!intent) return null
  return <span className={`badge ${INTENT_CLS[intent]}`}>{INTENT_LABEL[intent]}</span>
}

// Steps 100+ are a lead's hand-written Loom (100) and its nudges (101-103), see api/_lib/loom.ts.
// Steps 200+ are subsequence emails, see api/_lib/subsequence.ts.
export const emailLabel = (step: number) => (step >= 200 ? `Subsequence email ${step - 199}` : step === 100 ? 'Loom' : step > 100 ? `Loom nudge ${step - 100}` : `Email ${step + 1}`)

/** Pipeline stage after a reply, plus the deal value once won. */
export function StageSelect({ leadId, track, update }: { leadId: string; track?: Track; update: Updater }) {
  const [value, setValue] = useState(track?.dealValue != null ? String(track.dealValue) : '')
  return (
    <span className="row-wrap nowrap">
      <select
        className={track?.stage ? 'select select-sm' : 'select select-sm unset'}
        value={track?.stage ?? ''}
        onChange={e => update(leadId, actions.setStage((e.target.value || undefined) as Stage | undefined))}
        aria-label="Pipeline stage"
      >
        <option value="">No stage</option>
        {STAGES.map(s => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
      </select>
      {track?.stage === 'won' && (
        <input
          className="input input-sm deal-input"
          inputMode="decimal"
          placeholder="$ value"
          value={value}
          onChange={e => setValue(e.target.value.replace(/[^\d.]/g, ''))}
          onBlur={() => update(leadId, actions.setDealValue(value ? Number(value) : undefined))}
          aria-label="Deal value"
        />
      )}
    </span>
  )
}

type SortKey = 'key' | 'leads' | 'openRate' | 'replies' | 'replyRate' | 'positiveRate' | 'booked' | 'won' | 'bounceRate'

/** One breakdown: leads contacted, replies, positive replies, bookings, wins and bounces per group. Click a header to sort. */
export function StatTable({ title, rows, note }: { title: string; rows: Stat[]; note?: string }) {
  const [sort, setSort] = useState<SortKey>('leads')
  const sorted = useMemo(() => {
    const v = (s: Stat): number | string => ({
      key: s.key, leads: s.leads, openRate: rate(s.opened, s.tracked), replies: s.replies, replyRate: rate(s.replies, s.leads), positiveRate: rate(s.positive, s.leads),
      booked: s.booked, won: s.won, bounceRate: rate(s.bounced, s.leads),
    })[sort]
    return [...rows].sort((a, b) => {
      const x = v(a), y = v(b)
      return typeof x === 'string' ? x.localeCompare(y as string, undefined, { numeric: true }) : (y as number) - x || b.leads - a.leads
    })
  }, [rows, sort])
  const th = (k: SortKey, label: string, num = true) => (
    <th className={num ? 'num' : undefined}>
      <button className={sort === k ? 'th-sort active' : 'th-sort'} onClick={() => setSort(k)}>{label}{sort === k ? ' ↓' : ''}</button>
    </th>
  )
  return (
    <section className="card">
      <header className="card-head"><h2>{title}</h2></header>
      {note && <p className="small muted cold-p">{note}</p>}
      <div className="table-scroll">
        <table className="table compact breakdown">
          <thead>
            <tr>
              {th('key', 'Group', false)}{th('leads', 'Leads')}{th('openRate', 'Open %')}{th('replies', 'Replies')}{th('replyRate', 'Reply %')}
              {th('positiveRate', 'Positive %')}{th('booked', 'Booked')}{th('won', 'Won')}{th('bounceRate', 'Bounce %')}
            </tr>
          </thead>
          <tbody>
            {sorted.map(s => (
              <tr key={s.key} className={s.leads < 20 ? 'low-sample' : undefined} title={s.leads < 20 ? 'Fewer than 20 leads: too few to trust the rates yet' : undefined}>
                <td>{s.key}</td>
                <td className="num">{s.leads.toLocaleString()}</td>
                <td className="num">{pctText(s.opened, s.tracked)}</td>
                <td className="num">{s.replies}</td>
                <td className="num strong">{pctText(s.replies, s.leads)}</td>
                <td className="num">{pctText(s.positive, s.leads)}</td>
                <td className="num">{s.booked || '—'}</td>
                <td className="num">{s.won ? `${s.won}${s.revenue ? ` · $${s.revenue.toLocaleString()}` : ''}` : '—'}</td>
                <td className="num">{pctText(s.bounced, s.leads)}</td>
              </tr>
            ))}
            {!sorted.length && <tr><td colSpan={9} className="empty">Nothing sent yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Width of an element, kept current as it resizes, so charts draw at real pixel size (text never scales). */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w] as const
}

/** Round initial for an inbox (or a person), tinted per domain so inboxes on one domain match. */
export function Avatar({ inbox, name }: { inbox: string; name?: string }) {
  const domain = inbox.split('@')[1] ?? inbox
  let h = 0
  for (const c of domain) h = (h * 31 + c.charCodeAt(0)) % 360
  return <span className="avatar" style={{ background: `hsl(${h} 55% 92%)`, color: `hsl(${h} 45% 32%)` }}>{(name ?? inboxPersona(inbox)).charAt(0).toUpperCase()}</span>
}

/** Pill-style switch between a few options. */
export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { id: T; label: string; title?: string }[] }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(o => (
        <button key={o.id} role="tab" aria-selected={value === o.id} title={o.title} className={value === o.id ? 'seg active' : 'seg'} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  )
}

/** Stacked bars: one bar per label, one colour per series. */
export function StackedBars({ labels, series, height = 200, empty }: {
  labels: string[]
  series: { name: string; cls: string; values: number[] }[]
  height?: number
  empty?: string
}) {
  const [ref, W] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const totals = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0))
  const max = Math.max(...totals, 1)
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find(v => max / v <= 4) ?? 2000
  const top = Math.ceil(max / step) * step
  const H = height, padL = 36, padR = 8, padB = 24, padT = 8
  const plotW = Math.max(10, W - padL - padR), plotH = H - padB - padT
  const slot = plotW / Math.max(1, labels.length)
  const bw = Math.max(3, Math.min(22, slot * 0.6))
  const y = (v: number) => padT + plotH - (v / top) * plotH
  const every = Math.max(1, Math.ceil(labels.length / Math.max(2, Math.floor(plotW / 64))))
  return (
    <div className="chart-wrap" ref={ref}>
      {totals.every(t => !t) && <p className="chart-empty muted small">{empty ?? 'Nothing yet.'}</p>}
      <svg width={W} height={H} className="bars" role="img" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: top / step + 1 }, (_, k) => k * step).map(t => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className={t === 0 ? 'c-axis' : 'c-grid'} />
            <text x={padL - 8} y={y(t) + 4} className="c-tick" textAnchor="end">{t}</text>
          </g>
        ))}
        {labels.map((l, i) => {
          let acc = 0
          const x = padL + i * slot + (slot - bw) / 2
          return (
            <g key={l + i} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} className={hover === i ? 'hit hit-on' : 'hit'} />
              {series.map(s => {
                const v = s.values[i] ?? 0
                if (!v) return null
                const top = y(acc + v), h = (v / Math.max(1, step * Math.ceil(max / step))) * plotH
                acc += v
                return <rect key={s.name} x={x} y={top} width={bw} height={Math.max(1, h - 1)} rx={3} className={s.cls} />
              })}
              {((i % every === 0 && labels.length - 1 - i >= every * 0.7) || i === labels.length - 1) && <text x={padL + i * slot + slot / 2} y={H - 6} className="c-tick" textAnchor="middle">{l}</text>}
            </g>
          )
        })}
      </svg>
      {hover !== null && (
        <div className="c-tip" style={{ left: Math.min(Math.max(padL + hover * slot + slot / 2, 80), W - 80) }}>
          <strong>{labels[hover]}</strong>
          {series.map(s => <span key={s.name}><i className={`swatch ${s.cls.replace('fill-', '')}`} />&nbsp;{s.name} <b>{s.values[hover] ?? 0}</b></span>)}
        </div>
      )}
    </div>
  )
}

export function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

export const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
