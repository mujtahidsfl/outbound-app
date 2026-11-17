import { useEffect, useMemo, useState } from 'react'
import { fetchCampaignEmails } from '../../../campaigns'
import { campaignEligible, composeCampaignEmail, derive, formatDate, relativeDue } from '../../../tracking'
import type { CampaignEmail, CampaignLead } from '../../../types'
import { CopyEmail, Pager, StatusBadge, unique } from '../../common'
import { when } from '../data'
import type { CampaignProps } from './CampaignView'
import { buildRows, type LeadRow } from './stats'
import { IntentBadge, StageSelect, emailLabel } from './ui'

const PAGE_SIZE = 100
type State = '' | 'queued' | 'needs-approval' | 'in-sequence' | 'replied' | 'positive' | 'booked' | 'bounced' | 'opted-out' | 'done' | 'do-not-send'
const STATES: { id: State; label: string }[] = [
  { id: '', label: 'Every lead' },
  { id: 'queued', label: 'Queued (not sent yet)' },
  { id: 'needs-approval', label: 'CHECK FIRST, not approved' },
  { id: 'in-sequence', label: 'In sequence' },
  { id: 'replied', label: 'Replied' },
  { id: 'positive', label: 'Positive reply' },
  { id: 'booked', label: 'Call booked' },
  { id: 'bounced', label: 'Bounced' },
  { id: 'opted-out', label: 'Said no / opted out' },
  { id: 'done', label: 'Sequence finished' },
  { id: 'do-not-send', label: 'DO NOT SEND' },
]

