import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchTracking, fromRow, saveTracking, supabase, toRow, type TrackingRow } from './supabase'
import type { MediaItem, Settings, Stage, Track, TrackMap } from './types'
import { DEFAULT_SETTINGS, EMPTY_TRACK, GUARD_COLUMNS, guardFromRows, type GuardRow } from './core'

export * from './core'

// ---------- persistence (Supabase) ----------

export type SyncState = { state: 'loading' | 'saved' | 'saving' | 'error'; error?: string }

/** The deliverability guard (guard.sql), or undefined before that table exists. */
async function fetchGuard() {
  const { data, error } = await supabase.from('inbox_guard').select(GUARD_COLUMNS)
  return error ? undefined : guardFromRows(data as unknown as GuardRow[])
}

const isEmptyTrack = (t: Track) =>
  !t.sentAt && !t.followUps.length && !t.repliedAt && !t.badReason && !t.notes && !t.mediaDone && !t.media?.length && !t.inbox && !t.stage && t.dealValue == null

export function useTracking(enabled: boolean) {
  const [tracks, setTracksState] = useState<TrackMap>({})
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS)
  const [sync, setSync] = useState<SyncState>({ state: 'loading' })
  const tracksRef = useRef(tracks)
  const inflight = useRef(new Map<string, number>())
  const saving = useRef(0)
  const settingsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSettingsEdit = useRef(0)

  const commit = (next: TrackMap) => {
    tracksRef.current = next
    setTracksState(next)
  }

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setSync({ state: 'loading' })
    Promise.all([fetchTracking(), supabase.from('app_settings').select('data').eq('id', 1).maybeSingle(), fetchGuard()])
      .then(([t, s, guard]) => {
        if (cancelled) return
        commit(t)
        if (s.data?.data) setSettingsState({ ...DEFAULT_SETTINGS, ...(s.data.data as Partial<Settings>), guard })
        setSync({ state: 'saved' })
      })
      .catch(e => !cancelled && setSync({ state: 'error', error: String(e.message ?? e) }))

    // Live updates from teammates. Our own writes echo back too; skip ids we're still saving.
    const channel = supabase
      .channel('outreach')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_tracking' }, payload => {
        const id = (payload.eventType === 'DELETE' ? payload.old : payload.new) as Partial<TrackingRow>
        if (!id.lead_id || inflight.current.get(id.lead_id)) return
        const next = { ...tracksRef.current }
        if (payload.eventType === 'DELETE') delete next[id.lead_id]
        else next[id.lead_id] = fromRow(payload.new as TrackingRow)
        commit(next)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_settings' }, payload => {
        if (Date.now() - lastSettingsEdit.current < 3000) return
        setSettingsState(prev => ({ ...DEFAULT_SETTINGS, ...((payload.new as { data: Partial<Settings> }).data), guard: prev.guard }))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inbox_guard' }, async () => {
        const guard = await fetchGuard()
        if (!cancelled) setSettingsState(prev => ({ ...prev, guard }))
      })
      .subscribe()

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [enabled])

  /** Apply an update to one or many leads, optimistically, then save. Returning null clears the record. */
  const update = useCallback((ids: string | string[], fn: (t: Track, id: string) => Track | null) => {
    const list = Array.isArray(ids) ? ids : [ids]
    const prev = tracksRef.current
    const next = { ...prev }
    const upserts: TrackingRow[] = []
    const deletes: string[] = []
    const touched: string[] = []
    for (const id of list) {
      const res = fn(prev[id] ?? EMPTY_TRACK, id)
      if (res && !isEmptyTrack(res)) {
        next[id] = res
        upserts.push(toRow(id, res))
      } else if (prev[id]) {
        delete next[id]
        deletes.push(id)
      } else continue
      touched.push(id)
    }
    if (!touched.length) return
    commit(next)

    touched.forEach(id => inflight.current.set(id, (inflight.current.get(id) ?? 0) + 1))
    saving.current++
    setSync({ state: 'saving' })
    saveTracking(upserts, deletes)
      .then(() => setSync(s => (saving.current === 1 && s.state !== 'error' ? { state: 'saved' } : s)))
      .catch(e => {
        // Roll back just the leads this call touched.
        const cur = { ...tracksRef.current }
        for (const id of touched) {
          if (prev[id]) cur[id] = prev[id]
          else delete cur[id]
        }
        commit(cur)
        setSync({ state: 'error', error: `Change not saved: ${e.message ?? e}` })
      })
      .finally(() => {
        saving.current--
        touched.forEach(id => {
          const n = (inflight.current.get(id) ?? 1) - 1
          if (n) inflight.current.set(id, n)
          else inflight.current.delete(id)
        })
      })
  }, [])

  const setSettings = useCallback((s: Settings) => {
    setSettingsState(s)
    lastSettingsEdit.current = Date.now()
    clearTimeout(settingsTimer.current)
    setSync({ state: 'saving' })
    settingsTimer.current = setTimeout(async () => {
      // The guard has its own table; never copy it into app_settings.
      const data: Partial<Settings> = { ...s }
      delete data.guard
      const { error } = await supabase.from('app_settings').update({ data }).eq('id', 1)
      setSync(error ? { state: 'error', error: `Settings not saved: ${error.message}` } : { state: 'saved' })
    }, 600)
  }, [])

  /** Replace all tracking with the given map (backup restore / clear). */
  const replaceAll = useCallback((map: TrackMap) => {
    const ids = [...new Set([...Object.keys(tracksRef.current), ...Object.keys(map)])]
    update(ids, (_t, id) => (map[id] ? { ...EMPTY_TRACK, ...map[id] } : null))
  }, [update])

  return { tracks, settings, setSettings, update, replaceAll, sync }
}

