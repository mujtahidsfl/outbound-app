import { useEffect, useRef, useState } from 'react'
import type { Lead } from '../types'
import { relativeDue } from '../tracking'

/** Bell in the top bar that flags follow-ups due today or overdue. */
export default function Notifications({ due, now, onGoTo, onOpen }: {
  due: { lead: Lead; due: string }[]
  now: string
  onGoTo: () => void
  onOpen: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const n = due.length
  const overdue = due.filter(d => d.due < now).length
  const label = n ? `${n} follow-up${n === 1 ? '' : 's'} due` : 'No follow-ups due'
  const go = () => {
    setOpen(false)
    onGoTo()
  }

  return (
    <div className="notif" ref={ref}>
      <button
        className={n ? 'notif-btn has-due' : 'notif-btn'}
        onClick={() => setOpen(o => !o)}
        aria-label={label}
        aria-expanded={open}
        title={label}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {n > 0 && <span className="notif-count">{n > 99 ? '99+' : n}</span>}
      </button>

      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <h2>Notifications</h2>
          {n === 0 && <p className="muted">No follow-ups are due. You're all caught up.</p>}
          {n === 1 && (
            <>
              <p>
                <strong>1 follow-up is due:</strong> {due[0].lead.businessName}{' '}
                <span className="due-text">({due[0].due === now ? 'due today' : relativeDue(due[0].due, now)})</span>
              </p>
              <div className="row-wrap">
                <button className="btn btn-sm btn-primary" onClick={go}>Go to Follow-ups</button>
                <button className="btn btn-sm" onClick={() => { setOpen(false); onOpen(due[0].lead.id) }}>Open lead</button>
              </div>
            </>
          )}
          {n > 1 && (
            <>
              <p>
                <strong>{n.toLocaleString()} follow-ups are due</strong>
                {overdue > 0 && <> (<span className="due-text">{overdue.toLocaleString()} overdue</span>)</>}.
                {' '}Go to the Follow-ups tab to start following up with them.
              </p>
              <div className="row-wrap">
                <button className="btn btn-sm btn-primary" onClick={go}>Go to Follow-ups</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