export default function CampaignLeads(props: CampaignProps) {
  const { campaign: c, campaigns, tracks, now, activity, update } = props
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const rowsBy = useMemo(() => new Map(buildRows(members, tracks, activity.messages, activity.events).map(r => [r.m.leadId, r])), [members, tracks, activity.messages, activity.events])
  const trades = useMemo(() => unique(members.map(m => m.trade)), [members])
  const [state, setState] = useState<State>('')
  const [trade, setTrade] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)
  const [open, setOpen] = useState<string | null>(null)
  const [msg, setMsg] = useState<string>()

  const match = (m: CampaignLead, s: State) => {
    const t = tracks[m.leadId], r = rowsBy.get(m.leadId)
    const d = derive(t, c.cadence, now)
    switch (s) {
      case '': return true
      case 'queued': return campaignEligible(m, c) && !t?.sentAt && !t?.badReason
      case 'needs-approval': return m.sendStatus === 'CHECK FIRST' && !m.approved
      case 'in-sequence': return d.status === 'awaiting' || d.status === 'due'
      case 'replied': return !!r?.reply
      case 'positive': return !!r?.positive
      case 'booked': return !!r?.booked
      case 'bounced': return !!r?.bounced
      case 'opted-out': return !!r?.optedOut
      case 'done': return d.status === 'done'
      case 'do-not-send': return m.sendStatus === 'DO NOT SEND'
    }
  }
  const needle = q.trim().toLowerCase()
  const list = members.filter(m => match(m, state) && (!trade || m.trade === trade) && (!needle || `${m.businessName} ${m.toEmail} ${m.city} ${m.offer}`.toLowerCase().includes(needle)))
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = list.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const approvable = list.filter(m => m.sendStatus === 'CHECK FIRST' && !m.approved)

  const approve = async (ids: string[], on: boolean) => setMsg(await campaigns.setApproved(ids, on))
  const bulk = () => {
    if (!confirm(`Approve ${approvable.length} CHECK FIRST lead${approvable.length === 1 ? '' : 's'} in this list? They join the send queue after the READY leads. Did you go through their "Check:" notes?`)) return
    approve(approvable.map(m => m.leadId), true)
  }
  const openLead = open ? members.find(m => m.leadId === open) : undefined

  return (
    <div className="stack">
      <section className="card filters">
        <input className="input search" placeholder="Search business, email, city or offer…" value={q} onChange={e => { setQ(e.target.value); setPage(0) }} />
        <select className="select" value={state} onChange={e => { setState(e.target.value as State); setPage(0) }} aria-label="Show">
          {STATES.map(s => <option key={s.id} value={s.id}>{s.label} ({members.filter(m => match(m, s.id)).length})</option>)}
        </select>
        <select className="select" value={trade} onChange={e => { setTrade(e.target.value); setPage(0) }} aria-label="Trade">
          <option value="">All trades</option>
          {trades.map(t => <option key={t}>{t}</option>)}
        </select>
        {approvable.length > 0 && <button className="btn btn-sm" onClick={bulk}>Approve {approvable.length} CHECK FIRST shown</button>}
        {msg && <span className="small error-text">{msg}</span>}
      </section>

      <section className="card flush">
        <div className="table-scroll">
          <table className="table leads">
            <thead>
              <tr><th>#</th><th>Business</th><th>Status</th><th>Emails</th><th>Next</th><th>Reply</th><th>Stage</th></tr>
            </thead>
            <tbody>
              {shown.map(m => {
                const t = tracks[m.leadId], r = rowsBy.get(m.leadId)
                const d = derive(t, c.cadence, now)
                return (
                  <tr key={m.leadId}>
                    <td className="small muted">{m.position + 1}</td>
                    <td>
                      <span className="biz">
                        <button className="link strong" onClick={() => setOpen(m.leadId)}>{m.businessName}</button>
                        <span className="small muted">{m.trade} · {m.city} · {m.tier}</span>
                      </span>
                    </td>
                    <td>
                      <SendStatus m={m} onApprove={on => approve([m.leadId], on)} />
                      {t?.sentAt && <div><StatusBadge status={d.status} /></div>}
                    </td>
                    <td><Steps r={r} total={c.steps.length} /></td>
                    <td className="small">{d.nextDue ? <span className={d.status === 'due' ? 'due-text' : ''}>{relativeDue(d.nextDue, now)}{d.status === 'due' && c.followUpsPaused ? ' (paused)' : ''}</span> : <span className="muted">—</span>}</td>
                    <td>{r?.reply ? <><IntentBadge intent={r.intent} /><div className="small muted">to {emailLabel(r.replyStep ?? 0)}</div></> : <span className="muted small">—</span>}</td>
                    <td><StageSelect key={m.leadId} leadId={m.leadId} track={t} update={update} /></td>
                  </tr>
                )
              })}
              {!shown.length && <tr><td colSpan={7} className="empty">No leads match.</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} total={list.length} pageSize={PAGE_SIZE} />}
      </section>

      {openLead && <LeadPanel {...props} m={openLead} r={rowsBy.get(openLead.leadId)} onClose={() => setOpen(null)} onApprove={on => approve([openLead.leadId], on)} />}
    </div>
  )
}

function SendStatus({ m, onApprove }: { m: CampaignLead; onApprove: (on: boolean) => void }) {
  if (m.sendStatus === 'READY') return <span className="badge badge-replied">READY</span>
  if (m.sendStatus === 'DO NOT SEND') return <span className="badge badge-bad">DO NOT SEND</span>
  return (
    <label className="toggle nowrap" title={m.checks.join('\n')}>
      <input type="checkbox" checked={m.approved} onChange={e => onApprove(e.target.checked)} />
      <span className={m.approved ? 'badge badge-awaiting' : 'badge badge-due'}>{m.approved ? 'Approved' : 'CHECK FIRST'}</span>
    </label>
  )
}

function Steps({ r, total }: { r?: LeadRow; total: number }) {
  return (
    <span className="step-dots">
      {Array.from({ length: total }, (_, i) => {
        const s = r?.sent.find(x => x.step === i)
        const replied = r?.reply && r.replyStep === i
        return (
          <span key={i} className={replied ? 'step-dot replied' : s ? 'step-dot sent' : 'step-dot'} title={s ? `Email ${i + 1} sent ${when.format(new Date(s.sent_at ?? s.created_at))}${s.subject_variant === 'B' ? ' (subject B)' : ''}${replied ? ' · they replied to this one' : ''}` : `Email ${i + 1} not sent`}>
            {i + 1}
          </span>
        )
      })}
    </span>
  )
}

