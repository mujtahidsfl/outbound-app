import { useState } from 'react'
import { Inbox, LayoutDashboard, Mails, Send, Users, type LucideIcon } from 'lucide-react'
import type { Shared } from '../../App'
import type { ColdData } from './data'
import ColdDashboard from './ColdDashboard'
import Campaigns from './Campaigns'
import Contacts from './Contacts'
import Mailboxes from './Mailboxes'
import MasterInbox from './inbox/MasterInbox'
import WriteEmail from './WriteEmail'

export type ColdTab = 'dashboard' | 'campaigns' | 'contacts' | 'mailboxes' | 'inbox' | 'write'

/** Sidebar of the cold email app. "Write one email" opens from the master inbox. */
export const COLD_NAV: { id: ColdTab; label: string; icon: LucideIcon }[] = [
  { id: 'dashboard', label: 'Analytics', icon: LayoutDashboard },
  { id: 'campaigns', label: 'Campaigns', icon: Send },
  { id: 'contacts', label: 'Leads', icon: Users },
  { id: 'inbox', label: 'Master inbox', icon: Inbox },
  { id: 'mailboxes', label: 'Sender accounts', icon: Mails },
]

export const COLD_PAGE: Record<ColdTab, { title: string; sub: string }> = {
  dashboard: { title: 'Analytics', sub: 'Sends, opens, replies, positive replies, bounces and Looms by campaign, inbox and date.' },
  campaigns: { title: 'Campaigns', sub: 'Each campaign is a written sequence per lead, sent on a paced schedule and tracked from first email to booked call.' },
  contacts: { title: 'Leads', sub: "Everyone who's been emailed, and where they are in the sequence." },
  mailboxes: { title: 'Sender accounts', sub: 'The email accounts campaigns send from, how and when they send, and the health of their domains.' },
  inbox: { title: 'Master inbox', sub: 'Every reply across every sender account, in one place.' },
  write: { title: 'Write one email', sub: 'A single hand-written email outside the sequence, for answering someone who replied.' },
}

export type ColdProps = Shared & {
  data: ColdData
  go: (tab: ColdTab) => void
  /** Open "Write one email", optionally as a reply to a lead. */
  compose: (leadId?: string) => void
  onTemplates: () => void
}

export default function ColdApp({ section, setSection, onTemplates, initialLead, ...props }: Shared & {
  data: ColdData
  section: ColdTab
  setSection: (t: ColdTab) => void
  onTemplates: () => void
  /** Conversation to open first, from the link in a notification email. */
  initialLead?: string | null
}) {
  const [replyTo, setReplyTo] = useState<string | undefined>()
  const p: ColdProps = {
    ...props,
    go: setSection,
    onTemplates,
    compose: leadId => { setReplyTo(leadId); setSection('write') },
  }
  switch (section) {
    case 'dashboard': return <ColdDashboard {...p} />
    case 'campaigns': return <Campaigns {...p} />
    case 'contacts': return <Contacts {...p} />
    case 'mailboxes': return <Mailboxes {...p} />
    case 'inbox': return <MasterInbox {...p} initialLead={initialLead} />
    case 'write': return <WriteEmail key={replyTo ?? 'new'} {...p} leadId={replyTo} />
  }
}

/** AromaLisa-style stat tile: big number, uppercase label, optional accent hint. */
export function Tile({ n, label, hint, tone }: { n: number | string; label: string; hint?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={tone ? `kpi kpi-${tone}` : 'kpi'}>
      <span className="kpi-value">{typeof n === 'number' ? n.toLocaleString() : n}</span>
      <span className="kpi-label">{label}</span>
      {hint && <span className="kpi-sub">{hint}</span>}
    </div>
  )
}

export const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '0%')