export type Updater = ReturnType<typeof useTracking>['update']

// Common actions, shared by the table, queue and follow-up views.
export const actions = {
  markSent: (d: string, inbox?: string) => (t: Track): Track => ({ ...t, sentAt: t.sentAt ?? d, inbox: t.inbox ?? inbox }),
  unmarkSent: (t: Track): Track => ({ ...t, sentAt: undefined, followUps: [], inbox: undefined }),
  setInbox: (inbox: string | undefined) => (t: Track): Track => ({ ...t, inbox: inbox || undefined }),
  logFollowUp: (d: string) => (t: Track): Track => ({ ...t, sentAt: t.sentAt ?? d, followUps: [...t.followUps, d] }),
  undoFollowUp: (t: Track): Track => ({ ...t, followUps: t.followUps.slice(0, -1) }),
  setReplied: (d: string | undefined) => (t: Track): Track => ({ ...t, repliedAt: d, sentAt: t.sentAt ?? d }),
  setBad: (reason: string | undefined) => (t: Track): Track => ({ ...t, badReason: reason || undefined }),
  // Switching media back to "not done" keeps attachments, so nothing is lost by a mis-click.
  setMediaDone: (done: boolean) => (t: Track): Track => ({ ...t, mediaDone: done || undefined }),
  addMedia: (item: MediaItem) => (t: Track): Track => ({ ...t, media: [...(t.media ?? []), item] }),
  setStage: (stage: Stage | undefined, at = new Date().toISOString()) => (t: Track): Track => ({
    ...t,
    stage,
    stageLog: stage ? { ...t.stageLog, [stage]: t.stageLog?.[stage] ?? at } : t.stageLog,
  }),
  setDealValue: (v: number | undefined) => (t: Track): Track => ({ ...t, dealValue: v }),
  removeMedia: (item: MediaItem) => (t: Track): Track => {
    const media = (t.media ?? []).filter(m => (m.path ?? m.url) !== (item.path ?? item.url))
    return { ...t, media: media.length ? media : undefined }
  },
}
