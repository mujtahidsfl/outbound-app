import { useMemo, useState } from 'react'
import { inboxCap, inboxPersona, inboxTotal, isWarmingUp, sentByInbox, warmupWeek } from '../../../tracking'
import { Avatar } from './ui'
import type { CampaignProps } from './CampaignView'

/** Choose which sender accounts power this campaign, filtered by warm-up status, room left today and health. */
export default function EmailAccounts({ campaign: c, settings, tracks, now, data, actions: a }: CampaignProps) {
  const [q, setQ] = useState('')
  const [warm, setWarm] = useState<'' | 'warming' | 'done'>('')
  const [room, setRoom] = useState(false)
  const [healthy, setHealthy] = useState(false)
  const chosen = c.config.inboxes ?? []
  const today = useMemo(() => sentByInbox(tracks, now), [tracks, now])

  const rows = settings.inboxes.map(i => {
    const sent = inboxTotal(today[i])
    const cap = inboxCap(settings, i, now)
    const domain = data.domains?.find(d => d.domain === i.split('@')[1])
    const error = data.states[i]?.error
    const connected = data.status?.passwords[i]
    const bad = !connected ? 'Not connected' : error ? 'Reply check failing' : domain?.mode === 'red' ? `${domain.domain}: ${domain.label}` : undefined
    return { i, sent, cap, left: Math.max(0, cap - sent), warming: isWarmingUp(settings, i, now), domain, bad }
  })
  const shown = rows.filter(r => (!q || r.i.includes(q.toLowerCase())) && (!warm || (warm === 'warming') === r.warming) && (!room || r.left > 0) && (!healthy || !r.bad))
  const toggle = (inbox: string) => {
    const base = chosen.length ? chosen : settings.inboxes
    const next = base.includes(inbox) ? base.filter(i => i !== inbox) : [...base, inbox]
    a.saveConfig({ inboxes: next.length === settings.inboxes.length ? [] : next })
  }
  const on = (i: string) => !chosen.length || chosen.includes(i)
  const total = rows.filter(r => on(r.i)).reduce((s, r) => s + r.cap, 0)

  return (
    <div className="stack">
      <div className="toolbar">
        <input className="input input-sm" placeholder="Search accounts" value={q} onChange={e => setQ(e.target.value)} aria-label="Search accounts" />
        <select className="select select-sm" value={warm} onChange={e => setWarm(e.target.value as typeof warm)} aria-label="Warm-up status">
          <option value="">Any warm-up status</option>
          <option value="warming">Warming up</option>
          <option value="done">Warmed up</option>
        </select>
        <label className="toggle"><input type="checkbox" checked={room} onChange={e => setRoom(e.target.checked)} /><span className="small">Has room today</span></label>
        <label className="toggle"><input type="checkbox" checked={healthy} onChange={e => setHealthy(e.target.checked)} /><span className="small">Healthy only</span></label>
        <span className="toolbar-end small muted">{chosen.length ? `${chosen.length} of ${settings.inboxes.length} accounts` : `All ${settings.inboxes.length} accounts`} · up to {total.toLocaleString()} emails a day</span>
      </div>
      <section className="card flush">
        <div className="table-scroll"><table className="table list-table">
          <thead><tr><th /><th>Account</th><th>Warm-up</th><th>Room today</th><th>Health</th></tr></thead>
          <tbody>
            {shown.map(r => (
              <tr key={r.i}>
                <td><input type="checkbox" checked={on(r.i)} onChange={() => toggle(r.i)} aria-label={`Use ${r.i}`} /></td>
                <td><span className="who"><Avatar inbox={r.i} /><span><span>{inboxPersona(r.i)}</span><small>{r.i}</small></span></span></td>
                <td className="small">{r.warming ? `Week ${warmupWeek(settings, now, r.i) + 1}` : 'Warmed up'}</td>
                <td className="small nowrap">{r.left} left <span className="muted">of {r.cap}</span></td>
                <td>{r.bad ? <span className="pill pill-bad" title={r.bad}><i />{r.bad.length > 28 ? `${r.bad.slice(0, 28)}…` : r.bad}</span> : <span className="pill pill-good"><i />Healthy</span>}</td>
              </tr>
            ))}
            {!shown.length && <tr><td colSpan={5} className="empty">No accounts match these filters.</td></tr>}
          </tbody>
        </table></div>
      </section>
      <p className="small muted">Leads already started stay with their account, so follow-ups land in the same thread.</p>
    </div>
  )
}
