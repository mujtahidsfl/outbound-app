import { useMemo, useState } from 'react'
import { ChevronLeft } from 'lucide-react'
import { useCampaignActivity } from '../../../campaigns'
import { addDays, campaignEligible, dailyCapacity, derive, formatDate, inboxTotal, isWritten, sentByInbox } from '../../../tracking'
import type { Campaign, CampaignConfig } from '../../../types'
import type { ColdProps } from '../ColdApp'
import { CampaignStatus } from '../Campaigns'
import Analytics from './Analytics'
import OfferSplit from './OfferSplit'
import CampaignLeads from './CampaignLeads'
import CampaignOptions from './CampaignOptions'
import EmailAccounts from './EmailAccounts'
import LeadUpload from './LeadUpload'
import Screenshots from './Screenshots'
import Sequence from './Sequence'
import Subsequences from './Subsequences'
import WrittenSequence from './WrittenSequence'
import { buildRows, daily, pctText, stepStats, totals } from './stats'
import { StackedBars, emailLabel } from './ui'

type Tab = 'overview' | 'leads' | 'sequence' | 'accounts' | 'subsequences' | 'screenshots' | 'insights' | 'settings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'leads', label: 'Lead list' },
  { id: 'sequence', label: 'Sequence' },
  { id: 'accounts', label: 'Email accounts' },
  { id: 'subsequences', label: 'Subsequences' },
  { id: 'screenshots', label: 'Screenshots' },
  { id: 'insights', label: 'Insights' },
  { id: 'settings', label: 'Settings' },
]
const STEP_CLS = ['fill-s1', 'fill-s2', 'fill-s3', 'fill-s4']

export type CampaignProps = ColdProps & {
  campaign: Campaign
  activity: ReturnType<typeof useCampaignActivity>
  actions: ReturnType<typeof useCampaignActions>
}

/** Pause/activate, follow-up pause and start date, shared by the header, the overview notice and Settings. */
function useCampaignActions(props: ColdProps & { campaign: Campaign; onScreenshots: () => void }) {
  const { campaign: c, campaigns, tracks, now, onScreenshots } = props
  const [msg, setMsg] = useState<string>()
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const waiting = useMemo(() => members.filter(m => derive(tracks[m.leadId], c.cadence, now).status === 'due').length, [members, tracks, c.cadence, now])
  const needImages = c.steps.filter(s => s.attachImages).map(s => s.n)
  const started = !c.startDate || c.startDate <= now
  const save = async (patch: Partial<Campaign>) => setMsg(await campaigns.update(c.id, patch))
  const saveConfig = async (patch: Partial<CampaignConfig>) => {
    const error = await campaigns.update(c.id, { config: { ...c.config, ...patch } })
    setMsg(error)
    return error
  }
  const activate = (on: boolean) => {
    if (on && isWritten(c)) {
      const first = c.config.sequence?.[0]?.variants[0]
      if (!members.length) return setMsg('Add leads to the lead list first.')
      if (!first?.subject.trim() || !first.body.trim()) return setMsg('Write Email 1 in the Sequence tab first.')
    }
    if (on && !confirm(`Activate "${c.name}"? Autopilot sends its emails during the send window${c.startDate && !started ? `, starting ${formatDate(c.startDate)}` : ''}.`)) return
    // Coming back from a protection pause: bounces count from now, or it would pause again on the next pass.
    const cfg = c.config
    const fresh = on && cfg.pausedReason ? { config: { ...cfg, pausedReason: undefined, bounceProtection: cfg.bounceProtection && { ...cfg.bounceProtection, since: new Date().toISOString() } } } : {}
    save({ status: on ? 'active' : 'paused', ...fresh })
  }
  const resume = () => {
    if (needImages.length && !c.images.length) {
      setMsg(`Email ${needImages.join(' & ')} says "I've attached a few screenshots". Upload them first.`)
      onScreenshots()
      return
    }
    if (!confirm(`Resume follow-ups? ${waiting ? `${waiting} follow-up${waiting === 1 ? ' is' : 's are'} already due and go out first, ` : ''}each inbox still keeps to its daily cap.`)) return
    save({ followUpsPaused: false })
  }
  return { msg, members, waiting, needImages, started, save, saveConfig, activate, resume }
}

