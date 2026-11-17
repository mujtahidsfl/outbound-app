import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, LayoutDashboard, Menu as MenuIcon, Repeat, Send, Users, type LucideIcon } from 'lucide-react'
import type { Derived, Lead } from './types'
import type { SyncState } from './tracking'
import type { Session } from '@supabase/supabase-js'
import { derive, footerReady, today, useTracking } from './tracking'
import { arrivedToSetPassword, configured, fetchLeads, supabase } from './supabase'
import Login, { SetPassword } from './components/Login'
import Overview from './components/Overview'
import LeadsTable from './components/LeadsTable'
import FollowUps from './components/FollowUps'
import SendQueue from './components/SendQueue'
import SettingsPanel from './components/SettingsPanel'
import LeadDrawer from './components/LeadDrawer'
import Notifications from './components/Notifications'
import ColdApp, { COLD_NAV, COLD_PAGE, type ColdTab } from './components/cold/ColdApp'
import { SendingToggle } from './components/cold/ColdSettings'
import { useColdData } from './components/cold/data'
import { AlertsBell, useAlerts } from './components/cold/Alerts'
import { useCampaigns, type CampaignState } from './campaigns'
import Clock from './components/Clock'
import Menu from './components/Menu'

type Tab = 'overview' | 'leads' | 'queue' | 'followups' | 'settings'

