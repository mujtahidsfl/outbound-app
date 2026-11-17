import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../supabase'
import { when } from './data'

export type Alert = {
  id: number; key: string; level: 'warn' | 'critical'; title: string; detail: string | null; inbox: string | null
  created_at: string; updated_at: string; resolved_at: string | null; seen_at: string | null
}

/** Open alerts plus the ones resolved in the last 2 days, kept live. `ready` is false before guard.sql runs. */
export function useAlerts(enabled: boolean) {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [ready, setReady] = useState(false)
  const load = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 864e5).toISOString()
    const { data, error } = await supabase.from('alerts').select('id,key,level,title,detail,inbox,created_at,updated_at,resolved_at,seen_at')
      .or(`resolved_at.is.null,resolved_at.gte.${since}`).order('created_at', { ascending: false }).limit(60)
    setReady(!error)
    if (!error) setAlerts(data as Alert[])
  }, [])
  useEffect(() => {
    if (!enabled) return
    load()
    const channel = supabase.channel('alerts')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'alerts' }, () => load())
      .subscribe()
    const id = setInterval(load, 60_000)
    return () => { supabase.removeChannel(channel); clearInterval(id) }
  }, [enabled, load])
  const markSeen = useCallback(async () => {
    const ids = alerts.filter(a => !a.seen_at && !a.resolved_at).map(a => a.id)
    if (!ids.length) return
    const at = new Date().toISOString()
    setAlerts(as => as.map(a => (ids.includes(a.id) ? { ...a, seen_at: at } : a)))
    await supabase.from('alerts').update({ seen_at: at }).in('id', ids)
  }, [alerts])
  return { alerts, ready, markSeen }
}

const sortOpen = (list: Alert[]) =>
  list.filter(a => !a.resolved_at).sort((a, b) => (a.level === b.level ? b.created_at.localeCompare(a.created_at) : a.level === 'critical' ? -1 : 1))

/** One alert: what's wrong, on which inbox, since when, and what to do. */
function AlertItem({ a }: { a: Alert }) {
  return (
    <li className={`alert-item alert-${a.resolved_at ? 'resolved' : a.level}`}>
      <div className="alert-top">
        <span className={`badge ${a.resolved_at ? 'badge-replied' : a.level === 'critical' ? 'badge-bad' : 'badge-due'}`}>
          {a.resolved_at ? 'fixed' : a.level === 'critical' ? 'stopped' : 'warning'}
        </span>
        <strong className="small">{a.title}</strong>
      </div>
      {a.detail && !a.resolved_at && <p className="small">{a.detail}</p>}
      <p className="small muted">
        {a.resolved_at ? `Fixed ${when.format(new Date(a.resolved_at))}` : `Since ${when.format(new Date(a.created_at))}`}
      </p>
    </li>
  )
}

/** Bell in the top bar: red for anything stopped, amber for warnings. */
export function AlertsBell({ state, onGoTo }: { state: ReturnType<typeof useAlerts>; onGoTo?: () => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [open])
  if (!state.ready) return null
  const live = sortOpen(state.alerts)
  const fixed = state.alerts.filter(a => a.resolved_at).slice(0, 5)
  const count = live.length
  const unseen = live.filter(a => !a.seen_at).length
  const critical = live.some(a => a.level === 'critical')
  const label = count ? `${count} deliverability alert${count === 1 ? '' : 's'}` : 'No deliverability alerts'
  const toggle = () => {
    setOpen(o => !o)
    if (!open) state.markSeen()
  }
  return (
    <div className="notif" ref={ref}>
      <button className={`notif-btn alerts-btn${count ? (critical ? ' has-critical' : ' has-due') : ''}`} onClick={toggle} aria-label={label} aria-expanded={open} title={label}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 2 2 20h20L12 2z" /><path d="M12 9v5" /><path d="M12 17h.01" />
        </svg>
        {count > 0 && <span className={unseen ? 'notif-count' : 'notif-count seen'}>{count}</span>}
      </button>
      {open && (
        <div className="notif-panel alerts-panel" role="dialog" aria-label="Deliverability alerts">
          <h2>Deliverability</h2>
          {!count && <p className="muted small">No problems. Failed sends, reply checks, opens, unsubscribes and DNS are checked every 5 minutes.</p>}
          <ul className="alert-list">{live.map(a => <AlertItem key={a.id} a={a} />)}</ul>
          {fixed.length > 0 && <><h3 className="small muted">Recently fixed</h3><ul className="alert-list">{fixed.map(a => <AlertItem key={a.id} a={a} />)}</ul></>}
          {onGoTo && <button className="btn btn-sm" onClick={() => { setOpen(false); onGoTo() }}>Open Sender accounts</button>}
        </div>
      )}
    </div>
  )
}

/** The open alerts as a card on the cold email dashboard. Renders nothing when there are none. */
export function AlertsCard({ state }: { state?: ReturnType<typeof useAlerts> }) {
  const live = sortOpen(state?.alerts ?? [])
  if (!live.length) return null
  return (
    <section className={live.some(a => a.level === 'critical') ? 'card guard-banner guard-paused' : 'card guard-banner'}>
      <h2>{live.length} deliverability {live.length === 1 ? 'problem' : 'problems'}</h2>
      <ul className="alert-list">{live.map(a => <AlertItem key={a.id} a={a} />)}</ul>
    </section>
  )
}
