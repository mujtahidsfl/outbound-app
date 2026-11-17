import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlarmClock, Archive, ArchiveRestore, ArrowLeft, Bell, CalendarClock, Inbox, MailOpen, Mails, PenLine, RefreshCw, Send, ShieldAlert, Star, Bot, Mail, type LucideIcon,
} from 'lucide-react'
import { api } from '../../../api'
import { STAGE_LABEL, actions, inboxPersona, stageAfterReply } from '../../../tracking'
import type { ReplyIntent } from '../../../types'
import type { ColdProps } from '../ColdApp'
import { when, type Evt } from '../data'
import { INTENT_LABEL } from '../campaign/stats'
import { Avatar, IntentBadge, StageSelect, emailLabel } from '../campaign/ui'
import AllMail from './AllMail'
import { useInbox, type ThreadMessage, type ThreadState } from './useInbox'

type Folder = 'unread' | 'all' | 'important' | 'snoozed' | 'reminders' | 'scheduled' | 'sent' | 'archived' | 'auto' | 'bounces'

const FOLDERS: { id: Folder; label: string; icon: LucideIcon }[] = [
  { id: 'unread', label: 'Unread replies', icon: Mail },
  { id: 'all', label: 'All replies', icon: Inbox },
  { id: 'important', label: 'Important', icon: Star },
  { id: 'snoozed', label: 'Snoozed', icon: AlarmClock },
  { id: 'reminders', label: 'Reminders', icon: Bell },
  { id: 'scheduled', label: 'Scheduled', icon: CalendarClock },
  { id: 'sent', label: 'Sent', icon: Send },
  { id: 'archived', label: 'Archived', icon: Archive },
  { id: 'auto', label: 'Auto-replies', icon: Bot },
  { id: 'bounces', label: 'Bounces & opt-outs', icon: ShieldAlert },
]

/** One row of the middle column. */
type Row = { key: string; leadId: string | null; name: string; subject: string; snippet: string; at: string; inbox: string; intent?: ReplyIntent | null; tag?: string; unread?: boolean; important?: boolean }

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  if (m < 0) return '' // scheduled: the row says when
  return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : when.format(new Date(iso)).split(',')[0]
}

/** Where the quoted thread starts in an email, so the new part can show on its own. */
function quoteStart(text: string) {
  const m = /^\s*(>|On .{5,120}wrote:\s*$|-{2,}\s*Original Message|From:\s.+)/im.exec(text)
  return m ? m.index : -1
}

/** Later today, tomorrow morning and next Monday morning, for snoozes and reminders. */
function presets() {
  const at = (days: number, hour: number) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d }
  const later = new Date(Date.now() + 3 * 3600_000)
  return [
    { label: 'In 3 hours', at: later },
    { label: 'Tomorrow, 9 AM', at: at(1, 9) },
    { label: 'In 3 days', at: at(3, 9) },
    { label: 'Next week', at: at(((8 - new Date().getDay()) % 7) || 7, 9) },
  ]
}