/** One lead: the offer, what to check, all four emails as they'll be sent, and everything that happened. */
function LeadPanel({ campaign: c, settings, tracks, update, activity, m, r, onClose, onApprove }: CampaignProps & {
  m: CampaignLead
  r?: LeadRow
  onClose: () => void
  onApprove: (on: boolean) => void
}) {
  const [emails, setEmails] = useState<CampaignEmail[] | null>(null)
  const [error, setError] = useState<string>()
  const t = tracks[m.leadId]
  const inbox = t?.inbox ?? settings.inboxes[0]
  useEffect(() => {
    let cancelled = false
    fetchCampaignEmails(m.leadId).then(e => !cancelled && setEmails(e)).catch(e => !cancelled && setError(String(e.message ?? e)))
    return () => { cancelled = true }
  }, [m.leadId])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const events = activity.events.filter(e => e.lead_id === m.leadId)

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={e => e.stopPropagation()} role="dialog" aria-label={m.businessName}>
        <header className="drawer-head">
          <div>
            <h2>{m.businessName}</h2>
            <p className="muted small">{m.trade} · {m.city}{m.rating != null ? ` · ${m.rating}★ (${m.reviews ?? 0})` : ''} · Lead #{m.leadNo}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="drawer-body">
          <section className="drawer-section">
            <div className="row-wrap"><SendStatus m={m} onApprove={onApprove} /><CopyEmail email={m.toEmail} /></div>
            <p className="small"><strong>Offer:</strong> {m.offer} · {m.tier}{m.price ? ` $${m.price.toLocaleString()}` : ''}</p>
            {m.website && <p className="small"><a href={/^https?:/.test(m.website) ? m.website : `https://${m.website}`} target="_blank" rel="noreferrer">{m.website.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}</a></p>}
            {m.checks.length > 0 && <ul className="fix-list small">{m.checks.map(x => <li key={x}>Check: {x}</li>)}</ul>}
          </section>
          <section className="drawer-section">
            <h3>Pipeline</h3>
            <StageSelect leadId={m.leadId} track={t} update={update} />
            {t?.stageLog && <p className="small muted">{Object.entries(t.stageLog).map(([k, v]) => `${k.replace('_', ' ')} ${formatDate(v.slice(0, 10))}`).join(' · ')}</p>}
          </section>
          {events.length > 0 && (
            <section className="drawer-section">
              <h3>Inbox activity</h3>
              {events.map(e => (
                <div key={e.id} className="small">
                  <span className="muted">{when.format(new Date(e.received_at ?? e.created_at))}</span> · <strong>{e.kind}</strong>{e.step != null ? ` to ${emailLabel(e.step)}` : ''} <IntentBadge intent={e.intent} />
                  {e.snippet && <div className="muted">{e.snippet}</div>}
                </div>
              ))}
            </section>
          )}
          {error && <p className="small error-text">{error}</p>}
          {emails && c.steps.map((s, i) => {
            const sent = r?.sent.find(x => x.step === i)
            const e = composeCampaignEmail(c, m, emails, i, inbox, r?.sent.find(x => x.step === (s.replyTo ?? s.n) - 1)?.subject ?? undefined)
            return (
              <section className="drawer-section" key={s.n}>
                <h3>Email {s.n} · day {s.day} {sent ? `· sent ${when.format(new Date(sent.sent_at ?? sent.created_at))} from ${sent.inbox}` : ''}</h3>
                <p className="small"><strong>{sent?.subject ?? e.subject}</strong>{s.attachImages && <span className="chip">+ {c.images.length} screenshots</span>}</p>
                <pre className="preview email-preview">{e.body}</pre>
              </section>
            )
          })}
        </div>
      </aside>
    </div>
  )
}
