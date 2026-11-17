// The master inbox's own state: which conversations are read, starred, snoozed or archived, and what's scheduled.
import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../../supabase'

export type ThreadState = {
  lead_id: string; unread: boolean; important: boolean; archived_at: string | null; snoozed_until: string | null
  remind_at: string | null; remind_note: string | null; reminded_at: string | null
}
export type Scheduled = { id: number; lead_id: string; inbox: string; to_email: string; subject: string; body: string; send_at: string; status: string; error: string | null }

/** One message of a conversation, as api/inbox.ts returns it. */
export type ThreadMessage = {
  id: string; dir: 'in' | 'out'; at: string; from: string; to: string; subject: string; body: string
  step: number | null; source?: string; kind?: string; opened?: boolean; clicked?: boolean
}

export function useInbox() {
  const [threads, setThreads] = useState<Map<string, ThreadState>>(new Map())
  const [scheduled, setScheduled] = useState<Scheduled[]>([])
  /** False until master_inbox.sql has run: replies still show, but only their snippets. */
  const [ready, setReady] = useState(true)
  const latest = useRef(threads)
  latest.current = threads

  const refresh = useCallback(async () => {
    const [t, s] = await Promise.all([
      supabase.from('inbox_threads').select('lead_id,unread,important,archived_at,snoozed_until,remind_at,remind_note,reminded_at'),
      supabase.from('scheduled_emails').select('id,lead_id,inbox,to_email,subject,body,send_at,status,error').in('status', ['scheduled', 'failed']).order('send_at'),
    ])
    setReady(!t.error)
    setThreads(new Map(((t.data ?? []) as ThreadState[]).map(r => [r.lead_id, r])))
    setScheduled((s.data ?? []) as Scheduled[])
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [refresh])

  const patch = useCallback(async (leadId: string, change: Partial<ThreadState>) => {
    // The whole row goes up, so a change to one flag can't reset the others on a conversation with no row yet.
    const row: ThreadState = {
      lead_id: leadId, unread: false, important: false, archived_at: null, snoozed_until: null, remind_at: null, remind_note: null, reminded_at: null,
      ...latest.current.get(leadId), ...change,
    }
    setThreads(prev => new Map(prev).set(leadId, row))
    const { error } = await supabase.from('inbox_threads').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
    if (error) refresh()
    return error?.message
  }, [refresh])

  return { threads, scheduled, ready, refresh, patch }
}
