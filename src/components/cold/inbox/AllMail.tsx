import { useEffect, useState } from 'react'
import { ArrowLeft, ExternalLink, MailOpen, RefreshCw } from 'lucide-react'
import { api } from '../../../api'
import { when } from '../data'
import { Avatar } from '../campaign/ui'

type MailRow = { inbox: string; uid: number; from: string; name: string; subject: string; at: string; unread: boolean; link?: string }
type Mail = { to: string; body: string; attachments: string[] }

const PAGE = 50
const keyOf = (r: MailRow) => `${r.inbox}|${r.uid}`

/** Everything in the inboxes, read live from Gmail: lead or not, nothing here marks it read there. */
export default function AllMail({ accounts, open, onOpen }: { accounts: string[]; open: string | null; onOpen: (key: string | null) => void }) {
  const [account, setAccount] = useState('')
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [reload, setReload] = useState(0)
  const [state, setState] = useState<{ rows?: MailRow[]; failed?: { inbox: string; error: string }[]; error?: string; busy?: boolean }>({ busy: true })

  useEffect(() => {
    let stale = false
    setState(s => ({ ...s, busy: true, error: undefined }))
    api<{ rows: MailRow[]; failed: { inbox: string; error: string }[] }>({ action: 'all-mail', inbox: account, search, limit }, '/api/inbox').then(r => {
      if (!stale) setState(r.error ? { error: r.error } : { rows: r.rows, failed: r.failed })
    })
    return () => { stale = true }
  }, [account, search, limit, reload])

  const rows = state.rows ?? []
  const reading = rows.find(r => keyOf(r) === open)

  return (
    <>
      <section className="mi-list card flush">
        <header className="mi-tools">
          <form className="mi-search" onSubmit={e => { e.preventDefault(); setLimit(PAGE); setSearch(typed.trim()) }}>
            <input className="input input-sm" placeholder="Search all mail" value={typed} onChange={e => setTyped(e.target.value)} aria-label="Search all mail" />
          </form>
          <select className="select select-sm" value={account} onChange={e => { setAccount(e.target.value); setLimit(PAGE) }} aria-label="Sender account">
            <option value="">All sender accounts</option>
            {accounts.map(i => <option key={i}>{i}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => setReload(n => n + 1)} disabled={state.busy}><RefreshCw size={14} /> {state.busy ? 'Loading…' : 'Refresh'}</button>
        </header>
        {!!state.failed?.length && <p className="small error-text mi-mail-note" title={state.failed.map(f => `${f.inbox}: ${f.error}`).join('\n')}>Couldn't read {state.failed.map(f => f.inbox).join(', ')}.</p>}
        <ul className="mi-rows">
          {rows.map(r => (
            <li key={keyOf(r)}>
              <button className={`mi-row${keyOf(r) === open ? ' active' : ''}${r.unread ? ' unread' : ''}`} onClick={() => onOpen(keyOf(r))}>
                <Avatar inbox={r.from || r.name} name={r.name} />
                <span className="mi-row-body">
                  <span className="mi-row-top">
                    <strong>{r.name}</strong>
                    <time className="small muted">{when.format(new Date(r.at))}</time>
                  </span>
                  <span className="mi-row-subject">{r.subject}</span>
                  <span className="mi-row-tags"><span className="small muted clamp-1">{r.inbox}</span></span>
                </span>
              </button>
            </li>
          ))}
          {!rows.length && !state.busy && <li className="empty">{state.error ?? (search ? `Nothing matches "${search}".` : 'This inbox is empty.')}</li>}
          {rows.length >= limit && <li><button className="btn btn-sm mi-more" onClick={() => setLimit(n => n + PAGE)} disabled={state.busy}>{state.busy ? 'Loading…' : 'Load more'}</button></li>}
        </ul>
      </section>

      <section className="mi-read card flush">
        {reading
          ? <Reader key={open} row={reading} onBack={() => onOpen(null)} />
          : <div className="mi-empty muted"><MailOpen size={28} aria-hidden /><p className="small">Pick an email to read it.</p></div>}
      </section>
    </>
  )
}

function Reader({ row, onBack }: { row: MailRow; onBack: () => void }) {
  const [mail, setMail] = useState<Mail>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    let stale = false
    api<Mail>({ action: 'all-mail-read', inbox: row.inbox, uid: row.uid }, '/api/inbox').then(r => {
      if (stale) return
      if (r.error) setError(r.error)
      else setMail(r)
    })
    return () => { stale = true }
  }, [row.inbox, row.uid])

  return (
    <div className="mi-thread">
      <header className="mi-head">
        <button className="icon-btn mi-back" onClick={onBack} aria-label="Back to the list"><ArrowLeft size={16} /></button>
        <span className="mi-who">
          <strong>{row.subject}</strong>
          <span className="small muted">{row.name}{row.from && row.from !== row.name ? ` <${row.from}>` : ''}</span>
          <span className="small muted">To {mail?.to || row.inbox} · {when.format(new Date(row.at))}</span>
        </span>
        {row.link && <a className="btn btn-sm" href={row.link} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open in Gmail</a>}
      </header>
      <div className="mi-messages">
        {error ? <p className="small error-text">{error}</p> : !mail ? <p className="small muted">Loading…</p> : (
          <>
            <pre className="mi-body">{mail.body || '(This email has no text.)'}</pre>
            {!!mail.attachments.length && <p className="small muted">Attachments: {mail.attachments.join(', ')}</p>}
          </>
        )}
      </div>
    </div>
  )
}
