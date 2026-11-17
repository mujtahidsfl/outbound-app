import { useState } from 'react'
import type { Lead, Settings, Status } from '../types'
import { BAD_REASONS } from '../types'
import { STATUS_LABEL, composeEmail, leadDetails } from '../tracking'
import { api } from '../api'

/** Copy text to the clipboard; `copied` stays true briefly afterwards for feedback. */
function useCopy(): [boolean, (text: string) => Promise<void>] {
  const [copied, setCopied] = useState(false)
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked (e.g. insecure context); nothing else to do.
    }
  }
  return [copied, copy]
}

const STATUS_ICON: Record<Status, string> = {
  new: '○',
  awaiting: '◷',
  due: '!',
  replied: '✓',
  done: '■',
  bad: '⚑',
}

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge badge-${status}`}>
      <span aria-hidden className="badge-icon">{STATUS_ICON[status]}</span>
      {STATUS_LABEL[status]}
    </span>
  )
}

export function ComposeButtons({ lead, settings, followUp, compact, inbox }: {
  lead: Lead
  settings: Settings
  followUp: boolean
  compact?: boolean
  /** Sending inbox, so the sign-off uses its name. */
  inbox?: string
}) {
  const [copied, copy] = useCopy()
  const email = composeEmail(lead, settings, followUp, inbox)
  return (
    <span className="btn-group">
      <a className="btn btn-sm" href={email.mailto} title="Opens your mail app with the email pre-filled">
        {compact ? 'Compose' : followUp ? 'Compose follow-up' : 'Compose email'}
      </a>
      <button className="btn btn-sm btn-ghost" onClick={() => copy(`Subject: ${email.subject}\n\n${email.body}`)} title="Copy subject and body">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

/** Sends the lead's next email (first or follow-up) through its inbox, via the server. */
export function SendButton({ leadId, inbox, label = 'Send', primary }: {
  leadId: string
  /** Inbox to use when the lead doesn't have one yet. */
  inbox?: string
  label?: string
  primary?: boolean
}) {
  const [state, setState] = useState<{ s: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ s: 'idle' })
  const send = async () => {
    setState({ s: 'sending' })
    const r = await api({ action: 'send', leadId, inbox })
    setState(r.ok ? { s: 'sent', msg: r.warning } : { s: 'error', msg: r.error })
  }
  return (
    <span className="send-wrap">
      <button
        className={primary ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
        onClick={send}
        disabled={state.s === 'sending' || state.s === 'sent'}
        title={inbox ? `Sends now from ${inbox}` : 'Sends now from this lead\'s inbox'}
      >
        {state.s === 'sending' ? 'Sending…' : state.s === 'sent' ? '✓ Sent' : label}
      </button>
      {state.msg && <span className={state.s === 'error' ? 'send-msg error-text' : 'send-msg muted'} role={state.s === 'error' ? 'alert' : undefined}>{state.msg}</span>}
    </span>
  )
}

/** A lead's email address that copies itself to the clipboard on click. */
export function CopyEmail({ email, muted }: { email: string; muted?: boolean }) {
  const [copied, copy] = useCopy()
  return (
    <button type="button" className={muted ? 'copy-email mono small muted' : 'copy-email mono small'} onClick={() => copy(email)} title="Click to copy" aria-label={`Copy ${email}`}>
      {email}
      <span className={copied ? 'copy-hint copied' : 'copy-hint'} aria-live="polite">{copied ? '✓ Copied' : 'Copy'}</span>
    </button>
  )
}

/** Copies the business profile (reviews, site problem, hook, pitch…) in one click. */
export function CopyDetails({ lead }: { lead: Lead }) {
  const [copied, copy] = useCopy()
  return (
    <button
      type="button"
      className="btn btn-sm"
      onClick={() => copy(leadDetails(lead))}
      title="Copy business details: reviews, website problem, hook, pitch, contact"
    >
      {copied ? '✓ Copied' : 'Copy details'}
    </button>
  )
}

export function BadDataSelect({ value, onChange }: { value?: string; onChange: (v: string | undefined) => void }) {
  return (
    <select
      className={value ? 'select select-sm flagged' : 'select select-sm'}
      value={value ?? ''}
      onChange={e => onChange(e.target.value || undefined)}
      aria-label="Flag as bad data"
    >
      <option value="">Not flagged</option>
      {BAD_REASONS.map(r => (
        <option key={r} value={r}>⚑ {r}</option>
      ))}
    </select>
  )
}

export function InboxSelect({ value, inboxes, onChange }: {
  value?: string
  inboxes: string[]
  onChange: (v: string | undefined) => void
}) {
  // Keep an inbox that was removed from settings selectable, so old leads still show where they went out from.
  const options = value && !inboxes.includes(value) ? [...inboxes, value] : inboxes
  return (
    <select
      className={value ? 'select select-sm' : 'select select-sm unset'}
      value={value ?? ''}
      onChange={e => onChange(e.target.value || undefined)}
      aria-label="Sent from inbox"
    >
      <option value="">No inbox</option>
      {options.map(i => <option key={i} value={i}>{i}</option>)}
    </select>
  )
}

export function Pager({ page, pages, onPage, total, pageSize, pageSizes, onPageSize, top }: {
  page: number
  pages: number
  onPage: (p: number) => void
  total: number
  pageSize: number
  pageSizes?: number[]
  onPageSize?: (n: number) => void
  top?: boolean
}) {
  const from = total ? page * pageSize + 1 : 0
  const to = Math.min(total, (page + 1) * pageSize)
  return (
    <div className={top ? 'pager pager-top' : 'pager'}>
      <span className="small">
        <strong>{from.toLocaleString()}–{to.toLocaleString()}</strong> <span className="muted">of {total.toLocaleString()} leads</span>
      </span>
      <span className="btn-group">
        {pageSizes && onPageSize && (
          <select className="select select-sm" value={pageSize} onChange={e => onPageSize(Number(e.target.value))} aria-label="Leads per page">
            {pageSizes.map(n => <option key={n} value={n}>{n} per page</option>)}
          </select>
        )}
        <button className="btn btn-sm btn-ghost" disabled={page === 0} onClick={() => onPage(0)} title="First page">«</button>
        <button className="btn btn-sm" disabled={page === 0} onClick={() => onPage(page - 1)}>‹ Prev</button>
        <span className="small pager-label">Page {page + 1} of {pages}</span>
        <button className="btn btn-sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>Next ›</button>
        <button className="btn btn-sm btn-ghost" disabled={page >= pages - 1} onClick={() => onPage(pages - 1)} title="Last page">»</button>
      </span>
    </div>
  )
}

export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)].sort()
}
