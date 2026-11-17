import { useEffect, useRef, type ReactNode } from 'react'
import { ArrowLeft, Inbox, LogOut, Settings, X } from 'lucide-react'

/** Slide-in hamburger menu: the cold email app, settings, save status and account. */
export default function Menu({ open, onClose, mainNav, inCold, settingsActive, onPick, autopilot, status, email, onSignOut }: {
  open: boolean
  onClose: () => void
  /** The current sidebar's sections, repeated here for phones where the sidebar is hidden. */
  mainNav: ReactNode
  inCold: boolean
  settingsActive: boolean
  onPick: (target: 'cold' | 'leads' | 'settings') => void
  autopilot: boolean
  status: ReactNode
  email: string
  onSignOut: () => void
}) {
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    panel.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  const pick = (target: 'cold' | 'leads' | 'settings') => {
    onPick(target)
    onClose()
  }

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="menu" ref={panel} tabIndex={-1} role="dialog" aria-label="Menu">
        <div className="menu-head">
          <span className="strong">Menu</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close menu"><X size={18} /></button>
        </div>

        <div className="menu-mobile-nav" onClick={onClose}>{mainNav}</div>

        <p className="menu-label">Apps</p>
        {inCold ? (
          <button className="nav-item" onClick={() => pick('leads')}>
            <ArrowLeft className="nav-ico" aria-hidden />
            Leads dashboard
          </button>
        ) : (
          <button className="nav-item" onClick={() => pick('cold')}>
            <Inbox className="nav-ico" aria-hidden />
            Cold email app
            <span className={autopilot ? 'nav-count on' : 'nav-count'}>{autopilot ? 'Sending on' : 'Sending off'}</span>
          </button>
        )}
        <button className={settingsActive ? 'nav-item active' : 'nav-item'} onClick={() => pick('settings')}>
          <Settings className="nav-ico" aria-hidden />
          Templates &amp; settings
        </button>

        <p className="menu-label">Status</p>
        <div className="menu-status">{status}</div>

        <p className="menu-label">Account</p>
        <div className="menu-account" title={email}>{email}</div>
        <button className="nav-item" onClick={onSignOut}>
          <LogOut className="nav-ico" aria-hidden />
          Sign out
        </button>
      </aside>
    </>
  )
}
