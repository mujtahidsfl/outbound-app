import { useMemo, useState } from 'react'
import type { Shared } from '../App'
import { actions, inboxCap, inboxTotal, sentByInbox } from '../tracking'
import { BadDataSelect, ComposeButtons, CopyDetails, CopyEmail, SendButton, unique } from './common'

export default function SendQueue({ leads, derived, tracks, settings, update, now, onOpen }: Shared) {
  const [wave, setWave] = useState('')
  const [group, setGroup] = useState('')
  const [hook, setHook] = useState('')
  const [from, setFrom] = useState('') // '' = auto: the first inbox still under its daily quota

  const sentToday = useMemo(() => leads.filter(l => tracks[l.id]?.sentAt === now), [leads, tracks, now])
  const remaining = Math.max(0, settings.dailyTarget - sentToday.length)

  const queue = useMemo(
    () => leads.filter(l =>
      derived.get(l.id)!.status === 'new' &&
      (!wave || String(l.wave) === wave) &&
      (!group || l.nicheGroup === group) &&
      (!hook || l.hook === hook)),
    [leads, derived, wave, group, hook],
  )
  // Always show at least a handful so you can keep going past the target.
  const shown = queue.slice(0, Math.max(remaining, 10))
  const pct = Math.min(100, (sentToday.length / Math.max(1, settings.dailyTarget)) * 100)

  const capOf = (i: string) => inboxCap(settings, i, now)
  const byInbox = useMemo(() => sentByInbox(tracks, now), [tracks, now])
  const autoInbox = settings.inboxes.find(i => inboxTotal(byInbox[i]) < capOf(i))
  const inbox = from || autoInbox
  const inboxSent = inbox ? inboxTotal(byInbox[inbox]) : 0
  const limit = inbox ? capOf(inbox) : 0

  // With auto, a bulk send fills each inbox up to its quota before moving to the next.
  const markAllSent = () => {
    const plan = new Map<string, string>()
    if (from) shown.forEach(l => plan.set(l.id, from))
    else {
      const room = settings.inboxes.map(i => ({ i, left: capOf(i) - inboxTotal(byInbox[i]) }))
      let k = 0
      for (const l of shown) {
        while (k < room.length && room[k].left <= 0) k++
        if (k === room.length) break
        plan.set(l.id, room[k].i)
        room[k].left--
      }
    }
    update(shown.map(l => l.id), (t, id) => actions.markSent(now, plan.get(id))(t))
  }

  return (
    <div className="stack">
      <section className="card reminder">
        <div>
          <h2>First emails for today</h2>
          <p className="muted">
            {remaining > 0
              ? <>You've sent <strong>{sentToday.length}</strong> of your <strong>{settings.dailyTarget}</strong> first emails today. <strong>{remaining}</strong> to go.</>
              : <>Daily target hit: <strong>{sentToday.length}</strong> first emails sent today. Anything more is a bonus.</>}
          </p>
          <span className="meter meter-lg" aria-hidden><span style={{ width: `${pct}%` }} /></span>
        </div>
        <div className="reminder-side">
          <span className="big-num">{queue.length.toLocaleString()}</span>
          <span className="muted small">leads not yet contacted{wave || group || hook ? ' (filtered)' : ''}</span>
        </div>
      </section>

      <section className="card filters">
        <label className="row-wrap">
          <span className="small strong">Sending from</span>
          <select className="select" value={from} onChange={e => setFrom(e.target.value)}>
            <option value="">Auto: {autoInbox ?? 'every inbox is full'}</option>
            {settings.inboxes.map(i => (
              <option key={i} value={i}>{i} · {inboxTotal(byInbox[i])}/{capOf(i)}</option>
            ))}
          </select>
        </label>
        {inbox ? (
          <span className="inline-meter small">
            <span className={inboxSent >= limit ? 'meter meter-done' : 'meter'}><span style={{ width: `${Math.min(100, (inboxSent / Math.max(1, limit)) * 100)}%` }} /></span>
            <span className={inboxSent >= limit ? 'due-text' : 'muted'}>
              {inboxSent >= limit ? `This inbox hit its ${limit} for today` : `${inboxSent} of ${limit} sent today from this inbox`}
            </span>
          </span>
        ) : (
          <span className="small due-text">All {settings.inboxes.length} inboxes hit their cap for today.</span>
        )}
      </section>

      <section className="card filters">
        <span className="small muted">Pull from:</span>
        <select className="select" value={wave} onChange={e => setWave(e.target.value)}>
          <option value="">All waves</option>
          {[1, 2, 3, 4].map(w => <option key={w} value={w}>Wave {w}</option>)}
        </select>
        <select className="select" value={group} onChange={e => setGroup(e.target.value)}>
          <option value="">All niche groups</option>
          {unique(leads.map(l => l.nicheGroup)).map(g => <option key={g}>{g}</option>)}
        </select>
        <select className="select" value={hook} onChange={e => setHook(e.target.value)}>
          <option value="">All hooks</option>
          {unique(leads.map(l => l.hook)).map(h => <option key={h}>{h}</option>)}
        </select>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          disabled={!shown.length}
          onClick={markAllSent}
          title="Use after sending these through your mail tool"
        >
          Mark all {shown.length} below as sent
        </button>
      </section>

      <section className="card flush">
        <ul className="queue">
          {shown.map((l, i) => (
            <li key={l.id} className="queue-row">
              <span className="queue-n muted small">{i + 1}</span>
              <div className="queue-main">
                <button className="link strong" onClick={() => onOpen(l.id)}>{l.businessName}</button>
                <span className="muted small">{l.specificCategory} · {l.city} · <span className="chip">W{l.wave}</span> {l.hook}</span>
                <CopyEmail email={l.email} />
              </div>
              <div className="queue-actions">
                <CopyDetails lead={l} />
                <ComposeButtons lead={l} settings={settings} followUp={false} compact inbox={tracks[l.id]?.inbox ?? inbox} />
                <SendButton leadId={l.id} inbox={inbox} primary />
                <button className="btn btn-sm" onClick={() => update(l.id, actions.markSent(now, inbox))} title="Already sent it yourself? Log it without sending">Mark sent</button>
                <BadDataSelect value={tracks[l.id]?.badReason} onChange={v => update(l.id, actions.setBad(v))} />
              </div>
            </li>
          ))}
          {!shown.length && <li className="empty">Every lead in this filter has been contacted.</li>}
        </ul>
      </section>

      {sentToday.length > 0 && (
        <section className="card">
          <header className="card-head"><h2>Sent today ({sentToday.length})</h2></header>
          <ul className="sent-list">
            {sentToday.map(l => (
              <li key={l.id}>
                <span className="check" aria-hidden>✓</span>
                <button className="link" onClick={() => onOpen(l.id)}>{l.businessName}</button>
                <CopyEmail email={l.email} muted />
                {tracks[l.id]?.inbox && <span className="muted small">from {tracks[l.id]!.inbox}</span>}
                <button className="icon-btn" title="Undo" onClick={() => update(l.id, actions.unmarkSent)}>↺ Undo</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