/** Every reply across every inbox: read the whole conversation and answer from the inbox they wrote to. */
export default function MasterInbox(props: ColdProps & { initialLead?: string | null }) {
  const { leads, data, settings, compose, initialLead } = props
  const box = useInbox()
  const [folder, setFolder] = useState<Folder>('unread')
  // All mail reads Gmail live, so it isn't a folder of conversations: `open` holds an email there, not a lead.
  const [allMail, setAllMail] = useState(false)
  const [q, setQ] = useState('')
  const [account, setAccount] = useState('')
  const [category, setCategory] = useState('')
  const [open, setOpen] = useState<string | null>(initialLead ?? null)
  const [sync, setSync] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})
  const names = useMemo(() => new Map(leads.map(l => [l.id, l.businessName])), [leads])
  const nowMs = Date.now()

  const convos = useMemo(() => {
    const latest = new Map<string, Evt>()
    for (const e of data.events) {
      if (!e.lead_id || (e.kind !== 'reply' && e.kind !== 'unsubscribe')) continue
      const cur = latest.get(e.lead_id)
      if (!cur || (e.received_at ?? e.created_at) > (cur.received_at ?? cur.created_at)) latest.set(e.lead_id, e)
    }
    return [...latest.values()]
  }, [data.events])

  const state = (id: string): ThreadState | undefined => box.threads.get(id)
  const snoozed = (s?: ThreadState) => !!s?.snoozed_until && Date.parse(s.snoozed_until) > nowMs
  const inFolder = (f: 'all' | 'unread' | 'important' | 'snoozed' | 'reminders' | 'archived', id: string) => {
    const s = state(id)
    switch (f) {
      case 'all': return !s?.archived_at && !snoozed(s)
      case 'unread': return !s?.archived_at && !snoozed(s) && !!s?.unread
      case 'important': return !s?.archived_at && !!s?.important
      case 'snoozed': return snoozed(s)
      case 'reminders': return !!s?.remind_at
      case 'archived': return !!s?.archived_at
    }
  }
  const rowOf = (e: Evt): Row => {
    const id = e.lead_id
    return {
      key: `e${e.id}`, leadId: id, name: (id && names.get(id)) || e.from_email || 'Unknown', subject: e.subject || '(no subject)', snippet: e.snippet ?? '',
      at: e.received_at ?? e.created_at, inbox: e.inbox, intent: e.kind === 'reply' ? e.intent : undefined,
      tag: e.kind === 'unsubscribe' ? 'Unsubscribed' : e.kind === 'bounce' ? 'Bounced' : e.kind === 'auto' ? 'Auto-reply' : undefined,
      unread: id ? state(id)?.unread : false, important: id ? state(id)?.important : false,
    }
  }

  const count = (f: Folder) => {
    if (f === 'scheduled') return box.scheduled.length
    if (f === 'sent') return data.messages.filter(m => m.status === 'sent').length
    if (f === 'auto') return data.events.filter(e => e.kind === 'auto').length
    if (f === 'bounces') return data.events.filter(e => e.kind === 'bounce' || e.kind === 'unsubscribe').length
    return convos.filter(e => inFolder(f, e.lead_id!)).length
  }

  const rows = useMemo<Row[]>(() => {
    let list: Row[]
    if (folder === 'scheduled') {
      list = box.scheduled.map(s => ({ key: `s${s.id}`, leadId: s.lead_id, name: names.get(s.lead_id) ?? s.to_email, subject: s.subject, snippet: s.body.slice(0, 160), at: s.send_at, inbox: s.inbox, tag: s.status === 'failed' ? 'Failed' : `Sends ${when.format(new Date(s.send_at))}` }))
    } else if (folder === 'sent') {
      list = data.messages.filter(m => m.status === 'sent').map(m => {
        const id = m.lead_id ?? m.thread_lead_id ?? null
        return { key: `m${m.id}`, leadId: id, name: (id && names.get(id)) || m.to_email, subject: m.subject ?? '', snippet: '', at: m.sent_at ?? m.created_at, inbox: m.inbox, tag: m.source === 'test' ? 'Test' : m.source === 'gmail' ? 'From Gmail' : m.step || m.lead_id ? emailLabel(m.step) : 'Reply' }
      })
    } else if (folder === 'auto' || folder === 'bounces') {
      const kinds = folder === 'auto' ? ['auto'] : ['bounce', 'unsubscribe']
      list = data.events.filter(e => kinds.includes(e.kind)).map(rowOf)
    } else {
      list = convos.filter(e => inFolder(folder, e.lead_id!)).map(rowOf)
    }
    const n = q.trim().toLowerCase()
    return list
      .filter(r => !account || r.inbox === account)
      .filter(r => !category || r.intent === category)
      .filter(r => !n || `${r.name} ${r.subject} ${r.snippet} ${r.leadId ?? ''}`.toLowerCase().includes(n))
      .sort((a, b) => (folder === 'scheduled' ? a.at.localeCompare(b.at) : b.at.localeCompare(a.at)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, box.scheduled, box.threads, data.messages, data.events, convos, names, q, account, category])

  const checkNow = async () => {
    setSync({ busy: true })
    const r = await api<{ inboxes: Record<string, { reply?: number; unsubscribe?: number; bounce?: number; error?: string }> }>({ action: 'sync-replies' })
    if (r.error) return setSync({ msg: r.error, error: true })
    const all = Object.values(r.inboxes)
    const found = all.reduce((n, x) => n + (x.reply ?? 0) + (x.unsubscribe ?? 0) + (x.bounce ?? 0), 0)
    const failed = all.filter(x => x.error).length
    setSync({ msg: `${found} new.${failed ? ` ${failed} inbox${failed === 1 ? '' : 'es'} couldn't be checked.` : ''}`, error: failed > 0 })
    data.refresh()
    box.refresh()
  }

  const accounts = [...new Set([...settings.inboxes, ...(settings.retiredInboxes ?? [])])]
  const select = (leadId: string | null) => {
    setOpen(leadId)
    if (leadId && state(leadId)?.unread) box.patch(leadId, { unread: false }).then(data.refresh)
  }

  return (
    <div className={open ? 'mi mi-reading' : 'mi'}>
      {!box.ready && <p className="notice mi-notice">Run <code>supabase/master_inbox.sql</code> in Supabase to turn on read status, snooze, reminders, scheduling and full email bodies.</p>}
      <nav className="mi-folders card" aria-label="Inbox folders">
        <button className="btn btn-primary mi-compose" onClick={() => compose()}><PenLine size={14} /> New email</button>
        {FOLDERS.map(f => {
          const n = count(f.id)
          const on = !allMail && folder === f.id
          return (
            <button key={f.id} className={on ? 'mi-folder active' : 'mi-folder'} aria-current={on ? 'page' : undefined} onClick={() => { if (allMail) setOpen(null); setAllMail(false); setFolder(f.id) }}>
              <f.icon size={15} aria-hidden /> <span>{f.label}</span>
              {n > 0 && <span className={f.id === 'unread' ? 'nav-count alert' : 'nav-count'}>{n}</span>}
            </button>
          )
        })}
        <button className={allMail ? 'mi-folder active' : 'mi-folder'} aria-current={allMail ? 'page' : undefined} onClick={() => { if (!allMail) setOpen(null); setAllMail(true) }}>
          <Mails size={15} aria-hidden /> <span>All mail</span>
        </button>
      </nav>

      {allMail ? <AllMail accounts={accounts} open={open} onOpen={setOpen} /> : <>
      <section className="mi-list card flush">
        <header className="mi-tools">
          <input className="input input-sm" placeholder="Search" value={q} onChange={e => setQ(e.target.value)} aria-label="Search conversations" />
          <select className="select select-sm" value={account} onChange={e => setAccount(e.target.value)} aria-label="Sender account">
            <option value="">All sender accounts</option>
            {accounts.map(i => <option key={i}>{i}</option>)}
          </select>
          <select className="select select-sm" value={category} onChange={e => setCategory(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {(Object.keys(INTENT_LABEL) as ReplyIntent[]).map(k => <option key={k} value={k}>{INTENT_LABEL[k]}</option>)}
          </select>
          <button className="btn btn-sm" onClick={checkNow} disabled={sync.busy} title="Inboxes are also checked every 5 minutes"><RefreshCw size={14} /> {sync.busy ? 'Checking…' : 'Check now'}</button>
          {sync.msg && <span className={sync.error ? 'small error-text' : 'small check'}>{sync.msg}</span>}
        </header>
        <ul className="mi-rows">
          {rows.map(r => (
            <li key={r.key}>
              <button className={`mi-row${r.leadId && r.leadId === open ? ' active' : ''}${r.unread ? ' unread' : ''}`} onClick={() => r.leadId && select(r.leadId)} disabled={!r.leadId}>
                <Avatar inbox={r.leadId ?? r.name} name={r.name} />
                <span className="mi-row-body">
                  <span className="mi-row-top">
                    <strong>{r.name}</strong>
                    {r.important && <Star size={12} className="mi-star" aria-label="Important" />}
                    <time className="small muted">{ago(r.at)}</time>
                  </span>
                  <span className="mi-row-subject">{r.subject}</span>
                  {r.snippet && <span className="small muted clamp-1">{r.snippet}</span>}
                  <span className="mi-row-tags">
                    <IntentBadge intent={r.intent} />
                    {r.tag && <span className="chip">{r.tag}</span>}
                    <span className="small muted clamp-1">{r.inbox}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
          {!rows.length && <li className="empty">{data.loadError ? `Couldn't load: ${data.loadError}` : folder === 'unread' ? "You're all caught up." : 'Nothing here.'}</li>}
        </ul>
      </section>

      <section className="mi-read card flush">
        {open
          ? <Conversation key={open} {...props} leadId={open} name={names.get(open) ?? open} box={box} state={state(open)} onBack={() => setOpen(null)} scheduledFolder={folder === 'scheduled'} />
          : <div className="mi-empty muted"><MailOpen size={28} aria-hidden /><p className="small">Pick a conversation to read it.</p></div>}
      </section>
      </>}
    </div>
  )
}

function Conversation({ leadId, name, box, state, onBack, data, tracks, update, onOpen, settings }: ColdProps & {
  leadId: string; name: string; box: ReturnType<typeof useInbox>; state?: ThreadState; onBack: () => void; scheduledFolder: boolean
}) {
  const [messages, setMessages] = useState<ThreadMessage[] | null>(null)
  const [error, setError] = useState<string>()
  const [form, setForm] = useState({ inbox: '', to: '', subject: '', body: '' })
  const [later, setLater] = useState('')
  const [picker, setPicker] = useState<'snooze' | 'remind' | null>(null)
  const [custom, setCustom] = useState('')
  const [note, setNote] = useState(state?.remind_note ?? '')
  const [send, setSend] = useState<{ busy?: boolean; msg?: string; error?: boolean }>({})
  const end = useRef<HTMLDivElement>(null)
  const track = tracks[leadId]
  const reply = data.events.filter(e => e.lead_id === leadId && e.kind === 'reply').sort((a, b) => (b.received_at ?? '').localeCompare(a.received_at ?? ''))[0]
  const pending = box.scheduled.filter(s => s.lead_id === leadId)

  const load = async () => {
    const r = await api<{ messages: ThreadMessage[]; defaults: { inbox: string; to: string; subject: string } }>({ action: 'thread', leadId }, '/api/inbox')
    if (r.error) return setError(r.error)
    setMessages(r.messages)
    setForm(f => ({ ...r.defaults, body: f.body }))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [leadId])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const submit = async (sendAt?: string) => {
    setSend({ busy: true })
    const r = await api({ action: 'reply', leadId, ...form, sendAt }, '/api/inbox')
    if (r.error) return setSend({ msg: r.error, error: true })
    setSend({ msg: r.warning ?? (sendAt ? `Scheduled for ${when.format(new Date(sendAt))}.` : 'Sent.') })
    setForm(f => ({ ...f, body: '' }))
    setLater('')
    data.refresh()
    box.refresh()
    if (!sendAt) load()
  }
  const cancel = async (id: number) => {
    const r = await api({ action: 'cancel-scheduled', id }, '/api/inbox')
    if (r.error) setSend({ msg: r.error, error: true })
    box.refresh()
  }
  const setIntent = (intent: ReplyIntent) => {
    if (!reply) return
    data.setIntent(reply.id, intent)
    update(leadId, actions.setStage(stageAfterReply(track?.stage, intent)))
  }
  const pick = (at: Date) => {
    const iso = at.toISOString()
    box.patch(leadId, picker === 'snooze' ? { snoozed_until: iso, unread: false } : { remind_at: iso, remind_note: note.trim() || null, reminded_at: null, unread: false })
    setPicker(null)
    setCustom('')
  }
  const hasLoom = /loom\.com\//i.test(form.body)

  return (
    <div className="mi-thread">
      <header className="mi-head">
        <button className="btn btn-sm mi-back" onClick={onBack}><ArrowLeft size={14} /> Back</button>
        <div className="mi-who">
          <button className="link strong" onClick={() => onOpen(leadId)}>{name}</button>
          <span className="small muted">{form.to || leadId}{form.inbox ? ` · to ${form.inbox}` : ''}</span>
        </div>
        <div className="mi-actions">
          <button className={state?.important ? 'icon-btn on' : 'icon-btn'} title={state?.important ? 'Not important' : 'Mark important'} aria-label="Important" onClick={() => box.patch(leadId, { important: !state?.important })}><Star size={16} /></button>
          <button className="icon-btn" title="Mark unread" aria-label="Mark unread" onClick={() => box.patch(leadId, { unread: true })}><Mail size={16} /></button>
          <button className={picker === 'snooze' ? 'icon-btn on' : 'icon-btn'} title="Snooze" aria-label="Snooze" onClick={() => setPicker(picker === 'snooze' ? null : 'snooze')}><AlarmClock size={16} /></button>
          <button className={picker === 'remind' ? 'icon-btn on' : 'icon-btn'} title="Remind me" aria-label="Remind me" onClick={() => setPicker(picker === 'remind' ? null : 'remind')}><Bell size={16} /></button>
          {state?.archived_at
            ? <button className="icon-btn" title="Move to inbox" aria-label="Move to inbox" onClick={() => box.patch(leadId, { archived_at: null })}><ArchiveRestore size={16} /></button>
            : <button className="icon-btn" title="Archive" aria-label="Archive" onClick={() => box.patch(leadId, { archived_at: new Date().toISOString(), unread: false })}><Archive size={16} /></button>}
        </div>
      </header>

      <div className="mi-meta">
        {reply && (
          <select className="select select-sm" value={reply.intent ?? 'other'} onChange={e => setIntent(e.target.value as ReplyIntent)} aria-label="Category">
            {(Object.keys(INTENT_LABEL) as ReplyIntent[]).map(k => <option key={k} value={k}>{INTENT_LABEL[k]}</option>)}
          </select>
        )}
        <StageSelect key={leadId} leadId={leadId} track={track} update={update} />
        {state?.snoozed_until && Date.parse(state.snoozed_until) > Date.now() && (
          <span className="chip">Snoozed to {when.format(new Date(state.snoozed_until))} <button className="link-accent" onClick={() => box.patch(leadId, { snoozed_until: null })}>Wake</button></span>
        )}
        {state?.remind_at && (
          <span className="chip">Remind {when.format(new Date(state.remind_at))} <button className="link-accent" onClick={() => box.patch(leadId, { remind_at: null, remind_note: null, reminded_at: null })}>Clear</button></span>
        )}
      </div>

      {picker && (
        <div className="mi-picker">
          {picker === 'remind' && <input className="input input-sm" placeholder="What to remember (optional)" value={note} onChange={e => setNote(e.target.value)} aria-label="Reminder note" />}
          <div className="row-wrap">
            {presets().map(p => <button key={p.label} className="btn btn-sm" onClick={() => pick(p.at)}>{p.label}</button>)}
            <input className="input input-sm" type="datetime-local" value={custom} onChange={e => setCustom(e.target.value)} aria-label="Pick a time" />
            <button className="btn btn-sm btn-primary" disabled={!custom} onClick={() => pick(new Date(custom))}>Set</button>
          </div>
        </div>
      )}

      <div className="mi-messages">
        {error && <p className="small error-text">{error}</p>}
        {!messages && !error && <p className="small muted">Loading…</p>}
        {messages?.map(m => <Message key={m.id} m={m} />)}
        {pending.map(s => (
          <article className="mi-msg out pending" key={s.id}>
            <header className="mi-msg-head"><span className="strong">{s.status === 'failed' ? 'Failed to send' : `Scheduled for ${when.format(new Date(s.send_at))}`}</span>{s.status === 'scheduled' && <button className="link-accent small" onClick={() => cancel(s.id)}>Cancel</button>}</header>
            {s.error && <p className="small error-text">{s.error}</p>}
            <pre className="mi-body">{s.body}</pre>
          </article>
        ))}
        <div ref={end} />
      </div>

      <footer className="mi-composer">
        <div className="mi-compose-head">
          <select className="select select-sm" value={form.inbox} onChange={e => setForm({ ...form, inbox: e.target.value })} aria-label="From">
            {[...new Set([form.inbox, ...settings.inboxes])].filter(Boolean).map(i => <option key={i}>{i}</option>)}
          </select>
          <input className="input input-sm" value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} aria-label="Subject" placeholder="Subject" />
        </div>
        <textarea className="input textarea" rows={5} value={form.body} onChange={e => setForm({ ...form, body: e.target.value })} placeholder={track?.stage === 'loom_requested' ? `Paste the Loom link here. Once it's sent they move to ${STAGE_LABEL.loom_sent} and the nudges start.` : `Reply as ${form.inbox ? inboxPersona(form.inbox) : 'yourself'}…`} aria-label="Reply" />
        <div className="mi-compose-foot">
          <button className="btn btn-primary" disabled={send.busy || !form.body.trim() || !form.inbox} onClick={() => submit()}><Send size={14} /> {send.busy ? 'Sending…' : 'Send'}</button>
          <input className="input input-sm" type="datetime-local" value={later} onChange={e => setLater(e.target.value)} aria-label="Send later at" />
          <button className="btn" disabled={send.busy || !later || !form.body.trim() || !form.inbox} onClick={() => submit(new Date(later).toISOString())}><CalendarClock size={14} /> Send later</button>
          {hasLoom && <span className="small check">Loom link found</span>}
          {send.msg && <span className={send.error ? 'small error-text' : 'small check'}>{send.msg}</span>}
        </div>
      </footer>
    </div>
  )
}

function Message({ m }: { m: ThreadMessage }) {
  const [full, setFull] = useState(false)
  const cut = quoteStart(m.body)
  const body = !full && cut > 0 ? m.body.slice(0, cut).trimEnd() : m.body
  const label = m.dir === 'out' && m.step != null ? emailLabel(m.step) : m.source === 'gmail' ? 'From Gmail' : m.kind === 'auto' ? 'Auto-reply' : m.kind === 'bounce' ? 'Bounce' : m.kind === 'unsubscribe' ? 'Opt-out' : undefined
  return (
    <article className={`mi-msg ${m.dir}`}>
      <header className="mi-msg-head">
        <span className="strong">{m.dir === 'out' ? inboxPersona(m.from) : m.from}</span>
        {label && <span className="chip">{label}</span>}
        {m.opened && <span className="chip">Opened</span>}
        {m.clicked && <span className="chip">Clicked</span>}
        <time className="small muted">{when.format(new Date(m.at))}</time>
      </header>
      <p className="small muted mi-msg-subject">{m.subject}</p>
      {m.body ? <pre className="mi-body">{body}</pre> : <p className="small muted">The text of this email wasn't saved.</p>}
      {cut > 0 && <button className="link-accent small" onClick={() => setFull(!full)}>{full ? 'Hide quoted text' : 'Show quoted text'}</button>}
    </article>
  )
}
