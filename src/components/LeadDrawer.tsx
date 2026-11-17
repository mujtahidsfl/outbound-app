import { useEffect, useState } from 'react'
import type { Derived, Lead, Settings, Track } from '../types'
import { EMPTY_TRACK, actions, formatDate, relativeDue, type Updater } from '../tracking'
import { BadDataSelect, ComposeButtons, CopyDetails, CopyEmail, InboxSelect, SendButton, StatusBadge } from './common'
import { MediaPanel, MediaSelect } from './Media'

export default function LeadDrawer({ lead: l, track, derived: d, settings, update, now, onClose }: {
  lead: Lead
  track?: Track
  derived: Derived
  settings: Settings
  update: Updater
  now: string
  onClose: () => void
}) {
  const t = track ?? EMPTY_TRACK
  // Notes save on blur, so typing doesn't write to the database on every keystroke.
  const [notes, setNotes] = useState(t.notes ?? '')
  useEffect(() => setNotes(track?.notes ?? ''), [l.id, track?.notes])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const setField = (patch: Partial<Track>) => update(l.id, prev => ({ ...prev, ...patch }))
  const setFollowUp = (i: number, date: string) =>
    update(l.id, prev => ({ ...prev, followUps: prev.followUps.map((f, j) => (j === i ? date : f)).sort() }))

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label={l.businessName}>
        <header className="drawer-head">
          <div>
            <h2>{l.businessName}</h2>
            <p className="muted small">{l.specificCategory} · {l.city}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </header>

        <div className="drawer-body">
          <div className="row-wrap">
            <StatusBadge status={d.status} />
            <CopyDetails lead={l} />
            {d.nextDue && <span className="small">Next follow-up {formatDate(d.nextDue)} ({relativeDue(d.nextDue, now)})</span>}
          </div>

          <section className="drawer-section">
            <h3>Pitch</h3>
            <p><span className="chip">Wave {l.wave}</span> <span className="chip">Score {l.score}</span> <span className="chip">{l.hook}</span></p>
            <p className="small">{l.pitchAngle}</p>
            {l.whatTheyDo && <p className="muted small">{l.whatTheyDo}</p>}
          </section>

          <section className="drawer-section">
            <h3>Contact</h3>
            <dl className="kv">
              <dt>Email</dt><dd><CopyEmail email={l.email} /> <span className="muted tiny">({l.emailType})</span></dd>
              <dt>Found at</dt><dd>{l.emailFoundAt.startsWith('http') ? <a href={l.emailFoundAt} target="_blank" rel="noreferrer">{shortUrl(l.emailFoundAt)}</a> : l.emailFoundAt || '—'}</dd>
              <dt>Website</dt><dd>{l.website ? <a href={l.website} target="_blank" rel="noreferrer">{shortUrl(l.website)}</a> : <span className="muted">None</span>} <span className="muted tiny">{l.websiteStatus}</span></dd>
              {l.whyOutdated && <><dt>Site issue</dt><dd>{l.whyOutdated}</dd></>}
              <dt>Address</dt><dd>{l.address || '—'}</dd>
              <dt>Google</dt><dd>{l.rating ?? '—'}★ · {l.reviews?.toLocaleString() ?? 0} reviews · {l.googleMaps && <a href={l.googleMaps} target="_blank" rel="noreferrer">Maps</a>}</dd>
              <dt>Niche</dt><dd>{l.nicheGroup} › {l.niche}</dd>
            </dl>
          </section>

          <section className="drawer-section">
            <h3>Outreach</h3>
            <div className="timeline">
              <div className="tl-row">
                <span className="tl-label">First email</span>
                {t.sentAt ? (
                  <>
                    <input type="date" className="input input-sm" value={t.sentAt} max={now} onChange={e => e.target.value && setField({ sentAt: e.target.value })} />
                    <button className="icon-btn" onClick={() => update(l.id, actions.unmarkSent)} title="Clear first email and follow-ups">↺</button>
                  </>
                ) : (
                  <>
                    <ComposeButtons lead={l} settings={settings} followUp={false} compact inbox={t.inbox} />
                    <SendButton leadId={l.id} label="Send now" primary />
                    <button className="btn btn-sm" onClick={() => update(l.id, actions.markSent(now))}>Mark sent today</button>
                  </>
                )}
              </div>
              <div className="tl-row">
                <span className="tl-label">Sent from</span>
                <InboxSelect value={t.inbox} inboxes={settings.inboxes} onChange={v => update(l.id, actions.setInbox(v))} />
              </div>
              {t.followUps.map((f, i) => (
                <div className="tl-row" key={i}>
                  <span className="tl-label">Follow-up {i + 1}</span>
                  <input type="date" className="input input-sm" value={f} max={now} onChange={e => e.target.value && setFollowUp(i, e.target.value)} />
                  {i === t.followUps.length - 1 && (
                    <button className="icon-btn" onClick={() => update(l.id, actions.undoFollowUp)} title="Remove this follow-up">↺</button>
                  )}
                </div>
              ))}
              {t.sentAt && t.followUps.length < settings.cadence.length && !t.repliedAt && (
                <div className="tl-row">
                  <span className="tl-label">Follow-up {t.followUps.length + 1}</span>
                  <ComposeButtons lead={l} settings={settings} followUp compact inbox={t.inbox} />
                  <SendButton leadId={l.id} label="Send now" primary />
                  <button className="btn btn-sm" onClick={() => update(l.id, actions.logFollowUp(now))}>Log sent today</button>
                </div>
              )}
              <div className="tl-row">
                <span className="tl-label">Replied</span>
                {t.repliedAt ? (
                  <>
                    <input type="date" className="input input-sm" value={t.repliedAt} max={now} onChange={e => e.target.value && setField({ repliedAt: e.target.value })} />
                    <button className="icon-btn" onClick={() => update(l.id, actions.setReplied(undefined))} title="Clear reply">↺</button>
                  </>
                ) : (
                  <button className="btn btn-sm" onClick={() => update(l.id, actions.setReplied(now))}>Mark replied today</button>
                )}
              </div>
              <div className="tl-row">
                <span className="tl-label">Bad data</span>
                <BadDataSelect value={t.badReason} onChange={v => update(l.id, actions.setBad(v))} />
              </div>
            </div>
          </section>

          <section className="drawer-section">
            <h3>Media</h3>
            <div className="row-wrap">
              <MediaSelect done={!!t.mediaDone} onChange={v => update(l.id, actions.setMediaDone(v))} />
              {!t.mediaDone && <span className="muted small">Set to Done to attach the files.</span>}
            </div>
            {t.mediaDone && <MediaPanel key={l.id} leadId={l.id} media={t.media} update={update} />}
          </section>

          <section className="drawer-section">
            <h3>Notes</h3>
            <textarea
              className="input textarea"
              rows={4}
              placeholder="Anything worth remembering: who replied, what they said, next step…"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              onBlur={() => notes !== (t.notes ?? '') && setField({ notes: notes || undefined })}
            />
          </section>
        </div>
      </aside>
    </div>
  )
}

function shortUrl(u: string) {
  return u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').slice(0, 48)
}