const PAGE: Record<Tab, { title: string; sub: string }> = {
  overview: { title: 'Dashboard', sub: "Today's target, sends and replies across every lead." },
  leads: { title: 'All leads', sub: 'Search, filter and update every lead.' },
  queue: { title: 'First emails', sub: "Today's first emails, in priority order." },
  followups: { title: 'Follow-ups', sub: 'Overdue, due today and the next 7 days.' },
  settings: { title: 'Templates & settings', sub: 'Follow-up timing, targets, inboxes, sending and email templates.' },
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [recovering, setRecovering] = useState(arrivedToSetPassword)

  useEffect(() => {
    if (!configured) return
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  if (!configured) {
    return (
      <div className="center-msg">
        Missing Supabase config. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).
      </div>
    )
  }
  if (session === undefined) return <div className="center-msg">Loading…</div>
  if (!session) return <Login />
  if (recovering) return <SetPassword onDone={() => setRecovering(false)} />
  return <Dashboard email={session.user.email ?? ''} />
}

function Dashboard({ email }: { email: string }) {
  const [leads, setLeads] = useState<Lead[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('overview')
  const [openId, setOpenId] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The cold email app is its own section and the landing page; null = the leads dashboard.
  // Back from "Add inbox", Google lands on Mailboxes, where the result shows.
  // A notification email links straight to a conversation.
  const [initialLead] = useState(() => new URLSearchParams(location.search).get('lead'))
  const [cold, setCold] = useState<ColdTab | null>(location.hash.startsWith('#google=') ? 'mailboxes' : initialLead ? 'inbox' : 'dashboard')
  const coldData = useColdData(cold !== null)
  const alerts = useAlerts(true)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  const [now, setNow] = useState(today)
  const tracking = useTracking(true)
  const { tracks, settings } = tracking
  const campaigns = useCampaigns()

  useEffect(() => {
    fetchLeads()
      // No leads yet is fine: the cold email app still opens, and leads can be loaded later.
      .then(setLeads)
      .catch(e => setError(String(e.message ?? e)))
  }, [])

  // Roll the date over if the tab is left open past midnight.
  useEffect(() => {
    const id = setInterval(() => setNow(today()), 60_000)
    return () => clearInterval(id)
  }, [])

  const derived = useMemo(() => {
    const m = new Map<string, Derived>()
    // Campaign leads follow their campaign's timing; everyone else the default cadence.
    const cadence = new Map(campaigns.campaigns.map(c => [c.id, c.cadence]))
    for (const l of leads ?? []) {
      const c = campaigns.members.get(l.id)
      m.set(l.id, derive(tracks[l.id], (c && cadence.get(c.campaignId)) || settings.cadence, now))
    }
    return m
  }, [leads, tracks, settings.cadence, now, campaigns.campaigns, campaigns.members])

  const counts = useMemo(() => {
    const c = { new: 0, awaiting: 0, due: 0, replied: 0, done: 0, bad: 0 }
    for (const d of derived.values()) c[d.status]++
    return c
  }, [derived])

  // Follow-ups due today or overdue, oldest first.
  const dueFollowUps = useMemo(
    () => (leads ?? [])
      .flatMap(l => {
        const d = derived.get(l.id)!
        return d.status === 'due' ? [{ lead: l, due: d.nextDue! }] : []
      })
      .sort((a, b) => a.due.localeCompare(b.due)),
    [leads, derived],
  )

  if (error) return <div className="center-msg">Could not load leads: {error}</div>
  if (!leads) return <div className="center-msg">Loading leads…</div>

  const byId = new Map(leads.map(l => [l.id, l]))
  const openLead = openId ? byId.get(openId) : undefined

  const sections: { id: Tab; label: string; icon: LucideIcon; count?: number; alert?: boolean }[] = [
    { id: 'overview', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'leads', label: 'All leads', icon: Users, count: leads.length },
    { id: 'queue', label: 'First emails', icon: Send, count: counts.new },
    { id: 'followups', label: 'Follow-ups', icon: Repeat, count: counts.due, alert: counts.due > 0 },
  ]
  const go = (t: Tab) => { setCold(null); setTab(t) }
  const navItem = (key: string, label: string, Icon: LucideIcon, active: boolean, onClick: () => void, count?: number, alert?: boolean) => (
    <button key={key} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined} onClick={onClick}>
      <Icon className="nav-ico" aria-hidden />
      {label}
      {count !== undefined && <span className={alert ? 'nav-count alert' : 'nav-count'}>{count.toLocaleString()}</span>}
    </button>
  )
  const mainNav = cold
    ? <nav className="nav" aria-label="Cold email">{COLD_NAV.map(n => navItem(n.id, n.label, n.icon, cold === n.id, () => setCold(n.id), n.id === 'inbox' && coldData.unread ? coldData.unread : undefined, true))}</nav>
    : <nav className="nav" aria-label="Sections">{sections.map(n => navItem(n.id, n.label, n.icon, tab === n.id, () => go(n.id), n.count, n.alert))}</nav>
  const page = cold ? COLD_PAGE[cold] : PAGE[tab]
  const live = !!coldData.status?.ok && settings.inboxes.every(i => coldData.status?.passwords[i]) && footerReady(settings)

  const shared = { leads, derived, tracks, settings, setSettings: tracking.setSettings, update: tracking.update, now, onOpen: setOpenId, campaigns }

  return (
    <div className="wrap">
      <aside className="side">
        <Brand sub={cold ? 'Cold email' : 'Outbound'} />
        {mainNav}
        {cold
          ? <button className="nav-item side-back" onClick={() => setCold(null)}><ArrowLeft className="nav-ico" aria-hidden />Leads dashboard</button>
          : <p className="side-foot">{leads.length.toLocaleString()} leads</p>}
      </aside>

      <div className="main">
      <header className="topbar">
        <div className="topbar-left">
          <span className="top-brand"><Brand /></span>
          {cold && (coldData.status
            ? <span className={live ? 'badge badge-replied live-badge' : 'badge badge-due live-badge'} title={live ? 'Server, inboxes and footer are set up' : 'Finish the go-live checklist on Sender accounts'}>{live ? 'LIVE' : 'SETUP NEEDED'}</span>
            : <span className="badge badge-new live-badge">…</span>)}
          <Clock />
        </div>
        <div className="topbar-right">
          {cold && <SendingToggle settings={settings} setSettings={tracking.setSettings} />}
          <AlertsBell state={alerts} onGoTo={cold === 'mailboxes' ? undefined : () => setCold('mailboxes')} />
          {cold && <button className="btn btn-sm logout-btn" onClick={() => supabase.auth.signOut()}>Log out</button>}
          {!cold && <Notifications due={dueFollowUps} now={now} onGoTo={() => go('followups')} onOpen={setOpenId} />}
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open menu" aria-expanded={menuOpen}>
            <MenuIcon size={20} aria-hidden />
          </button>
        </div>
      </header>
      {tracking.sync.state === 'error' && <div className="error-banner">{tracking.sync.error}</div>}

      <main className="content">
        <div className="page-head">
          <h1>{page.title}</h1>
          {!cold && <p className="sub">{page.sub}</p>}
        </div>
        {cold && <ColdApp {...shared} data={{ ...coldData, alerts }} section={cold} setSection={setCold} onTemplates={() => go('settings')} initialLead={initialLead} />}
        {!cold && tab === 'overview' && <Overview {...shared} counts={counts} goTo={go} />}
        {!cold && tab === 'leads' && <LeadsTable {...shared} />}
        {!cold && tab === 'queue' && <SendQueue {...shared} />}
        {!cold && tab === 'followups' && <FollowUps {...shared} />}
        {!cold && tab === 'settings' && (
          <SettingsPanel
            leads={leads}
            tracks={tracks}
            derived={derived}
            settings={settings}
            setSettings={tracking.setSettings}
            replaceAll={tracking.replaceAll}
          />
        )}
      </main>
      </div>

      <Menu
        open={menuOpen}
        onClose={closeMenu}
        mainNav={mainNav}
        inCold={cold !== null}
        settingsActive={!cold && tab === 'settings'}
        onPick={t => (t === 'cold' ? setCold('dashboard') : t === 'leads' ? setCold(null) : go('settings'))}
        autopilot={settings.autopilot}
        status={<SyncBadge sync={tracking.sync} />}
        email={email}
        onSignOut={() => supabase.auth.signOut()}
      />

      {openLead && (
        <LeadDrawer
          lead={openLead}
          track={tracks[openLead.id]}
          derived={derived.get(openLead.id)!}
          settings={settings}
          update={tracking.update}
          now={now}
          onClose={() => setOpenId(null)}
        />
      )}
    </div>
  )
}

function Brand({ sub = 'Outbound' }: { sub?: string }) {
  return (
    <div className="brand">
      <img className="brand-logo" src="/logo.png" alt="" />
      <div>
        <div className="brand-name">Outbound</div>
        <small>{sub}</small>
      </div>
    </div>
  )
}

function SyncBadge({ sync }: { sync: SyncState }) {
  const label = { loading: 'Syncing…', saving: 'Saving…', saved: 'All changes saved', error: 'Not saved' }[sync.state]
  return <span className={`sync sync-${sync.state}`} title={sync.error ?? label}><i aria-hidden />{label}</span>
}

export type Shared = {
  leads: Lead[]
  derived: Map<string, Derived>
  tracks: ReturnType<typeof useTracking>['tracks']
  settings: ReturnType<typeof useTracking>['settings']
  setSettings: ReturnType<typeof useTracking>['setSettings']
  update: ReturnType<typeof useTracking>['update']
  now: string
  onOpen: (id: string) => void
  campaigns: CampaignState
}
