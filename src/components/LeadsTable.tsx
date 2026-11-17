import { useMemo, useState } from 'react'
import type { Shared } from '../App'
import type { Status } from '../types'
import { STATUS_LABEL, actions, formatDate, relativeDue } from '../tracking'
import { BadDataSelect, CopyDetails, CopyEmail, InboxSelect, Pager, StatusBadge, unique } from './common'
import { MediaCell } from './Media'

const PAGE_SIZES = [50, 100, 250, 500]

const NO_INBOX = '__none'

type Sort = 'priority' | 'name' | 'city' | 'reviews' | 'nextDue'

export default function LeadsTable({ leads, derived, tracks, settings, update, now, onOpen }: Shared) {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<Status | ''>('')
  const [wave, setWave] = useState('')
  const [group, setGroup] = useState('')
  const [hook, setHook] = useState('')
  const [city, setCity] = useState('')
  const [emailType, setEmailType] = useState('')
  const [media, setMedia] = useState<'' | 'done' | 'todo'>('')
  const [inbox, setInbox] = useState('') // '' = any, NO_INBOX = sent but not flagged
  const [sort, setSort] = useState<Sort>('priority')
  const [pageSize, setPageSize] = useState(100)
  // Each wave tab remembers its own page, so switching tabs and back keeps your place.
  const [pageByWave, setPageByWave] = useState<Record<string, number>>({})
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const options = useMemo(() => ({
    groups: unique(leads.map(l => l.nicheGroup)),
    hooks: unique(leads.map(l => l.hook)),
    cities: unique(leads.map(l => l.city)),
  }), [leads])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = leads.filter(l => {
      if (status && derived.get(l.id)!.status !== status) return false
      if (wave && String(l.wave) !== wave) return false
      if (group && l.nicheGroup !== group) return false
      if (hook && l.hook !== hook) return false
      if (city && l.city !== city) return false
      if (emailType && l.emailType !== emailType) return false
      if (media && !!tracks[l.id]?.mediaDone !== (media === 'done')) return false
      if (inbox === NO_INBOX ? !tracks[l.id]?.sentAt || !!tracks[l.id]?.inbox : inbox && tracks[l.id]?.inbox !== inbox) return false
      if (needle) {
        const hay = `${l.businessName} ${l.email} ${l.city} ${l.niche} ${l.specificCategory}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      return true
    })
    if (sort === 'name') list.sort((a, b) => a.businessName.localeCompare(b.businessName))
    if (sort === 'city') list.sort((a, b) => a.city.localeCompare(b.city))
    if (sort === 'reviews') list.sort((a, b) => (b.reviews ?? 0) - (a.reviews ?? 0))
    if (sort === 'nextDue') {
      const key = (id: string) => derived.get(id)!.nextDue ?? '9999'
      list.sort((a, b) => key(a.id).localeCompare(key(b.id)))
    }
    return list
  }, [leads, derived, tracks, q, status, wave, group, hook, city, emailType, media, inbox, sort])

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize))
  const page = Math.min(pageByWave[wave] ?? 0, pages - 1)
  const setPage = (p: number) => {
    setPageByWave(prev => ({ ...prev, [wave]: p }))
    document.querySelector('.wave-tabs')?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }
  const rows = filtered.slice(page * pageSize, (page + 1) * pageSize)

  const waveCounts = useMemo(() => {
    const c: Record<string, number> = { '': leads.length }
    for (const l of leads) c[l.wave] = (c[l.wave] ?? 0) + 1
    return c
  }, [leads])

  const resetPage = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPageByWave({}) }
  const anyFilter = q || status || group || hook || city || emailType || media || inbox

  const toggle = (id: string) => setSelected(prev => {
    const n = new Set(prev)
    if (n.has(id)) n.delete(id)
    else n.add(id)
    return n
  })
  const allOnPage = rows.length > 0 && rows.every(r => selected.has(r.id))
  const togglePage = () => setSelected(prev => {
    const n = new Set(prev)
    rows.forEach(r => (allOnPage ? n.delete(r.id) : n.add(r.id)))
    return n
  })
  const sel = [...selected]

  return (
    <div className="stack">
      <nav className="wave-tabs" aria-label="Wave">
        {['', '1', '2', '3', '4'].map(w => (
          <button
            key={w || 'all'}
            className={wave === w ? 'wave-tab active' : 'wave-tab'}
            aria-pressed={wave === w}
            onClick={() => { setWave(w); setSelected(new Set()) }}
          >
            {w ? `Wave ${w}` : 'All leads'}
            <span className="wave-count">{(waveCounts[w] ?? 0).toLocaleString()}</span>
          </button>
        ))}
      </nav>
      <section className="card filters">
        <input
          className="input search"
          placeholder="Search business, email, city, niche…"
          value={q}
          onChange={e => resetPage(setQ)(e.target.value)}
        />
        <select className="select" value={status} onChange={e => resetPage(setStatus)(e.target.value as Status | '')}>
          <option value="">All statuses</option>
          {(Object.keys(STATUS_LABEL) as Status[]).map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className="select" value={group} onChange={e => resetPage(setGroup)(e.target.value)}>
          <option value="">All niche groups</option>
          {options.groups.map(g => <option key={g}>{g}</option>)}
        </select>
        <select className="select" value={hook} onChange={e => resetPage(setHook)(e.target.value)}>
          <option value="">All hooks</option>
          {options.hooks.map(h => <option key={h}>{h}</option>)}
        </select>
        <select className="select" value={city} onChange={e => resetPage(setCity)(e.target.value)}>
          <option value="">All cities</option>
          {options.cities.map(c => <option key={c}>{c}</option>)}
        </select>
        <select className="select" value={emailType} onChange={e => resetPage(setEmailType)(e.target.value)}>
          <option value="">Any email type</option>
          <option value="business domain">Business domain</option>
          <option value="personal/free">Personal / free</option>
        </select>
        <select className="select" value={media} onChange={e => resetPage(setMedia)(e.target.value as '' | 'done' | 'todo')}>
          <option value="">Any media</option>
          <option value="done">Media done</option>
          <option value="todo">Media not done</option>
        </select>
        <select className="select" value={inbox} onChange={e => resetPage(setInbox)(e.target.value)}>
          <option value="">Any inbox</option>
          {settings.inboxes.map(i => <option key={i} value={i}>{i}</option>)}
          <option value={NO_INBOX}>Sent, no inbox flagged</option>
        </select>
        <select className="select" value={sort} onChange={e => resetPage(setSort)(e.target.value as Sort)} aria-label="Sort">
          <option value="priority">Sort: priority</option>
          <option value="name">Sort: business name</option>
          <option value="city">Sort: city</option>
          <option value="reviews">Sort: most reviews</option>
          <option value="nextDue">Sort: next follow-up</option>
        </select>
        {anyFilter && (
          <button className="btn btn-sm btn-ghost" onClick={() => {
            setQ(''); setStatus(''); setWave(''); setGroup(''); setHook(''); setCity(''); setEmailType(''); setMedia(''); setInbox(''); setPageByWave({})
          }}>Clear filters</button>
        )}
      </section>

      {sel.length > 0 && (
        <section className="bulkbar">
          <strong>{sel.length} selected</strong>
          <button className="btn btn-sm" onClick={() => update(sel, actions.markSent(now))}>Mark first email sent today</button>
          <select className="select select-sm" value="" onChange={e => e.target.value && update(sel, actions.setInbox(e.target.value === NO_INBOX ? undefined : e.target.value))} aria-label="Set inbox for selected">
            <option value="">Set inbox…</option>
            {settings.inboxes.map(i => <option key={i} value={i}>{i}</option>)}
            <option value={NO_INBOX}>Clear inbox</option>
          </select>
          <button className="btn btn-sm" onClick={() => update(sel, actions.setReplied(now))}>Mark replied</button>
          <button className="btn btn-sm btn-danger" onClick={() => update(sel, actions.setBad('Other'))}>Flag bad data</button>
          <button className="btn btn-sm btn-ghost" onClick={() => update(sel, actions.setBad(undefined))}>Unflag</button>
          <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </section>
      )}

      <section className="card flush">
        <Pager page={page} pages={pages} onPage={setPage} total={filtered.length} pageSize={pageSize}
          pageSizes={PAGE_SIZES} onPageSize={n => { setPageSize(n); setPageByWave({}) }} top />
        <div className="table-scroll">
          <table className="table leads">
            <thead>
              <tr>
                <th className="cb"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all shown" /></th>
                <th>Business</th>
                <th>Email</th>
                <th>Wave · hook</th>
                <th>Status</th>
                <th>First email</th>
                <th>Sent from</th>
                <th>Follow-ups</th>
                <th>Next follow-up</th>
                <th>Replied</th>
                <th>Bad data</th>
                <th>Media</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map(l => {
                const t = tracks[l.id]
                const d = derived.get(l.id)!
                return (
                  <tr key={l.id} className={`row-${d.status}`}>
                    <td className="cb"><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.businessName}`} /></td>
                    <td><div className="biz">
                      <button className="link strong" onClick={() => onOpen(l.id)}>{l.businessName}</button>
                      <span className="muted small">{l.specificCategory} · {l.city}</span>
                    </div></td>
                    <td><div className="email-cell">
                      <CopyEmail email={l.email} />
                      <span className="muted tiny">{l.emailType}</span>
                    </div></td>
                    <td>
                      <span className="chip">W{l.wave}</span> <span className="small">{l.hook}</span>
                    </td>
                    <td><StatusBadge status={d.status} /></td>
                    <td>
                      {t?.sentAt ? (
                        <span className="sent-cell">
                          <span className="check" aria-hidden>✓</span> {formatDate(t.sentAt)}
                          <button className="icon-btn" title="Undo: mark as not sent" onClick={() => update(l.id, actions.unmarkSent)}>↺</button>
                        </span>
                      ) : (
                        <button className="btn btn-sm" onClick={() => update(l.id, actions.markSent(now))}>Mark sent</button>
                      )}
                    </td>
                    <td><InboxSelect value={t?.inbox} inboxes={settings.inboxes} onChange={v => update(l.id, actions.setInbox(v))} /></td>
                    <td className="num">
                      {t?.sentAt ? `${t.followUps.length} / ${settings.cadence.length}` : '—'}
                    </td>
                    <td>
                      {d.nextDue ? (
                        <span className={d.status === 'due' ? 'due-text' : 'small'}>
                          {formatDate(d.nextDue)} <span className="muted tiny">{relativeDue(d.nextDue, now)}</span>
                        </span>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td>
                      <label className="toggle">
                        <input
                          type="checkbox"
                          checked={!!t?.repliedAt}
                          onChange={e => update(l.id, actions.setReplied(e.target.checked ? now : undefined))}
                        />
                        <span className="small">{t?.repliedAt ? formatDate(t.repliedAt) : 'No'}</span>
                      </label>
                    </td>
                    <td><BadDataSelect value={t?.badReason} onChange={v => update(l.id, actions.setBad(v))} /></td>
                    <td><MediaCell leadId={l.id} track={t} update={update} onOpen={() => onOpen(l.id)} /></td>
                    <td>
                      <span className="btn-group">
                        <CopyDetails lead={l} />
                        <button className="btn btn-sm btn-ghost" onClick={() => onOpen(l.id)}>Open</button>
                      </span>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr><td colSpan={13} className="empty">No leads match these filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <Pager page={page} pages={pages} onPage={setPage} total={filtered.length} pageSize={pageSize}
          pageSizes={PAGE_SIZES} onPageSize={n => { setPageSize(n); setPageByWave({}) }} />
      </section>
    </div>
  )
}
