import { useCallback, useEffect, useState } from 'react'
import { api } from '../../api'
import { supabase } from '../../supabase'
import { LIVE_EVENTS, TIME_ZONE } from '../../tracking'
import type { ReplyIntent } from '../../types'

export type Msg = {
  id: number; lead_id: string | null; step: number; inbox: string; to_email: string; subject: string | null
  status: string; error: string | null; source: string; created_at: string; sent_at: string | null
  /** The lead a hand-written reply belongs to. */
  thread_lead_id?: string | null
}
export type Evt = {
  id: number; lead_id: string | null; inbox: string; kind: string; from_email: string | null
  subject: string | null; snippet: string | null; received_at: string | null; created_at: string
  step?: number | null; intent?: ReplyIntent | null
}
export type InboxState = { inbox: string; checked_at: string | null; error: string | null }
/** `ok` means the server is set up (keys added in Vercel); `passwords` says which inboxes have one. */
export type ServerStatus = { ok: boolean; error?: string; passwords: Record<string, boolean> }
export type DomainCheck = {
  domain: string; score: number; mode: 'green' | 'yellow' | 'red'; label: string; cap: number | null
  mx: string[]; spf: string | null; spfCoversSending: boolean | null; dkimSelector: string | null
  dmarc: string | null; dmarcPolicy: string | null; issues: string[]
  /** Parts whose DNS lookup failed ('SPF' | 'DKIM' | 'DMARC' | 'MX'): unknown, not missing. Absent from older servers. */
  unchecked?: string[]
}

/** Lead emails sent with the open pixel, and how many of them were opened. Null before opens.sql runs. */
export type OpenStats = { tracked: number; opened: number } | null

export interface ColdData {
  /** Deliverability alerts (shared with the top-bar bell). */
  alerts?: ReturnType<typeof import('./Alerts').useAlerts>
  messages: Msg[]
  opens: OpenStats
  events: Evt[]
  states: Record<string, InboxState>
  status: ServerStatus | null
  domains: DomainCheck[] | null
  domainsError?: string
  loadError?: string
  refresh: () => void
  checkDomains: () => void
  setIntent: (eventId: number, intent: ReplyIntent) => void
  /** Unread conversations, for the sidebar. */
  unread: number
}

export const when = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Everything the cold email app shows that lives outside lead tracking. Loads only while the app is open. */
export function useColdData(enabled: boolean): ColdData {
  const [messages, setMessages] = useState<Msg[]>([])
  const [opens, setOpens] = useState<OpenStats>(null)
  const [events, setEvents] = useState<Evt[]>([])
  const [states, setStates] = useState<Record<string, InboxState>>({})
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [domains, setDomains] = useState<DomainCheck[] | null>(null)
  const [domainsError, setDomainsError] = useState<string>()
  const [loadError, setLoadError] = useState<string>()
  const [unread, setUnread] = useState(0)

  const setIntent = useCallback(async (id: number, intent: ReplyIntent) => {
    setEvents(es => es.map(x => (x.id === id ? { ...x, intent } : x)))
    // Marked manual so Claude never re-reads over a category you picked (before master_inbox.sql there's no such column).
    const first = await supabase.from('email_events').update({ intent, classified_by: 'manual' }).eq('id', id)
    const { error } = first.error && /column/i.test(first.error.message) ? await supabase.from('email_events').update({ intent }).eq('id', id) : first
    if (error) setLoadError(error.message)
  }, [])

  const refresh = useCallback(async () => {
    const tracked = () => supabase.from('email_messages').select('id', { count: 'exact', head: true }).eq('tracked', true).eq('status', 'sent')
    const msgCols = 'id,lead_id,step,inbox,to_email,subject,status,error,source,created_at,sent_at'
    const msgs = (cols: string) => supabase.from('email_messages').select(cols).order('created_at', { ascending: false }).limit(300)
    const [m0, e0, s, st, tr, op, un] = await Promise.all([
      msgs(`${msgCols},thread_lead_id`),
      supabase.from('email_events').select('id,lead_id,inbox,kind,from_email,subject,snippet,received_at,created_at,step,intent').or(LIVE_EVENTS).order('created_at', { ascending: false }).limit(1000),
      supabase.from('inbox_state').select('inbox,checked_at,error'),
      api<{ passwords: Record<string, boolean> }>({ action: 'status' }),
      tracked(),
      tracked().not('opened_at', 'is', null),
      supabase.from('inbox_threads').select('lead_id', { count: 'exact', head: true }).eq('unread', true).is('archived_at', null),
    ])
    const m = m0.error && /column/i.test(m0.error.message) ? await msgs(msgCols) : m0
    setUnread(un.count ?? 0)
    setOpens(tr.error || op.error ? null : { tracked: tr.count ?? 0, opened: op.count ?? 0 })
    // Before campaigns.sql runs, the step/intent columns don't exist yet: fall back to the original columns.
    const e = e0.error && /column/i.test(e0.error.message)
      ? await supabase.from('email_events').select('id,lead_id,inbox,kind,from_email,subject,snippet,received_at,created_at').order('created_at', { ascending: false }).limit(300)
      : e0
    setLoadError(m.error?.message ?? e.error?.message ?? s.error?.message)
    setMessages((m.data ?? []) as unknown as Msg[])
    setEvents((e.data ?? []) as Evt[])
    setStates(Object.fromEntries(((s.data ?? []) as InboxState[]).map(r => [r.inbox, r])))
    setStatus(st.ok ? { ok: true, passwords: st.passwords } : { ok: false, error: st.error, passwords: {} })
  }, [])

  const checkDomains = useCallback(async () => {
    setDomainsError(undefined)
    const r = await api<{ domains: DomainCheck[] }>({ action: 'deliverability' })
    if (r.error) setDomainsError(r.error)
    else setDomains(r.domains)
  }, [])

  useEffect(() => {
    if (!enabled) return
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [enabled, refresh])

  useEffect(() => {
    if (enabled && domains === null) checkDomains()
  }, [enabled, domains, checkDomains])

  return { messages, opens, events, states, status, domains, domainsError, loadError, refresh, checkDomains, setIntent, unread }
}
