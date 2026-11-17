import { useMemo, useState } from 'react'
import type { Shared } from '../App'
import type { Lead } from '../types'
import { actions, addDays, formatDate, relativeDue } from '../tracking'
import { BadDataSelect, ComposeButtons, CopyDetails, CopyEmail, InboxSelect, Pager, SendButton } from './common'

const PAGE_SIZE = 25

export default function FollowUps(props: Shared) {
  const { leads, derived, now, settings } = props

  const { overdue, today, upcoming } = useMemo(() => {
    const withDue = leads
      .map(l => ({ lead: l, due: derived.get(l.id)!.nextDue }))
      .filter((x): x is { lead: Lead; due: string } => !!x.due)
      .sort((a, b) => a.due.localeCompare(b.due))
    const weekOut = addDays(now, 7)
    return {
      overdue: withDue.filter(x => x.due < now),
      today: withDue.filter(x => x.due === now),
      upcoming: withDue.filter(x => x.due > now && x.due <= weekOut),
    }
  }, [leads, derived, now])

  const cadenceText = settings.cadence
    .map((d, i) => `#${i + 1} ${d} day${d === 1 ? '' : 's'} after the ${i === 0 ? 'first email' : `follow-up #${i}`}`)
    .join(' · ')

  return (
    <div className="stack">
      <section className="card reminder">
        <div>
          <h2>Follow-up reminders</h2>
          <p className="muted">
            {overdue.length + today.length > 0
              ? <><strong>{overdue.length + today.length}</strong> follow-ups need to go out today{overdue.length ? <> (<strong className="due-text">{overdue.length} overdue</strong>)</> : null}.</>
              : 'You\'re all caught up. Nothing due today.'}
          </p>
          <p className="muted small">Cadence: {cadenceText}. Change it under Templates &amp; settings.</p>
        </div>
        <div className="reminder-side">
          <span className="big-num">{upcoming.length}</span>
          <span className="muted small">coming up in the next 7 days</span>
        </div>
      </section>

      <Group title="Overdue" tone="bad" items={overdue} {...props} />
      <Group title="Due today" tone="warn" items={today} {...props} />
      <Group title="Next 7 days" items={upcoming} {...props} readonly />
    </div>
  )
}

function Group({ title, items, tone, readonly, tracks, settings, update, now, onOpen }: Shared & {
  title: string
  items: { lead: Lead; due: string }[]
  tone?: 'bad' | 'warn'
  readonly?: boolean
}) {
  const [page, setPage] = useState(0)
  if (!items.length) return null
  const pages = Math.ceil(items.length / PAGE_SIZE)
  const current = Math.min(page, pages - 1)
  const shown = items.slice(current * PAGE_SIZE, (current + 1) * PAGE_SIZE)
  return (
    <section className="card flush">
      <header className={`card-head pad ${tone ? `head-${tone}` : ''}`}>
        <h2>{title} <span className="muted">({items.length})</span></h2>
        {!readonly && (
          <button className="btn btn-sm" onClick={() => update(items.map(i => i.lead.id), actions.logFollowUp(now))}>
            Log all {items.length} as sent
          </button>
        )}
      </header>
      <ul className="queue">
        {shown.map(({ lead: l, due }) => {
          const t = tracks[l.id]
          const n = (t?.followUps.length ?? 0) + 1
          const last = t?.followUps.at(-1) ?? t?.sentAt
          return (
            <li key={l.id} className="queue-row">
              <div className="queue-main">
                <button className="link strong" onClick={() => onOpen(l.id)}>{l.businessName}</button>
                <span className="muted small">
                  Follow-up {n} of {settings.cadence.length} · last touch {formatDate(last)} · due {formatDate(due)}{' '}
                  <span className={due <= now ? 'due-text' : ''}>({relativeDue(due, now)})</span>
                </span>
                <CopyEmail email={l.email} />
              </div>
              <div className="queue-actions">
                <InboxSelect value={t?.inbox} inboxes={settings.inboxes} onChange={v => update(l.id, actions.setInbox(v))} />
                <CopyDetails lead={l} />
                <ComposeButtons lead={l} settings={settings} followUp compact inbox={t?.inbox} />
                <SendButton leadId={l.id} label="Send follow-up" primary />
                <button className="btn btn-sm" onClick={() => update(l.id, actions.logFollowUp(now))} title="Already sent it yourself? Log it without sending">Log sent</button>
                <button className="btn btn-sm" onClick={() => update(l.id, actions.setReplied(now))}>They replied</button>
                <BadDataSelect value={t?.badReason} onChange={v => update(l.id, actions.setBad(v))} />
              </div>
            </li>
          )
        })}
      </ul>
      {pages > 1 && <Pager page={current} pages={pages} onPage={setPage} total={items.length} pageSize={PAGE_SIZE} />}
    </section>
  )
}
