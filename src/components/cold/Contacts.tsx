import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import type { Status } from '../../types'
import { STATUS_LABEL, formatDate, inboxPersona, relativeDue } from '../../tracking'
import { CopyEmail, Pager } from '../common'
import type { ColdProps } from './ColdApp'
import { Avatar, Segmented } from './campaign/ui'

const PAGE_SIZE = 50
const FILTERS: { id: Status | ''; label: string }[] = [
  { id: '', label: 'All' },
  { id: 'awaiting', label: 'In sequence' },
  { id: 'due', label: 'Follow-up due' },
  { id: 'replied', label: 'Replied' },
  { id: 'done', label: 'Finished' },
  { id: 'bad', label: 'Stopped' },
]
const PILL: Record<Status, string> = {
  new: 'pill-muted', awaiting: 'pill-blue', due: 'pill-warn', replied: 'pill-good', done: 'pill-muted', bad: 'pill-bad',
}

/** Everyone who has been emailed, most recent activity first. */
export default function Contacts({ leads, derived, tracks, campaigns, settings, now, onOpen }: ColdProps) {
  const [status, setStatus] = useState<Status | ''>('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(0)

  // Leads from archived campaigns drop out, unless they wrote back.
  const emailed = useMemo(() => {
    const archived = new Set(campaigns.campaigns.filter(c => c.status === 'done').map(c => c.id))
    return leads.filter(l => {
      const t = tracks[l.id]
      return t?.sentAt && (t.repliedAt || !archived.has(campaigns.members.get(l.id)?.campaignId ?? ''))
    })
  }, [leads, tracks, campaigns.campaigns, campaigns.members])
  const counts = useMemo(() => {
    const c: Record<string, number> = { '': emailed.length }
    for (const l of emailed) {
      const s = derived.get(l.id)!.status
      c[s] = (c[s] ?? 0) + 1
    }
    return c
  }, [emailed, derived])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return emailed
      .filter(l => !status || derived.get(l.id)!.status === status)
      .filter(l => !needle || `${l.businessName} ${l.email} ${l.city}`.toLowerCase().includes(needle))
      .map(l => {
        const t = tracks[l.id]!
        return { l, t, last: t.followUps.at(-1) ?? t.sentAt! }
      })
      .sort((a, b) => b.last.localeCompare(a.last))
  }, [emailed, derived, tracks, status, q])

  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages - 1)
  const shown = rows.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  const steps = settings.cadence.length + 1

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="search-box">
          <Search size={15} />
          <input placeholder="Search business, email or city" value={q} onChange={e => { setQ(e.target.value); setPage(0) }} />
        </label>
        <Segmented
          value={status}
          onChange={v => { setStatus(v); setPage(0) }}
          options={FILTERS.map(f => ({ id: f.id, label: `${f.label} ${(counts[f.id] ?? 0).toLocaleString()}` }))}
        />
      </div>

      <section className="card flush">
        <div className="table-scroll">
          <table className="table list-table">
            <thead>
              <tr><th>Lead</th><th>Email</th><th>Status</th><th>Sequence</th><th>Inbox</th><th>Last sent</th><th>Next</th></tr>
            </thead>
            <tbody>
              {shown.map(({ l, t, last }) => {
                const d = derived.get(l.id)!
                const sent = (t.sentAt ? 1 : 0) + t.followUps.length
                return (
                  <tr key={l.id} className="row-link" onClick={() => onOpen(l.id)}>
                    <td>
                      <div className="strong">{l.businessName}</div>
                      <div className="small muted">{l.city}</div>
                    </td>
                    <td onClick={e => e.stopPropagation()}><CopyEmail email={l.email} /></td>
                    <td>
                      <span className={`pill ${PILL[d.status]}`} title={t.badReason}>{d.status === 'bad' ? (t.badReason ?? 'Stopped') : STATUS_LABEL[d.status]}</span>
                    </td>
                    <td>
                      <span className="step-dots" title={`${sent} of ${steps} emails sent`}>
                        {Array.from({ length: steps }, (_, i) => (
                          <span key={i} className={i < sent ? (d.status === 'replied' && i === sent - 1 ? 'step-dot replied' : 'step-dot sent') : 'step-dot'}>{i + 1}</span>
                        ))}
                      </span>
                    </td>
                    <td>
                      {t.inbox ? <span className="who"><Avatar inbox={t.inbox} /><span><span>{inboxPersona(t.inbox)}</span><small>{t.inbox.split('@')[1]}</small></span></span> : <span className="muted">—</span>}
                    </td>
                    <td className="small nowrap">{formatDate(last)}</td>
                    <td className="small nowrap">{d.nextDue ? <span className={d.status === 'due' ? 'due-text' : ''}>{relativeDue(d.nextDue, now)}</span> : <span className="muted">—</span>}</td>
                  </tr>
                )
              })}
              {!shown.length && <tr><td colSpan={7} className="empty">No one has been emailed yet{status || q ? ' with these filters' : ''}.</td></tr>}
            </tbody>
          </table>
        </div>
        {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} total={rows.length} pageSize={PAGE_SIZE} />}
      </section>
    </div>
  )
}