export default function CampaignView(props: ColdProps & { campaign: Campaign; onBack: () => void }) {
  const { campaign: c, campaigns, onBack } = props
  const written = isWritten(c)
  // A new campaign opens on its lead list, the first thing it needs.
  const [tab, setTab] = useState<Tab>(() => (written && ![...campaigns.members.values()].some(m => m.campaignId === c.id) ? 'leads' : 'overview'))
  const activity = useCampaignActivity(c.id)
  const actions = useCampaignActions({ ...props, onScreenshots: () => setTab('screenshots') })
  const p: CampaignProps = { ...props, activity, actions }
  return (
    <div className="stack">
      <header className="camp-head">
        <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> All campaigns</button>
        <div className="camp-title">
          <div>
            <h2>{c.name}</h2>
            <p className="small muted">{actions.members.length.toLocaleString()} leads · {c.steps.length} email{c.steps.length === 1 ? '' : 's'} on day {c.steps.map(s => s.day).join(', ')}{c.config.folder ? ` · ${c.config.folder}` : ''}</p>
          </div>
          <span className="row-wrap">
            <CampaignStatus c={c} />
            {c.status === 'active'
              ? <button className="btn btn-sm" onClick={() => actions.activate(false)}>Pause campaign</button>
              : <button className="btn btn-sm btn-primary" onClick={() => actions.activate(true)}>Activate</button>}
          </span>
        </div>
        <nav className="tabs" aria-label="Campaign">
          {TABS.filter(t => t.id !== 'screenshots' || !written).map(t => (
            <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} aria-current={tab === t.id ? 'page' : undefined} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'screenshots' && <span className="tab-count">{c.images.length}</span>}
            </button>
          ))}
        </nav>
      </header>
      {actions.msg && <p className="small error-text">{actions.msg}</p>}
      {activity.error && <p className="small error-text">Couldn't load activity: {activity.error}</p>}
      {tab === 'overview' && <Overview {...p} go={() => setTab('settings')} />}
      {tab === 'sequence' && (written ? <WrittenSequence key={c.id} {...p} /> : <Sequence {...p} />)}
      {tab === 'accounts' && <EmailAccounts {...p} />}
      {tab === 'subsequences' && <Subsequences {...p} />}
      {tab === 'screenshots' && <Screenshots {...p} />}
      {tab === 'insights' && <Analytics {...p} />}
      {tab === 'leads' && <>{written && <LeadUpload {...p} />}<CampaignLeads {...p} /></>}
      {tab === 'settings' && <CampaignOptions key={c.id} {...p} onScreenshots={() => setTab('screenshots')} onDeleted={onBack} />}
    </div>
  )
}

function Overview({ campaign: c, campaigns, tracks, settings, now, activity, actions: a, go }: CampaignProps & { go: () => void }) {
  const members = useMemo(() => [...campaigns.members.values()].filter(m => m.campaignId === c.id), [campaigns.members, c.id])
  const rows = useMemo(() => buildRows(members, tracks, activity.messages, activity.events), [members, tracks, activity.messages, activity.events])
  const t = totals(rows)
  const steps = stepStats(rows, c.steps.length)

  const counts = useMemo(() => {
    let ready = 0, check = 0, dns = 0, approved = 0, eligibleLeft = 0
    for (const m of members) {
      if (m.sendStatus === 'READY') ready++
      else if (m.sendStatus === 'CHECK FIRST') { check++; if (m.approved) approved++ }
      else dns++
      const tr = tracks[m.leadId]
      if (campaignEligible(m, c) && !tr?.sentAt && !tr?.badReason) eligibleLeft++
    }
    return { ready, check, dns, approved, eligibleLeft }
  }, [members, tracks, c])

  const memberIds = useMemo(() => new Set(members.map(m => m.leadId)), [members])
  const today = useMemo(() => {
    const sub = Object.fromEntries(Object.entries(tracks).filter(([id]) => memberIds.has(id)))
    return Object.values(sentByInbox(sub, now)).reduce((s, x) => s + inboxTotal(x), 0)
  }, [tracks, memberIds, now])
  const capacity = dailyCapacity(settings, now)
  const daysLeft = Math.ceil(counts.eligibleLeft / Math.max(1, capacity))

  const days = useMemo(() => {
    const list = daily(rows, c.steps.length)
    // At least the last week, never past today.
    const start = list[0]?.date && list[0].date < addDays(now, -6) ? list[0].date : addDays(now, -6)
    const out: typeof list = []
    for (let d = start; d <= now; d = addDays(d, 1)) out.push(list.find(x => x.date === d) ?? { date: d, sent: new Array(c.steps.length).fill(0), replies: 0 })
    return out.slice(-21)
  }, [rows, c.steps.length, now])

  const notice = c.config.pausedReason && c.status !== 'active'
    ? { text: `Paused by reputation protection. ${c.config.pausedReason}`, action: <button className="btn btn-sm btn-primary" onClick={() => a.activate(true)}>Activate</button> }
    : c.followUpsPaused
    ? { text: `Follow-ups are paused, so only Email 1 is sending.${a.waiting ? ` ${a.waiting} follow-up${a.waiting === 1 ? ' is' : 's are'} waiting.` : ''}`, action: <button className="btn btn-sm btn-primary" onClick={a.resume}>Resume follow-ups</button> }
    : c.status !== 'active' ? { text: 'This campaign is paused. Nothing sends.', action: <button className="btn btn-sm btn-primary" onClick={() => a.activate(true)}>Activate</button> } : null

  return (
    <>
      {notice && (
        <div className="notice">
          <span>{notice.text}</span>
          <span className="row-wrap">{notice.action}<button className="link-accent small" onClick={go}>Settings</button></span>
        </div>
      )}

      <div className="stat-row stat-row-5">
        <Stat label="Contacted" value={t.leads.toLocaleString()} sub={`of ${members.length.toLocaleString()} leads · ${t.emails.toLocaleString()} emails`} />
        <Stat label="Open rate" value={pctText(t.opened, t.tracked)} sub={!t.tracked ? 'Open tracking is off. None of these emails were tracked' : t.tracked < t.leads ? `${t.opened} of ${t.tracked} tracked leads opened` : `${t.opened} of ${t.tracked} opened`} />
        <Stat label="Reply rate" value={pctText(t.replies, t.leads)} sub={`${t.replies} repl${t.replies === 1 ? 'y' : 'ies'}`} />
        <Stat label="Positive replies" value={t.positive.toLocaleString()} sub={`${t.loom} want the Loom · ${t.booked} booked`} />
        <Stat label="Bounce rate" value={pctText(t.bounced, t.leads)} sub={`${t.bounced} bounced`} />
      </div>

      <OfferSplit members={members} rows={rows} />

      <div className="dash-grid">
        <section className="card">
          <header className="list-head">
            <h2>Sends per day</h2>
            <div className="legend">
              {c.steps.map((s, i) => <span key={s.n}><i className={`swatch s${i + 1}`} />Email {s.n}</span>)}
            </div>
          </header>
          <StackedBars
            labels={days.map(d => (d.date === now ? 'Today' : formatDate(d.date)))}
            series={c.steps.map((s, i) => ({ name: `Email ${s.n}`, cls: STEP_CLS[i % 4], values: days.map(d => d.sent[i]) }))}
            height={220}
            empty="Nothing sent yet. Email 1 starts going out on the start date."
          />
        </section>

        <section className="card">
          <header className="list-head"><h2>Progress</h2></header>
          <div className="progress-big">
            <span className="meter"><span style={{ width: `${(100 * t.leads) / Math.max(1, t.leads + counts.eligibleLeft)}%` }} /></span>
            <span className="small muted">{t.leads.toLocaleString()} started · {counts.eligibleLeft.toLocaleString()} to go</span>
          </div>
          <dl className="kv-list">
            <div><dt>Sent today</dt><dd>{today} <span className="muted">/ {capacity}</span></dd></div>
            <div><dt>Left to start</dt><dd>{counts.eligibleLeft.toLocaleString()} <span className="muted">≈ {daysLeft} day{daysLeft === 1 ? '' : 's'}</span></dd></div>
            <div><dt>Follow-ups waiting</dt><dd>{a.waiting}</dd></div>
            <div><dt>Ready to send</dt><dd>{counts.ready.toLocaleString()}</dd></div>
            <div><dt>Need approval first</dt><dd>{counts.check.toLocaleString()} <span className="muted">· {counts.approved} approved</span></dd></div>
            <div><dt>Do not send</dt><dd>{counts.dns.toLocaleString()}</dd></div>
            <div><dt>Calls booked · won</dt><dd>{t.booked} · {t.won}{t.revenue ? <span className="muted"> · ${t.revenue.toLocaleString()}</span> : null}</dd></div>
            <div><dt>Said no / opted out</dt><dd>{t.optedOut}</dd></div>
          </dl>
        </section>
      </div>

      <section className="card flush">
        <header className="card-head pad"><h2>Each email</h2><span className="small muted">More breakdowns under Insights</span></header>
        <div className="table-scroll"><table className="table compact">
          <thead><tr>
            <th>Email</th><th>When</th><th className="num">Sent</th><th className="num">Open rate</th><th className="num">Replies</th><th className="num">Reply rate</th>
            <th className="num">Positive</th><th className="num">Bounced</th>
          </tr></thead>
          <tbody>
            {steps.map(s => {
              const def = c.steps[s.step]
              return (
                <tr key={s.step}>
                  <td className="strong nowrap">{emailLabel(s.step)}{def?.attachImages && <span className="chip">screenshots</span>}</td>
                  <td className="small muted">Day {def?.day} · {def?.thread === 'reply' ? `reply to Email ${def.replyTo}` : 'new thread'}{s.step > 0 && c.followUpsPaused ? ' · paused' : ''}</td>
                  <td className="num">{s.sent.toLocaleString()}</td>
                  <td className="num" title={s.tracked ? `${s.opened} of ${s.tracked} sent with open tracking` : undefined}>{pctText(s.opened, s.tracked)}</td>
                  <td className="num">{s.replies}</td>
                  <td className="num strong">{pctText(s.replies, s.sent)}</td>
                  <td className="num">{s.positive}</td>
                  <td className="num">{s.bounces}</td>
                </tr>
              )
            })}
          </tbody>
        </table></div>
      </section>
    </>
  )
}

function Stat({ label, value, sub, bad }: { label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <section className="stat">
      <span className="stat-label">{label}</span>
      <div className={bad ? 'stat-value bad-text' : 'stat-value'}>{value}</div>
      <div className="stat-sub">{sub}</div>
    </section>
  )
}
